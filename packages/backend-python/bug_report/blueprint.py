"""Flask blueprint implementing the bug-report API spec.

Mount with ``app.register_blueprint(create_blueprint(store=...), url_prefix='/api')``.
"""

from __future__ import annotations

import base64
import io
import time
from typing import Callable

from flask import Blueprint, abort, jsonify, request, send_file

from .models import (
    BUG_DETAILS_MAX,
    BUG_SCREENSHOT_MAX,
    BUG_STATUSES,
    new_bug_id,
    screenshot_content_type,
    valid_bug_id,
)
from .store import (
    AuditEntry,
    BugRecord,
    NotFound,
    Store,
)


_last_now_ns = 0


def _now_iso() -> str:
    """ISO-8601 UTC with microsecond precision, monotonically increasing
    within the process. Microseconds matter for sort stability when many
    reports land in the same second (test loops, agent bursts); the
    monotonic guard ensures even faster-than-clock-resolution bursts get
    distinct timestamps."""
    global _last_now_ns
    ns = time.time_ns()
    if ns <= _last_now_ns:
        ns = _last_now_ns + 1000  # bump by 1µs
    _last_now_ns = ns
    s, us = divmod(ns, 1_000_000_000)
    us //= 1000
    return f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(s))}.{us:06d}Z"


def _since_iso(days: int) -> str:
    return time.strftime(
        "%Y-%m-%dT%H:%M:%S.000000Z",
        time.gmtime(time.time() - days * 86400),
    )


