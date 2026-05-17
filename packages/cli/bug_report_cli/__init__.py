"""report-bug — file a bug into any bug-report-widget backend.

Usage:
    report-bug "title or first line"                          # details from stdin
    report-bug -t "title" -d "details"                        # both inline
    report-bug -t "title" --details-file notes.txt            # details from a file
    report-bug -t "title" -d "..." --transcript-file last10.json
    report-bug -t "title" -d "..." --tag perf --tag critical

Same backend that powers the floating 🐛 button. Every report — user, agent,
CLI — lands in the same /bugs queue. Agent-filed reports auto-tag
`agent-self-report`.

Environment:
    BUG_REPORT_URL       Default endpoint. Default: http://127.0.0.1:8765/api/bugs
    BUG_REPORTER_EMAIL   Identity stamped on the report. Default: empty.
    BUG_ADDED_BY         How it was filed. CLI default: 'agent' (set to 'cli'
                         if a human is invoking it manually).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

__version__ = "1.0.0"


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _read_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog="report-bug",
        description="File a bug into a bug-report-widget backend.",
    )
    ap.add_argument("title_pos", nargs="?", help="title (positional shorthand)")
    ap.add_argument("-t", "--title", help="explicit title (overrides positional)")
    ap.add_argument("-d", "--details", help="details body")
    ap.add_argument("--details-file", help="read details from a file (use - for stdin)")
    ap.add_argument("--transcript-file", help="JSON file: list of chat turns")
    ap.add_argument("--tag", action="append", default=[], help="add a tag (repeatable)")
    ap.add_argument("--added-by", default=os.environ.get("BUG_ADDED_BY", "agent"),
                    help="how the bug was filed (default: agent)")
    ap.add_argument("--actor-email", default=os.environ.get("BUG_REPORTER_EMAIL", ""),
                    help="email of the user this report belongs to")
    ap.add_argument("--url", default=os.environ.get("BUG_REPORT_URL", "http://127.0.0.1:8765/api/bugs"),
                    help="dashboard /api/bugs endpoint")
    args = ap.parse_args(argv)

    title = (args.title or args.title_pos or "").strip()

    if args.details_file == "-":
        details = sys.stdin.read()
    elif args.details_file:
        details = _read_text(args.details_file)
    elif args.details is not None:
        details = args.details
    else:
        # No --details flag. If stdin is piped, read it; otherwise fall back
        # to title only.
        details = sys.stdin.read() if not sys.stdin.isatty() else title

    details = details.strip()
    if not details:
        print("report-bug: empty details — nothing to file", file=sys.stderr)
        return 2

    transcript = _read_json(args.transcript_file) if args.transcript_file else None

    payload = {
        "title": title or details.splitlines()[0],
        "details": details,
        "tags": ["bug", *args.tag],
        "addedBy": args.added_by,
        "actorEmail": args.actor_email,
        "metaUserAgent": f"report-bug-cli/{__version__} ({os.uname().sysname})",
    }
    if transcript is not None:
        payload["transcript"] = transcript

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        args.url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(data.get("id", "ok"))
            return 0
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"report-bug: HTTP {e.code} — {e.read().decode('utf-8', 'replace')}\n")
        return 1
    except urllib.error.URLError as e:
        sys.stderr.write(f"report-bug: cannot reach {args.url}: {e.reason}\n")
        return 1


def main_entry() -> None:
    raise SystemExit(main(sys.argv[1:]))


if __name__ == "__main__":
    main_entry()
