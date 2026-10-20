// FilesystemStore never shows a half-written report (mirror of
// packages/backend-python/tests/test_filesystem_atomic.py).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, utimes, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FilesystemStore, StoreError } from "../src/store.js";

const bug = (o = {}) => ({
  id: "bug-20261020-000000-aaaaaa", title: "t", details: "x".repeat(20000), tags: ["bug"],
  status: "open", addedBy: "web", actorEmail: "", addedAt: "2026-10-20T00:00:00.000Z", ...o,
});
const tmpdir = () => mkdtemp(path.join(os.tmpdir(), "brs-"));
const temps = async d => (await readdir(d)).filter(n => n.endsWith(".tmp"));

test("a read and a listing never see a half-written report", async () => {
  const d = await tmpdir();
  const store = new FilesystemStore(d, { readAttempts: 1 });   // the retry must not be what hides a torn read
  const b = bug();
  await store.putBug(b, null);
  let stop = false;
  const writer = (async () => {
    for (let i = 0; !stop; i++) await store.updateStatus(b.id, i % 2 ? "open" : "triaged");
  })();
  const errors = [];
  let reads = 0;
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    try {
      await store.getBug(b.id);
      const ids = [];
      for await (const r of store.listBugs({ sinceIso: "" })) ids.push(r.id);
      if (ids.length !== 1) errors.push("listing dropped the report");
    } catch (e) { errors.push(e); }
    reads++;
  }
  stop = true;
  await writer;
  assert.ok(reads > 20);
  assert.deepEqual(errors, []);
});

test("no temp file is left or listed", async () => {
  const d = await tmpdir();
  const store = new FilesystemStore(d);
  await store.putBug(bug(), Buffer.from("PNG"));
  assert.deepEqual((await readdir(d)).sort(), ["bug-20261020-000000-aaaaaa.json", "bug-20261020-000000-aaaaaa.png"]);
  await writeFile(path.join(d, ".bug-1.json.abc.tmp"), "{");
  const ids = [];
  for await (const r of store.listBugs({ sinceIso: "" })) ids.push(r.id);
  assert.deepEqual(ids, ["bug-20261020-000000-aaaaaa"]);
});

test("a corrupt report still raises after the retries", async () => {
  const d = await tmpdir();
  const store = new FilesystemStore(d);
  await writeFile(path.join(d, "bug-1.json"), "");
  await assert.rejects(store.getBug("bug-1"), StoreError);
});

test("stale temp files are swept at start and fresh ones kept", async () => {
  const d = await tmpdir();
  const old = path.join(d, ".old.tmp");
  await writeFile(old, "");
  await writeFile(path.join(d, ".new.tmp"), "");
  const past = new Date(Date.now() - 3600_000);
  await utimes(old, past, past);
  await new FilesystemStore(d)._ready;
  assert.deepEqual(await readdir(d), [".new.tmp"]);
});

test("a retry reads a report that is briefly unparseable", async () => {
  const d = await tmpdir();
  const store = new FilesystemStore(d);
  const b = bug();
  await store.putBug(b, null);
  const file = path.join(d, `${b.id}.json`);
  const good = await readFile(file, "utf8");
  await writeFile(file, "");
  setTimeout(() => writeFile(file, good), 30);
  assert.equal((await store.getBug(b.id)).id, b.id);
});

test("a failing temp write leaves the report intact and no temp", async t => {
  if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return t.skip("needs a non-root POSIX user");
  const d = await tmpdir();
  const store = new FilesystemStore(d);
  const b = bug();
  await store.putBug(b, null);
  const file = path.join(d, `${b.id}.json`);
  const before = await readFile(file, "utf8");
  await chmod(d, 0o555);                       // the temp cannot be created
  try {
    await assert.rejects(store.updateStatus(b.id, "triaged"));
  } finally { await chmod(d, 0o755); }
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(await temps(d), []);
});