def create_blueprint(
    *,
    store: Store,
    is_admin: Callable | None = None,
    default_actor_email: str = "",
    build_sha: str | Callable[[], str] = "",
    url_prefix: str = "/bugs",
) -> Blueprint:
    """Build a Flask blueprint that serves the bug-report API.

    Args:
        store: An object implementing the ``Store`` protocol.
        is_admin: ``(request) -> bool`` gate for ``GET /bugs`` and ``PATCH``.
                  Default: allow everything (suitable for single-user apps).
        default_actor_email: Email stamped on reports filed without one.
        build_sha: String or zero-arg callable returning the current build SHA.
                   Stamped on each report. Empty string means "unknown".
        url_prefix: Mount path within the blueprint. Outer app typically
                    mounts the whole blueprint under ``/api``.
    """
    if is_admin is None:
        is_admin = lambda req: True  # noqa: E731 — single-user default

    bp = Blueprint("bug_report", __name__)

    def _resolve_build_sha() -> str:
        if callable(build_sha):
            try:
                return build_sha() or ""
            except Exception:
                return ""
        return build_sha or ""

    # ----- POST /bugs ---------------------------------------------------

    @bp.route(url_prefix, methods=["POST"])
    def api_create():
        if request.is_json:
            payload = request.get_json(silent=True) or {}
        else:
            payload = {k: v for k, v in request.form.items()}

        details = (payload.get("details") or "").strip()
        if not details:
            return jsonify({"error": "details is required"}), 400
        if len(details.encode("utf-8")) > BUG_DETAILS_MAX:
            return jsonify({"error": f"details exceeds {BUG_DETAILS_MAX} bytes"}), 413

        title = (payload.get("title") or details.splitlines()[0])[:100].strip()
        added_by = (payload.get("addedBy") or payload.get("added_by") or "web").strip()[:32] or "web"
        actor_email = (
            payload.get("actorEmail") or payload.get("actor_email") or default_actor_email
        ).strip()[:200]

        tags = payload.get("tags") or ["bug"]
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        if not isinstance(tags, list):
            tags = ["bug"]
        if added_by == "agent" and "agent-self-report" not in tags:
            tags.append("agent-self-report")

        shot_bytes: bytes | None = None
        raw = payload.get("screenshot")
        if raw and isinstance(raw, str):
            if raw.startswith("data:"):
                raw = raw.split(",", 1)[1] if "," in raw else ""
            try:
                shot_bytes = base64.b64decode(raw, validate=False) if raw else None
            except Exception:
                shot_bytes = None
            if shot_bytes and len(shot_bytes) > BUG_SCREENSHOT_MAX:
                return jsonify({"error": f"screenshot exceeds {BUG_SCREENSHOT_MAX} bytes"}), 413
            if shot_bytes is not None and not shot_bytes:
                shot_bytes = None

        transcript = payload.get("transcript")
        if transcript is not None and not isinstance(transcript, list):
            transcript = None

        bug = BugRecord(
            id=new_bug_id(),
            title=title,
            details=details,
            tags=tags,
            status="open",
            added_by=added_by,
            actor_email=actor_email,
            added_at=_now_iso(),
            meta_url=(payload.get("metaUrl") or payload.get("meta_url") or "")[:500],
            meta_user_agent=(payload.get("metaUserAgent") or payload.get("meta_user_agent") or "")[:300],
            meta_build_sha=(payload.get("metaBuildSha") or payload.get("meta_build_sha") or _resolve_build_sha())[:40],
            transcript=transcript,
        )
        store.put_bug(bug, shot_bytes)
        store.append_audit(bug.id, AuditEntry(
            changed_at=_now_iso(),
            to_status="open",
            from_status=None,
            changed_by=actor_email or added_by,
            note="filed",
        ))
        return jsonify({"id": bug.id}), 201

    # ----- GET /bugs ----------------------------------------------------

    @bp.route(url_prefix, methods=["GET"])
    def api_list():
        if not is_admin(request):
            abort(403)
        status_filter = (request.args.get("status") or "").strip() or None
        if status_filter and status_filter not in BUG_STATUSES:
            return jsonify({"error": f"status must be one of {BUG_STATUSES}"}), 400
        try:
            days = max(1, min(365, int(request.args.get("days") or 30)))
        except ValueError:
            return jsonify({"error": "days must be an integer"}), 400
        rows = [b.to_summary() for b in store.list_bugs(status=status_filter, since_iso=_since_iso(days))]
        rows.sort(key=lambda r: r["addedAt"], reverse=True)
        return jsonify({"bugs": rows})

    # ----- GET /bugs/<id> ----------------------------------------------

    @bp.route(f"{url_prefix}/<bug_id>", methods=["GET"])
    def api_get(bug_id: str):
        if not valid_bug_id(bug_id):
            return jsonify({"error": "invalid id"}), 400
        try:
            bug = store.get_bug(bug_id)
        except NotFound:
            return jsonify({"error": "not found"}), 404
        full = bug.to_full()
        full["audit"] = [a.to_dict() for a in store.list_audit(bug_id)]
        return jsonify(full)

    # ----- PATCH /bugs/<id> --------------------------------------------

    @bp.route(f"{url_prefix}/<bug_id>", methods=["PATCH"])
    def api_patch(bug_id: str):
        if not is_admin(request):
            abort(403)
        if not valid_bug_id(bug_id):
            return jsonify({"error": "invalid id"}), 400
        try:
            bug = store.get_bug(bug_id)
        except NotFound:
            return jsonify({"error": "not found"}), 404

        payload = request.get_json(silent=True) or {}
        new_status = (payload.get("status") or "").strip()
        if new_status not in BUG_STATUSES:
            return jsonify({"error": f"status must be one of {BUG_STATUSES}"}), 400
        note = (payload.get("note") or "")[:500]
        changed_by = (
            payload.get("changedBy") or payload.get("changed_by") or default_actor_email or "admin"
        )[:200]

        old_status = bug.status
        if new_status == old_status:
            # No-op: don't write a meaningless audit row.
            full = bug.to_full()
            full["audit"] = [a.to_dict() for a in store.list_audit(bug_id)]
            return jsonify(full)

        bug = store.update_status(bug_id, new_status)
        store.append_audit(bug_id, AuditEntry(
            changed_at=_now_iso(),
            to_status=new_status,
            from_status=old_status,
            changed_by=changed_by,
            note=note,
        ))
        full = bug.to_full()
        full["audit"] = [a.to_dict() for a in store.list_audit(bug_id)]
        return jsonify(full)

    # ----- GET /bugs/<id>/screenshot -----------------------------------

    @bp.route(f"{url_prefix}/<bug_id>/screenshot", methods=["GET"])
    def api_screenshot(bug_id: str):
        if not valid_bug_id(bug_id):
            abort(400)
        try:
            data = store.get_screenshot(bug_id)
        except NotFound:
            abort(404)
        return send_file(io.BytesIO(data), mimetype=screenshot_content_type(data))

    return bp
