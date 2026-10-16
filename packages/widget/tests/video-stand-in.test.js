// 1.6.6: a cross-origin <video> (no CORS) taints the canvas html-to-image draws it on, its
// toDataURL threw, and the whole capture was rejected (StoppageViewer bug-20261014-163549,
// bug-20261014-231951). The engine stands in an <img> for each visible video for the capture.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { makeDom } = require("./fake-dom.js");

const ENGINE = path.join(__dirname, "../src/capture-engine.js");
const pure = require(ENGINE);

test("fitRect: contain letterboxes, cover crops, fill and unknown stretch", () => {
  // a 200x100 picture in a 100x100 box
  assert.deepEqual(pure.fitRect("contain", 200, 100, 100, 100), { x: 0, y: 25, w: 100, h: 50 });
  assert.deepEqual(pure.fitRect("cover", 200, 100, 100, 100), { x: -50, y: 0, w: 200, h: 100 });
  assert.deepEqual(pure.fitRect("fill", 200, 100, 100, 100), { x: 0, y: 0, w: 100, h: 100 });
  for (const f of ["scale-down", "none", "", undefined, "bogus"]) {
    assert.deepEqual(pure.fitRect(f, 200, 100, 100, 50), { x: 0, y: 0, w: 100, h: 50 }, String(f));
  }
  assert.deepEqual(pure.fitRect("contain", 0, 0, 100, 50), { x: 0, y: 0, w: 100, h: 50 }, "no intrinsic size yet");
});

// A document whose canvases remember what was drawn; a canvas that had a video drawn on it
// throws from toDataURL when the video is tainted, as a real one does.
function setup(tainted) {
  const doc = makeDom();
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const e = create(tag);
    if (tag === "canvas") {
      e.getContext = () => {
        if (!e._ctx) {
          e._ctx = { calls: [], texts: [] };
          e._ctx.drawImage = function (v) { this.drew = v; this.calls.push(["drawImage"].concat([].slice.call(arguments, 1))); };
          e._ctx.fillRect = function () { this.calls.push(["fillRect"]); };
          e._ctx.fillText = function (t) { this.texts.push(t); };
        }
        return e._ctx;
      };
      e.toDataURL = () => {
        if (e._ctx && e._ctx.drew && tainted) throw new Error("SecurityError: Tainted canvases may not be exported");
        return e._ctx && e._ctx.texts.length ? "data:placeholder" : "data:frame";
      };
    }
    return e;
  };
  const box = doc.createElement("div");
  const video = doc.createElement("video");
  Object.assign(video, { currentSrc: "https://x/clip.mp4", clientWidth: 320, clientHeight: 180,
    videoWidth: 640, videoHeight: 360, readyState: 4, className: "clip" });
  video.style.cssText = "border:1px solid red";
  video.style.display = "block";
  box.appendChild(doc.createElement("span"));
  box.appendChild(video);
  return { doc, box, video };
}
const fill = () => "fill";

test("neverShown: html-to-image never clones a video with a source (it would taint the canvas)", () => {
  assert.equal(pure.neverShown({ nodeType: 1, nodeName: "VIDEO", currentSrc: "https://x/clip.mp4" }), true);
  assert.equal(pure.neverShown({ nodeType: 1, nodeName: "VIDEO", currentSrc: "" }), false, "poster-only video");
  const filter = pure.toImageOptions({}, "#fff").filter;
  assert.equal(filter({ nodeType: 1, nodeName: "VIDEO", currentSrc: "x", getBoundingClientRect: () => ({ top: 0 }) }), false);
});

test("standInVideos: a tainted video gets the dark placeholder tile, and restore puts it all back", () => {
  const { doc, box, video } = setup(true);
  const restore = pure.standInVideos([video], doc, fill);
  const img = box.children[1];
  assert.equal(img.tagName, "img");
  assert.equal(box.children[2], video, "the stand-in sits right before the video, which stays in the DOM");
  assert.equal(img.src, "data:placeholder");
  assert.equal(img.className, "clip");
  assert.equal(img.style.cssText, "border:1px solid red");
  assert.equal(img.style.width, "320px");
  assert.equal(img.style.height, "180px");
  assert.equal(video.style.display, "none");
  restore();
  assert.equal(video.style.display, "block");
  assert.deepEqual(box.children.map((c) => c.tagName), ["span", "video"]);
  assert.doesNotThrow(restore, "restoring twice is harmless");
});

