// 1.6.0 viewer: pinch-zoom, a second finger is ignored while drawing, marks are
// drawn on an overlay (the image is never repainted per pointermove), the file
// is composited once on Done, and the toolbar clears a notch.
//
// Driven through the real openViewer with a fake DOM whose canvases record what
// is drawn on them. Real touch input and real rendering are a browser's job
// (the consuming apps' Playwright suites).

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");
const { makeDom } = require("./fake-dom.js");

// A viewer on a 400×300 image, in an 800×600 stage (so fit = 100%, centred at 200,150).
function open(opts) {
  const doc = makeDom();
  const canvases = [];
  const orig = doc.createElement;
  doc.createElement = (tag) => {
    const e = orig(tag);
    if (tag === "canvas") canvases.push(e);
    if (tag === "img") {
      let src = "";
      e.naturalWidth = 400; e.naturalHeight = 300;
      Object.defineProperty(e, "src", { get: () => src, set: (v) => { src = v; queueMicrotask(() => e.onload && e.onload()); } });
    }
    return e;
  };
  const done = [];
  widget._openViewer({ document: doc, window: {} }, "data:image/png;base64,AAAA",
    Object.assign({ annotate: true, onDone: (url, strokes) => done.push({ url, strokes }) }, opts || {}));
  return new Promise((res) => setImmediate(() => {
    const root = doc.getElementById(widget.VIEWER_ID);
    const [bar, stage] = root.children;
    const [img, ov] = stage.children[0].children;
    const ptr = (type, id, x, y) => stage.dispatch(type, { pointerId: id, clientX: x, clientY: y });
    res({
      doc, root, bar, stage, layer: stage.children[0], img, ov, canvases, done, ptr,
      btn: (id) => doc.getElementById(widget.VIEWER_ID + "-" + id),
      ctx: ov.getContext("2d"),
      view: () => {
        const m = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(stage.children[0].style.transform);
        return { tx: +m[1], ty: +m[2], z: +m[3] };
      },
    });
  }));
}

test("the viewer opens fitted and centred, with marks on an overlay canvas above the image", async () => {
  const v = await open();
  assert.deepEqual(v.view(), { tx: 200, ty: 150, z: 1 });
  assert.equal(v.ov.width, 400);
  assert.equal(v.ov.style.cssText.includes("pointer-events:none"), true);
  assert.equal(v.ctx.count("drawImage"), 0, "the image is an <img>, never painted onto the marks canvas");
});

test("drawing with the pen paints only the new segment: no repaint of the image, no clear", async () => {
  const v = await open();
  v.ptr("pointerdown", 1, 300, 250);
  const before = v.ctx.calls.length;
  for (let i = 1; i <= 20; i++) v.ptr("pointermove", 1, 300 + i * 5, 250 + i);
  assert.equal(v.ctx.count("drawImage"), 0);
  assert.equal(v.ctx.count("clearRect"), 1, "only the initial clear from the first paint, none per move");
  assert.equal(v.ctx.calls.length - before, 20 * 4, "beginPath, moveTo, lineTo, stroke per move: constant work");
  v.ptr("pointerup", 1, 400, 270);
});

test("dragging a box repaints the overlay (marks only), never the image", async () => {
  const v = await open();
  v.btn("box").click();
  v.ptr("pointerdown", 1, 300, 250);
  const clears = v.ctx.count("clearRect");
  v.ptr("pointermove", 1, 350, 280);
  v.ptr("pointermove", 1, 360, 290);
  assert.equal(v.ctx.count("clearRect") - clears, 2);
  assert.equal(v.ctx.count("strokeRect") >= 2, true);
  assert.equal(v.ctx.count("drawImage"), 0);
});

test("a second finger while drawing is ignored — the mark continues, and it does not become a pinch", async () => {
  const v = await open();
  v.ptr("pointerdown", 1, 300, 250);
  v.ptr("pointerdown", 2, 500, 450);              // a resting palm
  v.ptr("pointermove", 2, 700, 500);              // must not extend the stroke
  v.ptr("pointermove", 1, 320, 255);
  v.ptr("pointerup", 2, 700, 500);                // must not end the stroke
  v.ptr("pointermove", 1, 340, 260);
  v.ptr("pointerup", 1, 340, 260);
  v.btn("done").click();
  assert.equal(v.done.length, 1);
  const pts = v.done[0].strokes[0].pts;
  assert.equal(v.done[0].strokes.length, 1);
  assert.equal(pts.length, 3, "down + two moves of the first finger only");
  assert.deepEqual(v.view(), { tx: 200, ty: 150, z: 1 }, "no zoom happened");
});

test("with the Move tool, two fingers pinch-zoom about their midpoint", async () => {
  const v = await open();
  v.btn("move").click();
  v.ptr("pointerdown", 1, 300, 300);
  v.ptr("pointerdown", 2, 400, 300);              // 100 apart, midpoint (350, 300)
  v.ptr("pointermove", 1, 250, 300);
  v.ptr("pointermove", 2, 450, 300);              // 200 apart: x2, midpoint unchanged
  const z = v.view();
  assert.equal(z.z, 2);
  // the image point that was under the midpoint is still under it
  assert.equal((350 - z.tx) / z.z, (350 - 200) / 1);
  assert.equal((300 - z.ty) / z.z, (300 - 150) / 1);
});

