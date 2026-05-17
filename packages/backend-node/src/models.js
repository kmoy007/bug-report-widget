// Model-layer constants, ID helpers, validation. Pure JS; no Express, no fs.
// Mirror of packages/backend-python/bug_report/models.py — keep them in sync.

import { randomBytes } from "node:crypto";

export const BUG_DETAILS_MAX = 10 * 1024;          // 10 KB
export const BUG_SCREENSHOT_MAX = 5 * 1024 * 1024;  // 5 MB decoded

export const BUG_STATUSES = ["open", "triaged", "resolved", "declined"];

const BUG_ID_RE = /^bug-\d{8}-\d{6}-[a-f0-9]{6}$/;

export function validBugId(id) {
  return typeof id === "string" && BUG_ID_RE.test(id);
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

export function newBugId(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1, 2);
  const dd = pad(date.getUTCDate(), 2);
  const HH = pad(date.getUTCHours(), 2);
  const MM = pad(date.getUTCMinutes(), 2);
  const SS = pad(date.getUTCSeconds(), 2);
  const suffix = randomBytes(3).toString("hex");
  return `bug-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${suffix}`;
}

// Monotonic, microsecond-precision ISO-8601 timestamp. Mirrors the Python
// implementation's behaviour: bumps by 1µs when the clock doesn't move,
// so a tight POST loop produces strictly increasing timestamps. This is
// what makes "sort newest-first" stable across the cross-stack contract
// test even when bugs are filed faster than the wall clock can resolve.
let lastNs = 0n;

export function nowIso() {
  let ns = BigInt(Date.now()) * 1_000_000n + processNanos();
  if (ns <= lastNs) ns = lastNs + 1000n;
  lastNs = ns;
  const ms = Number(ns / 1_000_000n);
  const us = Number((ns / 1000n) % 1_000_000n);
  const d = new Date(ms);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  const hms = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  return `${ymd}T${hms}.${pad(us, 6)}Z`;
}

function processNanos() {
  // hrtime.bigint() is process-relative but high-resolution. We don't use it
  // for the absolute timestamp; we use it only as a tiebreaker scaled down.
  return process.hrtime.bigint() % 1_000_000n;
}

export function sinceIso(days) {
  const d = new Date(Date.now() - days * 86400 * 1000);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  const hms = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  return `${ymd}T${hms}.000000Z`;
}