test("standInVideos: the placeholder says why, on a dark tile", () => {
  const { doc, box, video } = setup(true);
  const create = doc.createElement;
  // the second canvas made is the placeholder
  const canvases = [];
  doc.createElement = (t) => { const e = create(t); if (t === "canvas") canvases.push(e); return e; };
  pure.standInVideos([video], doc, fill);
  const ctx = canvases[1]._ctx;
  assert.deepEqual(ctx.texts, ["Video not in screenshot (cross-origin)"]);
  assert.equal(ctx.fillStyle, "#bbb");
  assert.ok(ctx.calls.some((c) => c[0] === "fillRect"));
  assert.equal(box.children[1].src, "data:placeholder");
});

test("standInVideos: a clean video gets its frame, drawn into the object-fit rect", () => {
  const { doc, box, video } = setup(false);
  const restore = pure.standInVideos([video], doc, () => "contain");
  const img = box.children[1];
  assert.equal(img.src, "data:frame");
  restore();
  assert.equal(video.style.display, "block");
  assert.deepEqual(box.children.map((c) => c.tagName), ["span", "video"]);
});

test("standInVideos: an absolutely positioned video's place on the page is the stand-in's", () => {
  // #rvcam .evframe video { position:absolute; inset:0; margin:auto } is keyed on the element type
  const { doc, box, video } = setup(false);
  const computed = { position: "absolute", top: "0px", right: "0px", bottom: "0px", left: "0px",
    marginTop: "12px", marginRight: "40px", marginBottom: "12px", marginLeft: "40px", display: "block",
    zIndex: "3", boxSizing: "border-box", borderRadius: "8px", backgroundColor: "rgb(0, 0, 0)" };
  pure.standInVideos([video], doc, fill, (v) => { assert.equal(v, video); return computed; });
  const st = box.children[1].style;
  for (const k of Object.keys(computed)) assert.equal(st[k], computed[k], k);
  assert.equal(st.width, "320px");
  assert.equal(st.height, "180px");
});

test("standInVideos: no computed style to read is not a reason to fail", () => {
  const { doc, box, video } = setup(false);
  pure.standInVideos([video], doc, fill, () => { throw new Error("no gcs"); });
  assert.equal(box.children[1].tagName, "img");
});

test("standInVideos: a video with no frame yet gets its own tile, not a transparent picture", () => {
  for (const unready of [{ readyState: 1 }, { videoWidth: 0, videoHeight: 0 }]) {
    const { doc, box, video } = setup(false);
    Object.assign(video, unready);
    const canvases = [];
    const create = doc.createElement;
    doc.createElement = (t) => { const e = create(t); if (t === "canvas") canvases.push(e); return e; };
    pure.standInVideos([video], doc, fill);
    assert.equal(canvases.length, 1, "only the tile is made: the video is not drawn");
    assert.deepEqual(canvases[0]._ctx.texts, ["Video not loaded yet"]);
    assert.equal(canvases[0]._ctx.drew, undefined);
    assert.equal(box.children[1].src, "data:placeholder");
  }
});

test("standInVideos and neverShown agree: what is stood in or draws nothing is filtered, the rest is not", () => {
  const { doc, box, video } = setup(false);                      // visible, with a source: stood in
  const nobox = Object.assign(doc.createElement("video"), { currentSrc: "x", clientWidth: 0, clientHeight: 0 });
  const nosrc = Object.assign(doc.createElement("video"), { currentSrc: "", clientWidth: 50, clientHeight: 50 });
  [nobox, nosrc].forEach((v) => box.appendChild(v));
  const restore = pure.standInVideos([video, nobox, nosrc], doc, fill);
  const stoodIn = (v) => v.style.display === "none";
  const filtered = (v) => pure.neverShown({ nodeType: 1, nodeName: "VIDEO", currentSrc: v.currentSrc });
  assert.deepEqual([stoodIn(video), filtered(video)], [true, true], "replaced, so never cloned");
  assert.deepEqual([stoodIn(nobox), filtered(nobox)], [false, true], "no box: draws nothing, so left out");
  assert.deepEqual([stoodIn(nosrc), filtered(nosrc)], [false, false], "no source: nothing to taint, cloned as before");
  restore();
});

test("standInVideos: a stand-in that cannot be built leaves the video as it was", () => {
  const { doc, video } = setup(true);
  doc.createElement = () => { throw new Error("no canvas"); };
  pure.standInVideos([video], doc, fill);
  assert.equal(video.style.display, "block", "not hidden when there is nothing in its place");
});

test("standInVideos: draws the frame at the rect object-fit gives", () => {
  const { doc, video } = setup(false);
  video.videoWidth = 200; video.videoHeight = 100; video.clientWidth = 100; video.clientHeight = 100;
  const canvases = [];
  const create = doc.createElement;
  doc.createElement = (t) => { const e = create(t); if (t === "canvas") canvases.push(e); return e; };
  pure.standInVideos([video], doc, () => "contain");
  assert.deepEqual(canvases[0]._ctx.calls[0], ["drawImage", 0, 25, 100, 50]);
});

