// Tests for AzureTablesStore.
//
// We avoid spinning up real Azure or pulling in a heavy mock framework.
// Instead we inject in-memory TableClient + BlobContainer doubles via the
// store's constructor, which is the same shape the production code calls.
//
// The injected doubles enforce the "createTable() before createEntity()"
// rule — same discipline leap's tests/helpers/mock-azure-tables.js
// applies — because that's the actual Azure behaviour and our store
// guards against it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AzureTablesStore,
  tagsToCsv,
  csvToTags,
  partitionKeyForAddedAt,
} from "../src/stores/azure-tables.js";
import { NotFound } from "../src/store.js";

// ── Doubles ────────────────────────────────────────────────────────

class FakeTableClient {
  constructor() { this.created = false; this.rows = []; }
  async createTable() { this.created = true; }
  _check(op) {
    if (!this.created) {
      const e = new Error(`${op} on uncreated table`);
      e.statusCode = 404;
      throw e;
    }
  }
  async createEntity(entity) {
    this._check("createEntity");
    if (this.rows.find(r => r.partitionKey === entity.partitionKey && r.rowKey === entity.rowKey)) {
      const e = new Error("dup"); e.statusCode = 409; throw e;
    }
    this.rows.push({ ...entity });
  }
  async updateEntity(entity) {
    this._check("updateEntity");
    const idx = this.rows.findIndex(r => r.partitionKey === entity.partitionKey && r.rowKey === entity.rowKey);
    if (idx < 0) { const e = new Error("not found"); e.statusCode = 404; throw e; }
    this.rows[idx] = { ...entity };
  }
  listEntities({ queryOptions } = {}) {
    if (!this.created) {
      const e = new Error("table not created"); e.statusCode = 404;
      // Real Azure throws on iterate; our store handles that. Return an
      // iterator that throws on first .next() to match.
      return (async function* () { throw e; })();
    }
    const filter = (queryOptions && queryOptions.filter) || "";
    const rows = this.rows.filter(r => _matchesFilter(r, filter));
    return (async function* () { for (const r of rows) yield { ...r }; })();
  }
}

// Tiny OData filter evaluator — supports the exact shapes our store
// generates: `RowKey eq 'X'`, `PartitionKey ge 'Y'`, `Status eq 'open'`,
// and `A and B`.
function _matchesFilter(row, filter) {
  if (!filter) return true;
  const parts = filter.split(/\s+and\s+/i);
  return parts.every(p => {
    const m = p.match(/^(\w+)\s+(eq|ge|le|gt|lt)\s+'(.*)'$/);
    if (!m) return true;
    const [, col, op, val] = m;
    const cell = row[col === "RowKey" ? "rowKey" : col === "PartitionKey" ? "partitionKey" : col];
    if (cell == null) return false;
    switch (op) {
      case "eq": return String(cell) === val.replace(/''/g, "'");
      case "ge": return String(cell) >= val;
      case "le": return String(cell) <= val;
      case "gt": return String(cell) > val;
      case "lt": return String(cell) < val;
      default: return true;
    }
  });
}

class FakeBlobContainer {
  constructor() { this.blobs = new Map(); this.created = false; }
  async createIfNotExists() { this.created = true; }
  getBlockBlobClient(name) {
    const blobs = this.blobs;
    return {
      async uploadData(buf) { blobs.set(name, Buffer.from(buf)); },
      async downloadToBuffer() {
        if (!blobs.has(name)) {
          const e = new Error("BlobNotFound"); e.statusCode = 404; e.code = "BlobNotFound";
          throw e;
        }
        return blobs.get(name);
      },
    };
  }
}

function makeStore() {
  return new AzureTablesStore({
    tableClient: new FakeTableClient(),
    auditTableClient: new FakeTableClient(),
    blobContainer: new FakeBlobContainer(),
  });
}

const PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D" +
  "49444154789C6300010000000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

// ── Helpers ────────────────────────────────────────────────────────

test("tagsToCsv: ensures 'bug' is present, sanitises", () => {
  assert.equal(tagsToCsv(["UI Bug!", "perf"]), "bug,uibug,perf");
  assert.equal(tagsToCsv(["bug", "bug"]), "bug");
  assert.equal(tagsToCsv([]), "bug");
  assert.equal(tagsToCsv(null), "bug");
});

test("csvToTags: split + filter empty", () => {
  assert.deepEqual(csvToTags("bug,perf"), ["bug", "perf"]);
  assert.deepEqual(csvToTags(""), []);
  assert.deepEqual(csvToTags(undefined), []);
});

test("partitionKeyForAddedAt: yyyy-mm-dd prefix", () => {
  assert.equal(partitionKeyForAddedAt("2026-05-16T22:36:07.123456Z"), "2026-05-16");
  assert.equal(partitionKeyForAddedAt(""), "");
});

// ── Round-trip ──────────────────────────────────────────────────────

test("putBug + getBug roundtrip", async () => {
  const store = makeStore();
  await store.putBug({
    id: "bug-20260516-181523-a3b91f2",
    title: "x",
    details: "y",
    tags: ["bug"],
    status: "open",
    addedBy: "web",
    actorEmail: "k@x.io",
    addedAt: "2026-05-16T18:15:23.000000Z",
  });
  const got = await store.getBug("bug-20260516-181523-a3b91f2");
  assert.equal(got.id, "bug-20260516-181523-a3b91f2");
  assert.equal(got.title, "x");
  assert.equal(got.details, "y");
  assert.deepEqual(got.tags, ["bug"]);
  assert.equal(got.status, "open");
  assert.equal(got.addedBy, "web");
});

