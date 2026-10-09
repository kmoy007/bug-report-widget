// 1.6.0: a capture that yields no image says WHY (ported from leap-timesheet,
// bug-20260915-000612: two reports arrived with no screenshot while others from
// the same day had one, and every failure path resolved a bare null, so nothing
// recorded which of five causes it was). Also the lazy html2canvas load
// (timesheet UX-4) and the modal text / POST field / client event that carry
// the reason.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");
const { makeDom } = require("./fake-dom.js");

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const CFG = Object.assign({}, widget.DEFAULTS, { captureTimeoutMs: 80, captureLateWatchMs: 200 });

function canvasOf(pixel, opts) {
  opts = opts || {};
  return {
    width: opts.width || 50, height: opts.height || 40,
    getContext: () => ({
      fillRect() {}, drawImage() {},
      getImageData: () => { if (opts.getThrows) { const e = new Error("tainted"); e.name = "SecurityError"; throw e; } return { data: pixel }; },
    }),
    toDataURL: opts.toDataURL || (() => "data:image/png;base64,QUJD"),
  };
}
const cap = (h2c, extra, cfg) => widget.captureScreenshotDetailed(Object.assign({ html2canvas: h2c, document: makeDom() }, extra || {}), cfg || CFG);

test("success carries a data URL and no reason; captureScreenshot still returns just the URL", async () => {
  const r = await cap(() => Promise.resolve(canvasOf([9, 9, 9, 255])));
  assert.equal(r.reason, null);
  assert.match(r.dataUrl, /^data:image\/png/);
  const plain = await widget.captureScreenshot({ html2canvas: () => Promise.resolve(canvasOf([9, 9, 9, 255])), document: makeDom() }, CFG);
  assert.match(plain, /^data:image\/png/);
  const none = await widget.captureScreenshot({ html2canvas: null, document: makeDom() }, CFG);
  assert.equal(none, null, "back-compat: still null on failure");
});

test("no-library", async () => {
  const r = await cap(null);
  assert.deepEqual([r.dataUrl, r.reason], [null, "no-library"]);
});

test("render-error carries the error", async () => {
  const r = await cap(() => Promise.reject(new TypeError("bad css")));
  assert.equal(r.reason, "render-error");
  assert.match(r.detail, /bad css/);
  const t = await cap(() => { throw new Error("sync boom"); });
  assert.equal(t.reason, "render-error");
});

test("blank", async () => {
  const r = await cap(() => Promise.resolve(canvasOf([255, 255, 255, 255])));
  assert.equal(r.reason, "blank");
  assert.equal(r.width, 50);
});

test("tainted: unreadable pixels are told apart from blank", async () => {
  const r = await cap(() => Promise.resolve(canvasOf([0, 0, 0, 255], { getThrows: true })));
  assert.equal(r.reason, "tainted");
  assert.equal(widget.canvasState(canvasOf([0, 0, 0, 255], { getThrows: true })), "tainted");
  assert.equal(widget.canvasState(canvasOf([255, 255, 255, 255])), "blank");
  assert.equal(widget.canvasState(canvasOf([1, 2, 3, 255])), "ok");
});

test("encode-error vs tainted vs too-large", async () => {
  const enc = (e) => () => Promise.resolve(canvasOf([1, 2, 3, 255], { toDataURL: () => { throw e; } }));
  const sec = new Error("The canvas has been tainted"); sec.name = "SecurityError";
  assert.equal((await cap(enc(sec))).reason, "tainted");
  const other = await cap(enc(new Error("out of memory")));
  assert.equal(other.reason, "encode-error");
  assert.match(other.detail, /out of memory/);
  const huge = canvasOf([1, 2, 3, 255], { toDataURL: () => "data:image/png;base64," + "A".repeat(4000) });
  const r = await cap(() => Promise.resolve(huge), { document: Object.assign(makeDom(), { createElement: () => huge }) },
    Object.assign({}, CFG, { maxScreenshotBytes: 100 }));
  assert.equal(r.reason, "too-large");
  assert.equal(r.width, 50);
});

