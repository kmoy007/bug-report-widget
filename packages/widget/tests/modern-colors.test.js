// html2canvas 1.4.1 throws on any colour function newer than rgb(a)/hsl(a), and
// browsers report a color-mix() result as `color(srgb …)`: one tinted badge failed
// the whole capture (PlacementImageViewer bug-20261012-185703). The widget rewrites
// those values in html2canvas's cloned page before it reads them.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");
const { makeDom } = require("./fake-dom.js");

const MIX = "color(srgb 0.18 0.604 0.31 / 0.16)";
const fake = (fn) => (fn === MIX ? "rgba(46, 154, 79, 0.161)" : fn.startsWith("oklch") ? "rgba(1, 2, 3, 1)" : null);

test("plainColors: a value with no modern colour is returned as it was", () => {
  for (const v of ["rgb(1, 2, 3)", "rgba(0, 0, 0, 0)", "#fff", "none", "", "1px solid rgb(4, 5, 6)"]) {
    assert.equal(widget.plainColors(v, () => "x"), v);
  }
  assert.equal(widget.plainColors(undefined, () => "x"), undefined);
});

test("plainColors: each modern colour function becomes the rgba() it resolves to", () => {
  assert.equal(widget.plainColors(MIX, fake), "rgba(46, 154, 79, 0.161)");
  assert.equal(widget.plainColors(`0 0 0 1px ${MIX}, 0 1px 2px ${MIX}`, fake),
               "0 0 0 1px rgba(46, 154, 79, 0.161), 0 1px 2px rgba(46, 154, 79, 0.161)");
  assert.equal(widget.plainColors("linear-gradient(oklch(0.7 0.1 200), rgb(0, 0, 0))", fake),
               "linear-gradient(rgba(1, 2, 3, 1), rgb(0, 0, 0))");
});

test("plainColors: a nested function is one match, and one that cannot be resolved is left alone", () => {
  const nested = "color-mix(in srgb, oklch(0.7 0.1 200) 16%, transparent)";
  const seen = [];
  widget.plainColors(nested, (fn) => { seen.push(fn); return null; });
  assert.deepEqual(seen, [nested]);
  assert.equal(widget.plainColors(nested, () => null), nested);
});

test("plainColorsInClone: pins a computed modern colour as an inline rgba(), via one canvas pixel", () => {
  const set = [];
  const badge = { style: { setProperty: (p, v, prio) => set.push([p, v, prio]) } };
  const plain = { style: { setProperty: (p, v, prio) => set.push(["plain:" + p, v, prio]) } };
  const ctx = {
    fillStyle: "#000000",
    clearRect() {}, fillRect() {},
    getImageData: () => ({ data: [46, 154, 79, 41] }),
  };
  const clone = {
    defaultView: {
      getComputedStyle: (el) => ({
        getPropertyValue: (p) => (el === badge && p === "background-color" ? MIX : p === "color" ? "rgb(0, 0, 0)" : ""),
      }),
    },
    createElement: () => ({ getContext: () => ctx }),
    getElementsByTagName: () => [badge, plain],
  };
  widget.plainColorsInClone(clone);
  assert.deepEqual(set, [["background-color", "rgba(46, 154, 79, 0.161)", "important"]]);
});

test("plainColorsInClone: no window or no canvas is not an error", () => {
  widget.plainColorsInClone(null);
  widget.plainColorsInClone({ defaultView: null });
  const el = { style: { setProperty: () => assert.fail("nothing resolves without a canvas") } };
  widget.plainColorsInClone({
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => MIX }) },
    createElement: () => { throw new Error("no canvas"); },
    getElementsByTagName: () => [el],
  });
});

test("the capture hands html2canvas the clone hook", async () => {
  let got;
  const h2c = (el, opts) => {
    got = opts;
    return Promise.resolve({
      width: 4, height: 4,
      getContext: () => ({ getImageData: () => ({ data: [9, 9, 9, 255] }) }),
      toDataURL: () => "data:image/png;base64,QUJD",
    });
  };
  const cfg = Object.assign({}, widget.DEFAULTS, { captureTimeoutMs: 200 });
  await widget.captureScreenshotDetailed({ html2canvas: h2c, document: makeDom() }, cfg);
  assert.equal(got.onclone, widget.plainColorsInClone);
});

// A 1x1 canvas that behaves like one where it matters: a colour it cannot parse is
// ignored (fillStyle keeps its value) and a translucent fill blends over what is there.
function realishCanvas(known) {
  const SENTINEL = "rgba(1, 2, 3, 0.5)";
  let fill = "#000000", px = [0, 0, 0, 0];
  const ctx = {
    get fillStyle() { return fill; },
    set fillStyle(v) { if (v === SENTINEL || v in known) fill = v; },
    clearRect() { px = [0, 0, 0, 0]; },
    fillRect() {
      const c = fill === SENTINEL ? [1, 2, 3, 128] : known[fill];
      const a = c[3] / 255, b = px[3] / 255, out = a + b * (1 - a);
      px = out ? [0, 1, 2].map((i) => Math.round((c[i] * a + px[i] * b * (1 - a)) / out)).concat(Math.round(out * 255))
               : [0, 0, 0, 0];
    },
    getImageData: () => ({ data: px.slice() }),
  };
  return { getContext: () => ctx };
}

test("plainColorsInClone: each colour is read on a cleared pixel, and one the canvas rejects is left alone", () => {
  const MIX2 = "color(srgb 0.851 0.467 0.024 / 0.16)";
  const canvas = realishCanvas({ [MIX]: [46, 154, 79, 41], [MIX2]: [217, 119, 6, 41] });
  const els = [MIX, MIX2, "oklch(not a colour)"].map((bg) => ({ bg, set: [], style: {} }));
  els.forEach((e) => { e.style.setProperty = (p, v) => e.set.push([p, v]); });
  widget.plainColorsInClone({
    defaultView: { getComputedStyle: (el) => ({ getPropertyValue: (p) => (p === "background-color" ? el.bg : "") }) },
    createElement: () => canvas,
    getElementsByTagName: () => els,
  });
  assert.deepEqual(els[0].set, [["background-color", "rgba(46, 154, 79, 0.161)"]]);
  assert.deepEqual(els[1].set, [["background-color", "rgba(217, 119, 6, 0.161)"]], "blended over the last colour");
  assert.deepEqual(els[2].set, [], "a colour the canvas rejected must not become the sentinel");
});
