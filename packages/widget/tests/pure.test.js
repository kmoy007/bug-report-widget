// Unit tests for the pure helpers (no DOM, runs in plain Node).
//
// The controller + DOM construction live in ../src/bug-report.js but are
// exercised end-to-end by ../../e2e/contract.spec.ts. Here we cover only
// the parts that work without a browser.

const test = require("node:test");
const assert = require("node:assert/strict");

const widget = require("../src/bug-report.js");

test("module exports the public surface", () => {
  for (const k of ["init", "createController", "buildPostBody", "isBlankCanvas", "captureScreenshot", "DEFAULTS"]) {
    assert.equal(typeof widget[k], k === "DEFAULTS" ? "object" : "function", `missing ${k}`);
  }
});

test("buildPostBody: title defaults to first line of details", () => {
  const body = widget.buildPostBody({ details: "first line\nsecond line\nthird" });
  assert.equal(body.title, "first line");
});

test("buildPostBody: details capped at 10KB", () => {
  const huge = "x".repeat(20 * 1024);
  const body = widget.buildPostBody({ details: huge });
  assert.equal(body.details.length, 10 * 1024);
});

test("buildPostBody: explicit title wins over derived", () => {
  const body = widget.buildPostBody({ title: "my title", details: "ignore me" });
  assert.equal(body.title, "my title");
});

test("buildPostBody: tags defaults to ['bug']", () => {
  assert.deepEqual(widget.buildPostBody({ details: "x" }).tags, ["bug"]);
});

test("buildPostBody: tags array passed through", () => {
  assert.deepEqual(
    widget.buildPostBody({ details: "x", tags: ["bug", "agent-self-report"] }).tags,
    ["bug", "agent-self-report"]
  );
});

test("buildPostBody: addedBy defaults to web", () => {
  assert.equal(widget.buildPostBody({ details: "x" }).addedBy, "web");
});

test("buildPostBody: meta fields pass through", () => {
  const b = widget.buildPostBody({
    details: "x",
    metaUrl: "https://example.com/x",
    metaUserAgent: "Mozilla/5.0 …",
    metaBuildSha: "abc1234",
  });
  assert.equal(b.metaUrl, "https://example.com/x");
  assert.equal(b.metaUserAgent, "Mozilla/5.0 …");
  assert.equal(b.metaBuildSha, "abc1234");
});

test("isBlankCanvas: null / undefined => true", () => {
  assert.equal(widget.isBlankCanvas(null), true);
  assert.equal(widget.isBlankCanvas(undefined), true);
  assert.equal(widget.isBlankCanvas({}), true);
});

test("isBlankCanvas: zero-size canvas => true", () => {
  const fakeCanvas = { width: 0, height: 0, getContext: () => ({ getImageData: () => ({ data: [0, 0, 0, 0] }) }) };
  assert.equal(widget.isBlankCanvas(fakeCanvas), true);
});

test("isBlankCanvas: all transparent => true", () => {
  const fakeCanvas = {
    width: 100, height: 100,
    getContext: () => ({ getImageData: () => ({ data: [0, 0, 0, 0] }) }),
  };
  assert.equal(widget.isBlankCanvas(fakeCanvas), true);
});

test("isBlankCanvas: all white => true (Safari blank-canvas case)", () => {
  const fakeCanvas = {
    width: 100, height: 100,
    getContext: () => ({ getImageData: () => ({ data: [255, 255, 255, 255] }) }),
  };
  assert.equal(widget.isBlankCanvas(fakeCanvas), true);
});

test("isBlankCanvas: at least one non-white opaque pixel => false", () => {
  let calls = 0;
  const fakeCanvas = {
    width: 100, height: 100,
    getContext: () => ({
      getImageData: () => {
        calls += 1;
        // 5th sample is non-white, opaque blue.
        if (calls === 5) return { data: [12, 34, 56, 255] };
        return { data: [255, 255, 255, 255] };
      },
    }),
  };
  assert.equal(widget.isBlankCanvas(fakeCanvas), false);
});

test("isBlankCanvas: getContext throwing => true (defensive)", () => {
  const fakeCanvas = {
    width: 100, height: 100,
    getContext: () => { throw new Error("tainted"); },
  };
  assert.equal(widget.isBlankCanvas(fakeCanvas), true);
});