test("standInVideos: hidden, source-less or detached videos are left alone", () => {
  const { doc, box, video } = setup(false);
  const hidden = Object.assign(doc.createElement("video"), { currentSrc: "x", clientWidth: 0, clientHeight: 0 });
  const nosrc = Object.assign(doc.createElement("video"), { currentSrc: "", clientWidth: 10, clientHeight: 10 });
  box.appendChild(hidden); box.appendChild(nosrc);
  const restore = pure.standInVideos([hidden, nosrc], doc, fill);
  assert.deepEqual(box.children.map((c) => c.tagName), ["span", "video", "video", "video"]);
  assert.equal(hidden.style.display, undefined);
  assert.equal(nosrc.style.display, undefined);
  restore();
});

test("standInVideos: nothing about a video makes it throw", () => {
  const { doc, box, video } = setup(false);
  doc.createElement = () => { throw new Error("no canvas at all"); };
  let restore;
  assert.doesNotThrow(() => { restore = pure.standInVideos([video], doc, fill); });
  assert.doesNotThrow(restore);
  assert.equal(video.style.display, "block");
  assert.deepEqual(box.children.map((c) => c.tagName), ["span", "video"]);
});

for (const outcome of ["draws", "fails"]) {
  test(`wrapper: the video is stood in for while html-to-image draws, and back after it ${outcome}`, async () => {
    const { doc, box, video } = setup(true);
    let during;
    const px = new Uint8ClampedArray([1, 2, 3, 255]);
    global.document = Object.assign(doc, { body: {}, documentElement: {} });
    global.getComputedStyle = () => ({ backgroundColor: "rgb(255, 255, 255)", objectFit: "fill" });
    global.window = {
      html2canvas: () => Promise.resolve("fallback"),
      htmlToImage: { toCanvas: () => {
        during = [video.style.display, box.children.map((c) => c.tagName).join()];
        return outcome === "draws"
          ? Promise.resolve({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: px }) }) })
          : Promise.reject(new Error("boom"));
      } },
    };
    delete require.cache[require.resolve(ENGINE)];
    require(ENGINE);
    try {
      const el = { querySelectorAll: (sel) => (sel === "video" ? [video] : []) };
      await global.window.html2canvas(el, { scale: 1 });
      assert.deepEqual(during, ["none", "span,img,video"]);
      assert.equal(video.style.display, "block");
      assert.deepEqual(box.children.map((c) => c.tagName), ["span", "video"]);
    } finally {
      delete global.window; delete global.document; delete global.getComputedStyle;
      delete require.cache[require.resolve(ENGINE)];
    }
  });
}

// the wrapper, with timers and a toCanvas we control
function wrapper(toCanvas, timers) {
  const { doc, box, video } = setup(true);
  global.document = Object.assign(doc, { body: {}, documentElement: {} });
  global.getComputedStyle = () => ({ backgroundColor: "rgb(255, 255, 255)", objectFit: "fill" });
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  global.clearTimeout = (id) => { timers[id - 1].cleared = true; };
  global.window = { html2canvas: () => Promise.resolve("fallback"), htmlToImage: { toCanvas } };
  delete require.cache[require.resolve(ENGINE)];
  require(ENGINE);
  const el = { querySelectorAll: (sel) => (sel === "video" ? [video] : []) };
  return { box, video, run: () => global.window.html2canvas(el, { scale: 1 }) };
}
function unwrapper(realTimers) {
  global.setTimeout = realTimers.setTimeout; global.clearTimeout = realTimers.clearTimeout;
  delete global.window; delete global.document; delete global.getComputedStyle;
  delete require.cache[require.resolve(ENGINE)];
}
const REAL = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };

test("wrapper: a toCanvas that never settles still gets the page put back, by the engine's own timer", async () => {
  const timers = [];
  const w = wrapper(() => new Promise(() => {}), timers);
  try {
    w.run();                                    // abandoned, as the widget does at its own timeout
    await Promise.resolve();
    assert.equal(w.video.style.display, "none", "stood in while it hangs");
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30000);
    timers[0].fn();                             // the safety timer fires
    assert.equal(w.video.style.display, "block");
    assert.deepEqual(w.box.children.map((c) => c.tagName), ["span", "video"]);
  } finally { unwrapper(REAL); }
});

test("wrapper: a toCanvas that throws synchronously reaches the fallback, and the page is put back", async () => {
  const timers = [];
  const w = wrapper(() => { throw new Error("sync boom"); }, timers);
  try {
    assert.equal(await w.run(), "fallback");
    assert.equal(w.video.style.display, "block");
    assert.deepEqual(w.box.children.map((c) => c.tagName), ["span", "video"]);
    assert.equal(timers[0].cleared, true, "the safety timer is cleared on settle");
  } finally { unwrapper(REAL); }
});
