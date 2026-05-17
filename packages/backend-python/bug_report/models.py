"""Model-layer constants + ID helpers. Pure Python; no Flask, no I/O."""

from __future__ import annotations

import re
import time
import uuid

BUG_DETAILS_MAX = 10 * 1024          # 10 KB
BUG_SCREENSHOT_MAX = 5 * 1024 * 1024  # 5 MB decoded

BUG_STATUSES = ("open", "triaged", "resolved", "declined")

_BUG_ID_RE = re.compile(r"^bug-\d{8}-\d{6}-[a-f0-9]{6}$")


def new_bug_id() -> str:
    """`bug-YYYYMMDD-HHMMSS-XXXXXX`. Sortable by timestamp; the suffix
    disambiguates within the same second."""
    return f"bug-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"


def valid_bug_id(bug_id: str) -> bool:
    return bool(_BUG_ID_RE.match(bug_id or ""))