test("timeout reports how long the render REALLY took once it finishes", async () => {
  let finish;
  const r = await cap(() => new Promise((res) => { finish = res; }));
  assert.equal(r.reason, "timeout");
  assert.equal(typeof r.late.then, "function");
  finish(canvasOf([1, 2, 3, 255]));
  const lateMs = await r.late;
  assert.ok(lateMs >= 70, "late render took " + lateMs);
});

test("a render that never finishes reports late = null after the watch window", async () => {
  const r = await cap(() => new Promise(() => {}), {}, Object.assign({}, CFG, { captureTimeoutMs: 20, captureLateWatchMs: 30 }));
  assert.equal(r.reason, "timeout");
  const keepAlive = setTimeout(() => {}, 300);   // the widget's late-watch timer is unref'd in Node
  assert.equal(await r.late, null);
  clearTimeout(keepAlive);
});

test("describeCaptureFailure reads as a sentence for every reason", () => {
  for (const reason of ["no-library", "timeout", "render-error", "blank", "encode-error", "tainted", "too-large"]) {
    const s = widget.describeCaptureFailure({ reason, ms: 6000, detail: "d", width: 3, height: 4 });
    assert.ok(s.length > 10 && !/undefined/.test(s), reason + ": " + s);
  }
  assert.equal(widget.describeCaptureFailure(null), "");
  assert.equal(widget.describeCaptureFailure({ dataUrl: "x", reason: null }), "");
});

// ── lazy html2canvas ────────────────────────────────────────────────────────

test("html2canvasUrl: the script is injected on first need, awaited, and shared by quick repeats", async () => {
  const doc = makeDom();
  const win = {};
  const scripts = [];
  const orig = doc.createElement;
  doc.createElement = (tag) => { const e = orig(tag); if (tag === "script") scripts.push(e); return e; };
  const cfg = Object.assign({}, CFG, { captureTimeoutMs: 500, html2canvasUrl: "/static/html2canvas.min.js" });
  const a = widget.captureScreenshotDetailed({ document: doc, window: win }, cfg);
  const b = widget.captureScreenshotDetailed({ document: doc, window: win }, cfg);
  await settle(5);
  assert.equal(scripts.length, 1, "one script for two captures");
  assert.equal(scripts[0].src, "/static/html2canvas.min.js");
  assert.equal(scripts[0].parentNode, doc.head);
  win.html2canvas = () => Promise.resolve(canvasOf([1, 2, 3, 255]));   // what the script does when it runs
  scripts[0].onload();
  assert.equal((await a).reason, null);
  assert.equal((await b).reason, null);
});

test("html2canvasUrl: a script that will not load is no-library, and a later click may try again", async () => {
  const doc = makeDom();
  const win = {};
  const scripts = [];
  const orig = doc.createElement;
  doc.createElement = (tag) => { const e = orig(tag); if (tag === "script") scripts.push(e); return e; };
  const cfg = Object.assign({}, CFG, { captureTimeoutMs: 500, html2canvasUrl: "/x.js" });
  const first = widget.captureScreenshotDetailed({ document: doc, window: win }, cfg);
  await settle(2);
  scripts[0].onerror();
  assert.equal((await first).reason, "no-library");
  const second = widget.captureScreenshotDetailed({ document: doc, window: win }, cfg);
  await settle(2);
  assert.equal(scripts.length, 2, "the failure was not cached");
  scripts[1].onerror();
  await second;
});

test("html2canvasUrl: a script that hangs is bounded by the capture timeout", async () => {
  const doc = makeDom();
  const r = await widget.captureScreenshotDetailed({ document: doc, window: {} }, Object.assign({}, CFG, { captureTimeoutMs: 30, html2canvasUrl: "/hang.js" }));
  assert.equal(r.reason, "timeout");
});

test("without html2canvasUrl nothing is ever injected (1.5.0 behaviour)", async () => {
  const doc = makeDom();
  let injected = 0;
  const orig = doc.createElement;
  doc.createElement = (tag) => { if (tag === "script") injected++; return orig(tag); };
  const r = await widget.captureScreenshotDetailed({ document: doc, window: {} }, CFG);
  assert.equal(r.reason, "no-library");
  assert.equal(injected, 0);
});

// ── what the modal, the POST and the app's hook get ─────────────────────────

