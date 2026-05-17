"""Storage interface + reference implementations.

The blueprint depends only on ``Store``. Apps that want a different backend
(SQLite, Postgres, S3, …) implement the protocol and pass an instance in.

Two implementations ship out of the box:
- ``InMemoryStore``  — for tests and dev. State is process-local.
- ``FilesystemStore`` — one JSON file per bug + one screenshot PNG.
                        Adequate for single-host apps (this is what the
                        claude-tmux-dashboard uses in production).
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Protocol


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class StoreError(Exception):
    """Base for store errors."""


class NotFound(StoreError):
    """Bug or screenshot does not exist."""


# ---------------------------------------------------------------------------
# Record + audit shapes
# ---------------------------------------------------------------------------

@dataclass
class BugRecord:
    id: str
    title: str
    details: str
    tags: list[str]
    status: str
    added_by: str
    actor_email: str
    added_at: str
    meta_url: str = ""
    meta_user_agent: str = ""
    meta_build_sha: str = ""
    screenshot: bool = False
    transcript: list[dict] | None = None

    def to_summary(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "tags": list(self.tags),
            "status": self.status,
            "addedBy": self.added_by,
            "actorEmail": self.actor_email,
            "addedAt": self.added_at,
            "screenshot": bool(self.screenshot),
        }

    def to_full(self) -> dict:
        d = self.to_summary()
        d.update({
            "details": self.details,
            "metaUrl": self.meta_url,
            "metaUserAgent": self.meta_user_agent,
            "metaBuildSha": self.meta_build_sha,
            "transcript": self.transcript,
        })
        return d


@dataclass
class AuditEntry:
    changed_at: str
    to_status: str
    from_status: str | None = None
    changed_by: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "changedAt": self.changed_at,
            "changedBy": self.changed_by,
            "fromStatus": self.from_status,
            "toStatus": self.to_status,
            "note": self.note,
        }


# ---------------------------------------------------------------------------
# Store protocol
# ---------------------------------------------------------------------------

class Store(Protocol):
    """Abstract storage. Implementations must be thread-safe enough for
    a single Flask worker; cross-process concurrency is each impl's call."""

    def put_bug(self, bug: BugRecord, screenshot_png: bytes | None) -> None: ...
    def get_bug(self, bug_id: str) -> BugRecord: ...
    def list_bugs(self, *, status: str | None, since_iso: str) -> Iterable[BugRecord]: ...
    def update_status(self, bug_id: str, new_status: str) -> BugRecord: ...
    def append_audit(self, bug_id: str, entry: AuditEntry) -> None: ...
    def list_audit(self, bug_id: str) -> list[AuditEntry]: ...
    def get_screenshot(self, bug_id: str) -> bytes: ...


# ---------------------------------------------------------------------------
# InMemoryStore — for tests
# ---------------------------------------------------------------------------

class InMemoryStore:
    """Dict-backed store. Lost on process exit. Useful for tests + dev."""

    def __init__(self) -> None:
        self._bugs: dict[str, BugRecord] = {}
        self._audits: dict[str, list[AuditEntry]] = {}
        self._screenshots: dict[str, bytes] = {}

    def put_bug(self, bug: BugRecord, screenshot_png: bytes | None) -> None:
        self._bugs[bug.id] = bug
        if screenshot_png is not None:
            self._screenshots[bug.id] = screenshot_png
            bug.screenshot = True

    def get_bug(self, bug_id: str) -> BugRecord:
        try:
            return self._bugs[bug_id]
        except KeyError as e:
            raise NotFound(bug_id) from e

    def list_bugs(self, *, status, since_iso):
        for b in self._bugs.values():
            if b.added_at < since_iso:
                continue
            if status and b.status != status:
                continue
            yield b

    def update_status(self, bug_id, new_status):
        b = self.get_bug(bug_id)
        b.status = new_status
        return b

    def append_audit(self, bug_id, entry):
        self._audits.setdefault(bug_id, []).append(entry)

    def list_audit(self, bug_id):
        return list(self._audits.get(bug_id, []))

    def get_screenshot(self, bug_id):
        if bug_id not in self._screenshots:
            raise NotFound(bug_id)
        return self._screenshots[bug_id]


# ---------------------------------------------------------------------------
# FilesystemStore — production-grade for single-host apps
# ---------------------------------------------------------------------------

class FilesystemStore:
    """One JSON file per bug, audit lines in JSONL, PNG bytes alongside.

    Layout under ``root``::

        bugs/
          bug-20260516-181523-a3b91f2.json
          bug-20260516-181523-a3b91f2.audit.jsonl
          bug-20260516-181523-a3b91f2.png        (optional)
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _rec_path(self, bug_id: str) -> Path:
        return self.root / f"{bug_id}.json"

    def _audit_path(self, bug_id: str) -> Path:
        return self.root / f"{bug_id}.audit.jsonl"

    def _shot_path(self, bug_id: str) -> Path:
        return self.root / f"{bug_id}.png"

    def put_bug(self, bug, screenshot_png):
        if screenshot_png is not None:
            self._shot_path(bug.id).write_bytes(screenshot_png)
            bug.screenshot = True
        # Convert dataclass → dict carefully (we want camelCase on-disk shape).
        payload = asdict(bug)
        self._rec_path(bug.id).write_text(json.dumps(payload, indent=2))

    def get_bug(self, bug_id):
        p = self._rec_path(bug_id)
        if not p.exists():
            raise NotFound(bug_id)
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            raise StoreError(f"could not read {bug_id}") from e
        return BugRecord(**data)

    def list_bugs(self, *, status, since_iso):
        for p in self.root.glob("bug-*.json"):
            if p.name.endswith(".audit.jsonl"):
                continue
            try:
                data = json.loads(p.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            rec = BugRecord(**data)
            if rec.added_at < since_iso:
                continue
            if status and rec.status != status:
                continue
            yield rec

    def update_status(self, bug_id, new_status):
        rec = self.get_bug(bug_id)
        rec.status = new_status
        self.put_bug(rec, None)
        return rec

    def append_audit(self, bug_id, entry):
        with open(self._audit_path(bug_id), "a") as f:
            f.write(json.dumps(entry.to_dict()) + "\n")

    def list_audit(self, bug_id):
        p = self._audit_path(bug_id)
        if not p.exists():
            return []
        out = []
        for ln in p.read_text().splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                d = json.loads(ln)
            except json.JSONDecodeError:
                continue
            # Accept both camelCase (current wire format) and snake_case
            # (legacy on-disk format written by the claude-tmux-dashboard
            # before it adopted this package). Lenient read; strict write.
            out.append(AuditEntry(
                changed_at=d.get("changedAt") or d.get("changed_at", ""),
                to_status=d.get("toStatus") or d.get("to_status", ""),
                from_status=d.get("fromStatus") if "fromStatus" in d else d.get("from_status"),
                changed_by=d.get("changedBy") or d.get("changed_by", ""),
                note=d.get("note", ""),
            ))
        return out

    def get_screenshot(self, bug_id):
        p = self._shot_path(bug_id)
        if not p.exists():
            raise NotFound(bug_id)
        return p.read_bytes()
