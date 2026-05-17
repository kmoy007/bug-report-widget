// Storage interface + two reference implementations.
//
// Stores expose:
//   putBug(bug, screenshotBytes|null)  : Promise<void>
//   getBug(id)                         : Promise<BugRecord>            (throws NotFound)
//   listBugs({ status, sinceIso })     : AsyncIterable<BugRecord>
//   updateStatus(id, newStatus)        : Promise<BugRecord>
//   appendAudit(id, entry)             : Promise<void>
//   listAudit(id)                      : Promise<AuditEntry[]>
//   getScreenshot(id)                  : Promise<Buffer>               (throws NotFound)
//
// Wire-format DTOs are camelCase (matching openapi.yaml). BugRecord is the
// on-store shape; the router maps it to summary / full DTOs.

import { mkdir, readFile, readdir, writeFile, unlink, appendFile } from "node:fs/promises";
import path from "node:path";

export class StoreError extends Error {}
export class NotFound extends StoreError {}

// Bug record shape used internally.
export function makeBugRecord(o) {
  return {
    id: o.id,
    title: o.title,
    details: o.details,
    tags: Array.from(o.tags || []),
    status: o.status || "open",
    addedBy: o.addedBy || "web",
    actorEmail: o.actorEmail || "",
    addedAt: o.addedAt,
    metaUrl: o.metaUrl || "",
    metaUserAgent: o.metaUserAgent || "",
    metaBuildSha: o.metaBuildSha || "",
    screenshot: !!o.screenshot,
    transcript: o.transcript || null,
  };
}

export function toBugSummary(rec) {
  return {
    id: rec.id,
    title: rec.title,
    tags: [...rec.tags],
    status: rec.status,
    addedBy: rec.addedBy,
    actorEmail: rec.actorEmail,
    addedAt: rec.addedAt,
    screenshot: !!rec.screenshot,
  };
}

export function toBugFull(rec) {
  return {
    ...toBugSummary(rec),
    details: rec.details,
    metaUrl: rec.metaUrl,
    metaUserAgent: rec.metaUserAgent,
    metaBuildSha: rec.metaBuildSha,
    transcript: rec.transcript,
  };
}

// ----------------------------------------------------------------------
// InMemoryStore — tests + dev
// ----------------------------------------------------------------------

export class InMemoryStore {
  constructor() {
    this._bugs = new Map();
    this._audits = new Map();
    this._shots = new Map();
  }
  async putBug(bug, shot) {
    const rec = makeBugRecord(bug);
    if (shot && shot.length) { this._shots.set(rec.id, Buffer.from(shot)); rec.screenshot = true; }
    this._bugs.set(rec.id, rec);
  }
  async getBug(id) {
    const r = this._bugs.get(id);
    if (!r) throw new NotFound(id);
    return r;
  }
  async *listBugs({ status, sinceIso }) {
    for (const r of this._bugs.values()) {
      if (r.addedAt < sinceIso) continue;
      if (status && r.status !== status) continue;
      yield r;
    }
  }
  async updateStatus(id, newStatus) {
    const r = await this.getBug(id);
    r.status = newStatus;
    return r;
  }
  async appendAudit(id, entry) {
    if (!this._audits.has(id)) this._audits.set(id, []);
    this._audits.get(id).push(entry);
  }
  async listAudit(id) {
    return [...(this._audits.get(id) || [])];
  }
  async getScreenshot(id) {
    const s = this._shots.get(id);
    if (!s) throw new NotFound(id);
    return s;
  }
}

// ----------------------------------------------------------------------
// FilesystemStore — single-host production
// ----------------------------------------------------------------------

export class FilesystemStore {
  constructor(root) {
    this.root = root;
    this._ready = mkdir(root, { recursive: true });
  }
  _path(id, suffix) { return path.join(this.root, `${id}${suffix}`); }
  async putBug(bug, shot) {
    await this._ready;
    const rec = makeBugRecord(bug);
    if (shot && shot.length) { await writeFile(this._path(rec.id, ".png"), shot); rec.screenshot = true; }
    await writeFile(this._path(rec.id, ".json"), JSON.stringify(rec, null, 2));
  }
  async getBug(id) {
    await this._ready;
    try {
      const data = await readFile(this._path(id, ".json"), "utf8");
      return makeBugRecord(JSON.parse(data));
    } catch (e) {
      if (e.code === "ENOENT") throw new NotFound(id);
      throw new StoreError(`could not read ${id}: ${e.message}`);
    }
  }
  async *listBugs({ status, sinceIso }) {
    await this._ready;
    const entries = await readdir(this.root);
    for (const name of entries) {
      if (!name.startsWith("bug-") || !name.endsWith(".json") || name.endsWith(".audit.jsonl")) continue;
      try {
        const data = await readFile(path.join(this.root, name), "utf8");
        const rec = makeBugRecord(JSON.parse(data));
        if (rec.addedAt < sinceIso) continue;
        if (status && rec.status !== status) continue;
        yield rec;
      } catch { continue; }
    }
  }
  async updateStatus(id, newStatus) {
    const rec = await this.getBug(id);
    rec.status = newStatus;
    await writeFile(this._path(rec.id, ".json"), JSON.stringify(rec, null, 2));
    return rec;
  }
  async appendAudit(id, entry) {
    await appendFile(this._path(id, ".audit.jsonl"), JSON.stringify(entry) + "\n");
  }
  async listAudit(id) {
    try {
      const data = await readFile(this._path(id, ".audit.jsonl"), "utf8");
      return data.split("\n").filter(Boolean).map(line => JSON.parse(line));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async getScreenshot(id) {
    try {
      return await readFile(this._path(id, ".png"));
    } catch (e) {
      if (e.code === "ENOENT") throw new NotFound(id);
      throw e;
    }
  }
}