test("captureScreenshot: returns null when html2canvas absent", async () => {
  const result = await widget.captureScreenshot({ html2canvas: null, document: {} }, widget.DEFAULTS);
  assert.equal(result, null);
});

test("captureScreenshot: returns null on rejected promise", async () => {
  const fake = {
    html2canvas: () => Promise.reject(new Error("boom")),
    document: { body: {} },
  };
  const result = await widget.captureScreenshot(fake, { ...widget.DEFAULTS, captureTimeoutMs: 100 });
  assert.equal(result, null);
});

test("captureScreenshot: returns null on hang via timeout", async () => {
  const fake = {
    html2canvas: () => new Promise(() => {}),  // never resolves
    document: { body: {} },
  };
  const t0 = Date.now();
  const result = await widget.captureScreenshot(fake, { ...widget.DEFAULTS, captureTimeoutMs: 60 });
  const elapsed = Date.now() - t0;
  assert.equal(result, null);
  assert.ok(elapsed >= 50 && elapsed < 500, `timeout fired too slowly: ${elapsed}ms`);
});

// --- same-origin iframe compositing -------------------------------------
// html2canvas renders an <iframe> as a blank rectangle, so a page whose main
// content is framed screenshots as empty. captureScreenshot now re-renders
// same-origin frames and pastes them into the parent capture.

function fakeCanvas(drawn) {
  return {
    width: 200, height: 100,
    getContext: () => ({
      drawImage: (...a) => drawn.push(a),
      // isBlankCanvas probes pixels — report one opaque non-white pixel so the
      // capture is treated as real content
      getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }),
    }),
    toDataURL: () => "data:image/png;base64,MERGED",
  };
}

function fakeIframe(rect, innerDoc, attrs = {}) {
  return {
    contentDocument: innerDoc,
    getBoundingClientRect: () => rect,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}

test("captureScreenshot: composites a same-origin iframe into the capture", async () => {
  const drawn = [];
  const inner = { body: { tag: "inner-body" } };
  const doc = {
    body: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    querySelectorAll: () => [fakeIframe({ left: 10, top: 20, width: 80, height: 40 }, inner)],
  };
  const seen = [];
  const fake = {
    html2canvas: (el, opts) => { seen.push(el); return Promise.resolve(fakeCanvas(drawn)); },
    document: doc,
  };
  const out = await widget.captureScreenshot(fake, { ...widget.DEFAULTS, captureTimeoutMs: 2000 });
  assert.equal(out, "data:image/png;base64,MERGED");
  assert.ok(seen.includes(inner.body), "inner iframe body was never rendered");
  assert.equal(drawn.length, 1, "iframe canvas was not pasted into the parent");
});

test("captureScreenshot: cross-origin iframe is skipped, capture still returned", async () => {
  const drawn = [];
  const hostile = {
    get contentDocument() { throw new Error("cross-origin"); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 50, height: 50 }),
    getAttribute: () => null,
  };
  const doc = {
    body: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    querySelectorAll: () => [hostile],
  };
  const fake = { html2canvas: () => Promise.resolve(fakeCanvas(drawn)), document: doc };
  const out = await widget.captureScreenshot(fake, { ...widget.DEFAULTS, captureTimeoutMs: 2000 });
  assert.equal(out, "data:image/png;base64,MERGED");
  assert.equal(drawn.length, 0, "cross-origin frame must not be drawn");
});

test("captureScreenshot: a failing iframe render does not lose the screenshot", async () => {
  const drawn = [];
  const inner = { body: { tag: "inner" } };
  const doc = {
    body: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    querySelectorAll: () => [fakeIframe({ left: 0, top: 0, width: 10, height: 10 }, inner)],
  };
  let first = true;
  const fake = {
    html2canvas: () => {
      if (first) { first = false; return Promise.resolve(fakeCanvas(drawn)); }
      return Promise.reject(new Error("inner boom"));   // the iframe render fails
    },
    document: doc,
  };
  const out = await widget.captureScreenshot(fake, { ...widget.DEFAULTS, captureTimeoutMs: 2000 });
  assert.equal(out, "data:image/png;base64,MERGED", "parent capture must survive");
});

test("DEFAULTS exposes a configurable buttonSize", () => {
  assert.equal(typeof widget.DEFAULTS.buttonSize, "number");
});
