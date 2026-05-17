"""Python TypedDicts matching openapi.yaml.

Hand-maintained; tiny enough that hand-edit is cheaper than codegen.
If you edit a field here, edit ``types.ts`` and ``openapi.yaml`` to match.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

Status = Literal["open", "triaged", "resolved", "declined"]


class TranscriptTurn(TypedDict, total=False):
    ts: str
    model: str
    userMessage: str
    assistantResponse: str
    toolCalls: list[dict]  # [{"name": "..."}]


class BugCreate(TypedDict, total=False):
    title: str
    details: str  # required
    tags: list[str] | str
    addedBy: str
    actorEmail: str
    metaUrl: str
    metaUserAgent: str
    metaBuildSha: str
    screenshot: str  # data URL or raw base64
    transcript: list[TranscriptTurn]


class BugSummary(TypedDict):
    id: str
    title: str
    tags: list[str]
    status: Status
    addedBy: str
    actorEmail: NotRequired[str]
    addedAt: str
    screenshot: bool


class AuditEntry(TypedDict):
    changedAt: str
    changedBy: NotRequired[str]
    fromStatus: Status | None
    toStatus: Status
    note: NotRequired[str]


class Bug(BugSummary):
    details: str
    metaUrl: NotRequired[str]
    metaUserAgent: NotRequired[str]
    metaBuildSha: NotRequired[str]
    transcript: NotRequired[list[TranscriptTurn] | None]
    audit: list[AuditEntry]


class ApiError(TypedDict):
    error: str
