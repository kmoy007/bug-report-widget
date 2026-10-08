// Zoom maths and the marked-up screenshot.
//
// The viewer is DOM and canvas, which Node has neither of, so what is tested
// here is the part that decides what gets FILED: the view maths, and that a
// marked-up image replaces the capture in the POST. The drawing itself is
// driven in a real browser by the consuming apps' e2e suites.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");

test("fitView centres the image and never enlarges past 100%", () => {
  assert.deepEqual(widget.fitView(1000, 500, 200, 100), { z: 1, tx: 400, ty: 200 });
  const v = widget.fitView(500, 500, 1000, 500);       // too wide: scale to the width
  assert.equal(v.z, 0.5);
  assert.equal(v.tx, 0);
  assert.equal(v.ty, 125);
});

test("zooming about a point keeps that point still on screen", () => {
  const v0 = { z: 1, tx: 10, ty: 20 };
  const v1 = widget.zoomAbout(v0, 300, 200, 2);
  // the image point under (300,200) before and after
  const before = [(300 - v0.tx) / v0.z, (200 - v0.ty) / v0.z];
  const after = [(300 - v1.tx) / v1.z, (200 - v1.ty) / v1.z];
  assert.deepEqual(after, before);
  assert.equal(v1.z, 2);
});

test("zoom is clamped", () => {
  assert.equal(widget.zoomAbout({ z: 1, tx: 0, ty: 0 }, 0, 0, 1e9).z, 16);
  assert.equal(widget.zoomAbout({ z: 1, tx: 0, ty: 0 }, 0, 0, 1e-9).z, 0.1);
});

// ── the controller, as double-submit.test.js drives it ──────────────────────
function makeDoc() {
  const byId = new Map();
  function el(tag) {
    const node = {
      tagName: tag, children: [], style: {}, dataset: {}, _listeners: {}, _attrs: {},
      textContent: "", value: "", disabled: false,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      removeEventListener() {},
      click() { (this._listeners.click || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {} })); },
      focus() {}, remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
    Object.defineProperty(node, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; byId.set(v, this); },
    });
    return node;
  }
  return { body: el("body"), documentElement: el("html"), createElement: el,
    getElementById: (id) => byId.get(id) || null, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    _find: (s) => [...byId.entries()].find(([k]) => k.endsWith(s))?.[1] || null };
}

test("a marked-up screenshot is what gets filed", () => {
  const doc = makeDoc(), posts = [];
  const ctl = widget.createController({
    document: doc,
    window: { location: { href: "https://example.test/" }, navigator: { userAgent: "t" } },
    fetch: (url, init) => { posts.push(JSON.parse(init.body)); return new Promise(() => {}); },
    html2canvas: null, config: { endpoint: "/api/bugs" },
  });
  ctl.openModal();
  ctl.applyMarkup("data:image/png;base64,MARKED");
  doc._find("-textarea").value = "circled the problem";
  doc._find("-submit").click();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].screenshot, "data:image/png;base64,MARKED");
  assert.equal(doc._find("-preview").src, "data:image/png;base64,MARKED");
});

test("markup that was cancelled (null) leaves the capture alone", () => {
  const doc = makeDoc();
  const ctl = widget.createController({
    document: doc, window: { location: { href: "x" }, navigator: {} },
    fetch: () => new Promise(() => {}), html2canvas: null, config: {},
  });
  ctl.openModal();
  ctl.applyMarkup(null);
  assert.equal(ctl._state().capturedDataUrl, null);
});
