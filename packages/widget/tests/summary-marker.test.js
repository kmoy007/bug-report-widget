// 1.6.5: in the clone html-to-image renders, a <summary>'s disclosure marker came out as a
// stray decimal "1." beside the text (PlacementImageViewer's bug queue, Chromium and WebKit
// alike). The engine takes the marker off for the capture and puts it back.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ENGINE = path.join(__dirname, "../src/capture-engine.js");
const pure = require(ENGINE);
const summary = (type) => ({ style: { listStyleType: type } });

test("pinSummaryMarkers: every marker is off until restored, and restored as it was", () => {
  const a = summary("disclosure-open"), b = summary("");
  const restore = pure.pinSummaryMarkers([a, b]);
  assert.equal(a.style.listStyleType, "none");
  assert.equal(b.style.listStyleType, "none");
  restore();
  assert.equal(a.style.listStyleType, "disclosure-open");
  assert.equal(b.style.listStyleType, "", "an element with no inline marker gets none back, not 'none'");
});

test("pinSummaryMarkers: no summaries is nothing to do", () => {
  assert.doesNotThrow(() => pure.pinSummaryMarkers([])());
});

test("neverShown: an <img> with no src or an empty one is skipped; one with a src is drawn", () => {
  const img = (src) => ({ nodeType: 1, nodeName: "IMG", getAttribute: (a) => (a === "src" ? src : null) });
  assert.equal(pure.neverShown(img(null)), true, "no src attribute");
  assert.equal(pure.neverShown(img("")), true, "empty src");
  assert.equal(pure.neverShown(img("data:image/png;base64,AAAA")), false);
  assert.equal(pure.neverShown({ nodeType: 1, nodeName: "IMG" }), true, "no getAttribute at all");
  assert.equal(pure.neverShown({ nodeType: 1, nodeName: "DIV" }), false);
});

for (const outcome of ["draws", "fails"]) {
  test(`wrapper: the marker is off while html-to-image draws, and back after it ${outcome}`, async () => {
    const s = summary("disclosure-open");
    let during;
    const px = new Uint8ClampedArray([1, 2, 3, 255]);
    global.document = { body: {}, documentElement: {} };
    global.getComputedStyle = () => ({ backgroundColor: "rgb(255, 255, 255)" });
    global.window = {
      html2canvas: () => Promise.resolve("fallback"),
      htmlToImage: { toCanvas: () => {
        during = s.style.listStyleType;
        return outcome === "draws"
          ? Promise.resolve({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: px }) }) })
          : Promise.reject(new Error("boom"));
      } },
    };
    delete require.cache[require.resolve(ENGINE)];
    require(ENGINE);
    try {
      await global.window.html2canvas({ querySelectorAll: (sel) => (sel === "summary" ? [s] : []) }, { scale: 1 });
      assert.equal(during, "none");
      assert.equal(s.style.listStyleType, "disclosure-open");
    } finally {
      delete global.window; delete global.document; delete global.getComputedStyle;
      delete require.cache[require.resolve(ENGINE)];
    }
  });
}
