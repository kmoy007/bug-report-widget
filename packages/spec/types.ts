/**
 * TypeScript types matching openapi.yaml. Hand-written; small enough that
 * a generator would be heavier than the payoff. If you edit one, edit the
 * other — CI greps for divergence.
 */

export type Status = "open" | "triaged" | "resolved" | "declined";

export interface TranscriptTurn {
  ts?: string;
  model?: string;
  userMessage?: string;
  assistantResponse?: string;
  toolCalls?: Array<{ name: string }>;
}

export interface BugCreate {
  title?: string;
  details: string;
  tags?: string[] | string;
  addedBy?: string;
  actorEmail?: string;
  metaUrl?: string;
  metaUserAgent?: string;
  metaBuildSha?: string;
  /** data: URL or raw base64 image (PNG or JPEG). ≤ 5 MB decoded. */
  screenshot?: string;
  transcript?: TranscriptTurn[];
}

export interface BugSummary {
  id: string;
  title: string;
  tags: string[];
  status: Status;
  addedBy: string;
  actorEmail?: string;
  addedAt: string;
  screenshot: boolean;
}

export interface AuditEntry {
  changedAt: string;
  changedBy?: string;
  fromStatus: Status | null;
  toStatus: Status;
  note?: string;
}

export interface Bug extends BugSummary {
  details: string;
  metaUrl?: string;
  metaUserAgent?: string;
  metaBuildSha?: string;
  transcript?: TranscriptTurn[] | null;
  audit: AuditEntry[];
}

export interface ApiError {
  error: string;
}