test("one finger pans; lifting one finger of a pinch carries on panning with the other, without a jump", async () => {
  const v = await open();
  v.btn("move").click();
  v.ptr("pointerdown", 1, 100, 100);
  v.ptr("pointermove", 1, 130, 110);
  assert.deepEqual(v.view(), { tx: 230, ty: 160, z: 1 });
  v.ptr("pointerup", 1, 130, 110);
  v.ptr("pointerdown", 1, 300, 300);
  v.ptr("pointerdown", 2, 400, 300);
  v.ptr("pointermove", 2, 500, 300);              // pinch
  v.ptr("pointerup", 1, 300, 300);                // finger 1 lifts
  const after = v.view();
  v.ptr("pointermove", 2, 510, 305);              // finger 2 keeps going: a pure pan of (10, 5)
  const moved = v.view();
  assert.equal(moved.z, after.z);
  assert.equal(moved.tx - after.tx, 10);
  assert.equal(moved.ty - after.ty, 5);
});

test("a third finger is ignored", async () => {
  const v = await open();
  v.btn("move").click();
  v.ptr("pointerdown", 1, 300, 300);
  v.ptr("pointerdown", 2, 400, 300);
  v.ptr("pointerdown", 3, 100, 100);
  v.ptr("pointermove", 3, 0, 0);
  assert.deepEqual(v.view(), { tx: 200, ty: 150, z: 1 });
});

test("pinchView: scale follows finger distance, clamped, and a degenerate start leaves the view alone", () => {
  const v0 = { z: 1, tx: 0, ty: 0 };
  const p = (x, y) => ({ x, y });
  assert.equal(widget.pinchView(v0, p(0, 0), p(100, 0), p(0, 0), p(300, 0)).z, 3);
  assert.equal(widget.pinchView(v0, p(0, 0), p(100, 0), p(0, 0), p(1e9, 0)).z, 16);
  assert.equal(widget.pinchView(v0, p(0, 0), p(100, 0), p(0, 0), p(1, 0)).z, 0.1);
  assert.deepEqual(widget.pinchView(v0, p(5, 5), p(5, 5), p(0, 0), p(9, 9)), v0);
  // both fingers translate together: pure pan
  const pan = widget.pinchView(v0, p(0, 0), p(100, 0), p(20, 30), p(120, 30));
  assert.deepEqual(pan, { z: 1, tx: 20, ty: 30 });
});

test("Done composites the image and the marks once, and hands back the strokes", async () => {
  const v = await open();
  v.ptr("pointerdown", 1, 300, 250);
  v.ptr("pointermove", 1, 320, 250);
  v.ptr("pointerup", 1, 320, 250);
  const made = v.canvases.length;
  v.btn("done").click();
  assert.equal(v.canvases.length, made + 1, "one flattened canvas, made at Done");
  const flat = v.canvases[v.canvases.length - 1];
  assert.equal(flat.getContext("2d").count("drawImage"), 2, "image, then marks");
  assert.equal(v.done.length, 1);
  assert.match(v.done[0].url, /^data:image\/png/);
  assert.equal(v.done[0].strokes.length, 1);
  assert.equal(v.doc.getElementById(widget.VIEWER_ID), null, "closed");
});

test("Done with no marks reports null, and Cancel reports nothing", async () => {
  const a = await open();
  a.btn("done").click();
  assert.deepEqual(a.done, [{ url: null, strokes: [] }]);
  const b = await open();
  b.btn("cancel").click();
  assert.equal(b.done.length, 0);
});

test("Undo and Clear repaint the overlay only", async () => {
  const v = await open();
  v.ptr("pointerdown", 1, 300, 250); v.ptr("pointerup", 1, 300, 250);
  v.btn("undo").click();
  v.btn("clear").click();
  assert.equal(v.ctx.count("drawImage"), 0);
  v.btn("done").click();
  assert.equal(v.done[0].url, null, "nothing left to keep");
});

test("pointercancel throws the half-drawn mark away", async () => {
  const v = await open();
  v.ptr("pointerdown", 1, 300, 250);
  v.ptr("pointermove", 1, 320, 250);
  v.ptr("pointercancel", 1, 320, 250);
  v.btn("done").click();
  assert.equal(v.done[0].url, null);
});

test("the toolbar and the viewer keep clear of a notch and the home indicator", async () => {
  const v = await open();
  const bar = v.bar.style.cssText;
  assert.match(bar, /safe-area-inset-top/);
  assert.match(bar, /safe-area-inset-left/);
  assert.match(bar, /safe-area-inset-right/);
  assert.match(v.root.style.cssText, /padding-bottom:env\(safe-area-inset-bottom/);
});

test("Escape closes the viewer and is consumed, so a host <dialog> around it stays open", async () => {
  const v = await open();
  const ev = v.doc.dispatch("keydown", { key: "Escape" });
  assert.equal(v.doc.getElementById(widget.VIEWER_ID), null);
  assert.equal(ev.defaultPrevented, true);
});

test("the viewer keeps its fixed id and the exclude attribute, whatever the idPrefix", async () => {
  const v = await open();
  assert.equal(v.root.id, "bug-report-viewer");
  assert.equal(v.root.getAttribute("data-bug-report-exclude"), "true");
  assert.ok(v.btn("done") && v.btn("move"), "toolbar button ids hang off the same id");
});
