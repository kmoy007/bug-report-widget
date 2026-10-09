// capture-engine.js: the pure parts (the "drew nothing" check and the options
// handed to html-to-image) and the wrapper's fallback to the real html2canvas.
// html-to-image itself, and what it renders, are a browser's business.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ENGINE = path.join(__dirname, "../src/capture-engine.js");
const pure = require(ENGINE);          // no window in Node: exports the pure parts

function canvas(w, h, pixelAt) {
  return { width: w, height: h, getContext: () => ({ getImageData: (x, y) => ({ data: pixelAt(x, y) }) }) };
}
const WHITE = [255, 255, 255, 255];

test("blank: all white is blank", () => {
  assert.equal(pure.blank(canvas(100, 80, () => WHITE)), true);
});

test("blank: one non-white sample among the 64 makes it not blank", () => {
  // on the grid: x = floor(0.5*100/8) = 6, y = floor(0.5*80/8) = 5
  const onGrid = canvas(100, 80, (x, y) => (x === 6 && y === 5 ? [0, 0, 0, 255] : WHITE));
  assert.equal(pure.blank(onGrid), false);
  const offGrid = canvas(100, 80, (x, y) => (x === 7 && y === 5 ? [0, 0, 0, 255] : WHITE));
  assert.equal(pure.blank(offGrid), true, "a sample, not a scan: a pixel between samples is not seen");
});

test("blank: every sample stays inside the canvas, even a 1x1 one", () => {
  const seen = [];
  pure.blank(canvas(1, 1, (x, y) => { seen.push([x, y]); return WHITE; }));
  assert.ok(seen.length === 64 && seen.every(([x, y]) => x === 0 && y === 0));
});

test("blank: unreadable pixels count as NOT blank (a fallback render would not read them better)", () => {
  const c = { width: 10, height: 10, getContext: () => { throw new Error("tainted"); } };
  assert.equal(pure.blank(c), false);
});

test("toImageOptions: scale becomes pixelRatio; a crop becomes width/height and a shifting transform", () => {
  const o = pure.toImageOptions({ scale: 2, x: 30, y: 400, width: 800, height: 600 });
  assert.equal(o.pixelRatio, 2);
  assert.equal(o.width, 800);
  assert.equal(o.height, 600);
  assert.equal(o.style.transform, "translate(-30px,-400px)");
  const plain = pure.toImageOptions({});
  assert.equal(plain.pixelRatio, 1);
  assert.equal("style" in plain, false);
});

test("toImageOptions: the filter drops ignored elements and nodes far below the fold, keeps the rest", () => {
  const o = pure.toImageOptions({ height: 600, ignoreElements: (n) => n.id === "bug-report-button" });
  const el = (id, top) => ({ nodeType: 1, id, getBoundingClientRect: () => ({ top }) });
  assert.equal(o.filter({ nodeType: 3 }), true, "text nodes pass");
  assert.equal(o.filter(el("bug-report-button", 10)), false, "the widget itself is not drawn");
  assert.equal(o.filter(el("row", 100)), true);
  assert.equal(o.filter(el("row", 800)), false, "starts more than 100px below the visible area");
  assert.equal(o.filter(el("row", -5000)), true, "above the area stays: removing it would shift the content");
});

// The installed wrapper: needs a window with html2canvas and htmlToImage.
function install(h2i, real) {
  global.window = { html2canvas: real, htmlToImage: h2i };
  global.getComputedStyle = () => ({ getPropertyValue: () => "" });
  delete require.cache[require.resolve(ENGINE)];
  require(ENGINE);
  return global.window.html2canvas;
}
function uninstall() {
  delete global.window; delete global.getComputedStyle;
  delete require.cache[require.resolve(ENGINE)];
}
const el = { querySelectorAll: () => [] };

test("wrapper: a drawn page comes from html-to-image, and html2canvas is not consulted", async () => {
  let realCalls = 0;
  const drawn = canvas(10, 10, () => [0, 0, 0, 255]);
  const h2c = install({ toCanvas: () => Promise.resolve(drawn) }, () => { realCalls++; return Promise.resolve("real"); });
  try {
    assert.equal(await h2c(el, { scale: 1 }), drawn);
    assert.equal(realCalls, 0);
  } finally { uninstall(); }
});

test("wrapper: a blank render falls back to the real html2canvas", async () => {
  const h2c = install({ toCanvas: () => Promise.resolve(canvas(10, 10, () => WHITE)) }, () => Promise.resolve("real"));
  try { assert.equal(await h2c(el, {}), "real"); } finally { uninstall(); }
});

test("wrapper: a render that throws falls back to the real html2canvas, with the caller's options", async () => {
  let got;
  const h2c = install({ toCanvas: () => Promise.reject(new Error("boom")) }, (e, o) => { got = o; return Promise.resolve("real"); });
  try {
    assert.equal(await h2c(el, { scale: 2 }), "real");
    assert.equal(got.scale, 2);
  } finally { uninstall(); }
});

test("wrapper: not installed when either library is missing", () => {
  const real = () => {};
  global.window = { html2canvas: real };
  delete require.cache[require.resolve(ENGINE)];
  require(ENGINE);
  try { assert.equal(global.window.html2canvas, real); } finally { uninstall(); }
});