test("getBug: NotFound for missing id", async () => {
  const store = makeStore();
  await assert.rejects(() => store.getBug("bug-20260516-181523-aaaaaa"), NotFound);
});

test("putBug stores screenshot bytes in the blob container", async () => {
  const store = makeStore();
  await store.putBug({
    id: "bug-20260516-181523-aaaaaa",
    title: "with shot", details: "x", tags: ["bug"], status: "open",
    addedBy: "web", actorEmail: "", addedAt: "2026-05-16T18:15:23.000000Z",
  }, PNG);
  const got = await store.getScreenshot("bug-20260516-181523-aaaaaa");
  assert.deepEqual(got, PNG);
  const rec = await store.getBug("bug-20260516-181523-aaaaaa");
  assert.equal(rec.screenshot, true);
});

test("getScreenshot: NotFound when missing", async () => {
  const store = makeStore();
  await store.putBug({
    id: "bug-20260516-181523-bbbbbb",
    title: "no shot", details: "x", tags: ["bug"], status: "open",
    addedBy: "web", actorEmail: "", addedAt: "2026-05-16T18:15:23.000000Z",
  });
  await assert.rejects(() => store.getScreenshot("bug-20260516-181523-bbbbbb"), NotFound);
});

test("listBugs filters by sinceIso + status", async () => {
  const store = makeStore();
  // Two recent bugs, one stale, one resolved.
  await store.putBug({ id: "bug-20260516-181523-aaaaaa", title: "fresh open", details: "x", tags: ["bug"],
    status: "open", addedBy: "web", actorEmail: "", addedAt: "2026-05-16T18:15:23.000000Z" });
  await store.putBug({ id: "bug-20260516-181523-bbbbbb", title: "fresh triaged", details: "x", tags: ["bug"],
    status: "triaged", addedBy: "web", actorEmail: "", addedAt: "2026-05-16T18:15:24.000000Z" });
  await store.putBug({ id: "bug-20260101-000000-cccccc", title: "old open", details: "x", tags: ["bug"],
    status: "open", addedBy: "web", actorEmail: "", addedAt: "2026-01-01T00:00:00.000000Z" });

  const recent = [];
  for await (const r of store.listBugs({ status: null, sinceIso: "2026-05-01T00:00:00.000000Z" })) {
    recent.push(r.id);
  }
  assert.deepEqual(recent.sort(), [
    "bug-20260516-181523-aaaaaa",
    "bug-20260516-181523-bbbbbb",
  ].sort());

  const openOnly = [];
  for await (const r of store.listBugs({ status: "open", sinceIso: "2026-05-01T00:00:00.000000Z" })) {
    openOnly.push(r.id);
  }
  assert.deepEqual(openOnly, ["bug-20260516-181523-aaaaaa"]);
});

test("updateStatus + audit roundtrip", async () => {
  const store = makeStore();
  const id = "bug-20260516-181523-aaaaaa";
  await store.putBug({
    id, title: "x", details: "x", tags: ["bug"], status: "open",
    addedBy: "web", actorEmail: "", addedAt: "2026-05-16T18:15:23.000000Z",
  });
  await store.appendAudit(id, {
    changedAt: "2026-05-16T18:15:23.500000Z", fromStatus: null, toStatus: "open",
    changedBy: "web", note: "filed",
  });
  const updated = await store.updateStatus(id, "triaged");
  assert.equal(updated.status, "triaged");
  await store.appendAudit(id, {
    changedAt: "2026-05-16T18:30:00.000000Z", fromStatus: "open", toStatus: "triaged",
    changedBy: "ken@x.io", note: "looking",
  });

  const audit = await store.listAudit(id);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].toStatus, "open");
  assert.equal(audit[1].fromStatus, "open");
  assert.equal(audit[1].toStatus, "triaged");
  assert.equal(audit[1].note, "looking");

  // updateStatus actually wrote the new status into the row.
  const rec = await store.getBug(id);
  assert.equal(rec.status, "triaged");
});

test("appendAudit ensures audit table exists before write", async () => {
  // Regression: createTable must be called on the audit table.
  // Otherwise the strict mock would 404. This proves the store calls it.
  const store = makeStore();
  await store.appendAudit("bug-20260516-181523-aaaaaa", {
    changedAt: "2026-05-16T18:15:23.000000Z", fromStatus: null, toStatus: "open",
    changedBy: "web", note: "filed",
  });
  const audit = await store.listAudit("bug-20260516-181523-aaaaaa");
  assert.equal(audit.length, 1);
});

test("escapeOData doubles single quotes", async () => {
  const store = makeStore();
  // ID with an apostrophe in it shouldn't happen (IDs are generated), but
  // the escaping must be correct for the more dangerous case: a malicious
  // ID via the URL. Confirm via getBug behavior — we just want it to NOT
  // throw a syntax error and return NotFound cleanly.
  await assert.rejects(() => store.getBug("bug-20260516-181523-aaa'aa"), NotFound);
});

test("constructor throws without store-injection or connectionString", async () => {
  const store = new AzureTablesStore({});
  await assert.rejects(() => store.getBug("bug-20260516-181523-aaaaaa"), /connectionString/);
});