function modalHarness(html2canvas, config) {
  const doc = makeDom();
  const events = [], posts = [];
  const ctl = widget.createController({
    document: doc,
    window: { location: { href: "https://e.test/a?tab=review", pathname: "/a", search: "?tab=review" }, navigator: { userAgent: "t" } },
    fetch: (u, init) => { posts.push(JSON.parse(init.body)); return new Promise(() => {}); },
    html2canvas,
    config: Object.assign({ captureTimeoutMs: 40, captureLateWatchMs: 20, onClientEvent: (k, d) => events.push({ k, d }) }, config || {}),
  });
  return { doc, ctl, events, posts, q: (s) => doc.getElementById("bug-report-modal" + s) };
}

test("the modal says why there is no screenshot, the POST carries it, and the app's hook is told", async () => {
  const h = modalHarness(() => Promise.resolve(canvasOf([255, 255, 255, 255])));
  h.ctl.openModal();
  await settle(15);
  assert.equal(h.q("-hint").textContent, "Screenshot unavailable (capture came back blank) — you can still submit text.");
  h.q("-textarea").value = "x";
  h.q("-submit").click();
  assert.equal(h.posts[0].screenshot, null);
  assert.equal(h.posts[0].screenshotError, "capture came back blank");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].k, "screenshot-failure");
  assert.equal(h.events[0].d.reason, "blank");
  assert.match(h.events[0].d.message, /^capture came back blank; page \?tab=review/);
});

test("a timeout event waits for the late render and reports how long it took", async () => {
  let finish;
  const h = modalHarness(() => new Promise((r) => { finish = r; }), { captureLateWatchMs: 500 });
  h.ctl.openModal();
  await settle(70);
  assert.equal(h.events.length, 0, "not yet: the render has not finished");
  finish(canvasOf([1, 2, 3, 255]));
  await settle(10);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].d.reason, "timeout");
  assert.match(h.events[0].d.message, /render finished after \d+ms/);
});

test("a good capture sends no screenshotError and fires no event", async () => {
  const h = modalHarness(() => Promise.resolve(canvasOf([1, 2, 3, 255])));
  h.ctl.openModal();
  await settle(15);
  h.q("-textarea").value = "x";
  h.q("-submit").click();
  assert.equal("screenshotError" in h.posts[0], false);
  assert.equal(h.events.length, 0);
});

test("a capture that lands after the modal was closed and reopened does not overwrite the new one", async () => {
  let finishFirst;
  let n = 0;
  const h = modalHarness(() => (++n === 1 ? new Promise((r) => { finishFirst = r; }) : Promise.resolve(canvasOf([1, 2, 3, 255]))),
    { captureTimeoutMs: 500 });
  h.ctl.openModal();
  h.ctl.closeModal();
  h.ctl.openModal();
  await settle(10);
  const second = h.ctl._state().capturedDataUrl;
  assert.ok(second);
  finishFirst(canvasOf([7, 7, 7, 255], { toDataURL: () => "data:image/png;base64,STALE" }));
  await settle(10);
  assert.equal(h.ctl._state().capturedDataUrl, second);
});

test("buildPostBody: clientKey and screenshotError are optional, capped, and screenshotError only without a screenshot", () => {
  const b = widget.buildPostBody({ details: "d" });
  assert.equal("clientKey" in b, false);
  assert.equal("screenshotError" in b, false);
  assert.equal(widget.buildPostBody({ details: "d", clientKey: "k".repeat(100) }).clientKey.length, 64);
  assert.equal(widget.buildPostBody({ details: "d", screenshotError: "e".repeat(300) }).screenshotError.length, 200);
  assert.equal("screenshotError" in widget.buildPostBody({ details: "d", screenshot: "data:x", screenshotError: "e" }), false);
});

test("formatBytes and newClientKey", () => {
  assert.equal(widget.formatBytes(0), "0 B");
  assert.equal(widget.formatBytes(2048), "2 KB");
  assert.equal(widget.formatBytes(1.2 * 1024 * 1024), "1.2 MB");
  assert.match(widget.newClientKey({ crypto: { randomUUID: () => "123e4567-e89b-12d3-a456-426614174000" } }), /^[0-9a-f-]{36}$/);
  assert.match(widget.newClientKey({}), /^k[0-9a-f]+$/);
  assert.notEqual(widget.newClientKey({}), widget.newClientKey({}));
});
