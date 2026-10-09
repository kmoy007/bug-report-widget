// 1.6.2: the capture engine used a fixed white background, so a dark page
// (light text on a dark body) was captured on white and the text vanished.
// pageBackground resolves the colour the person actually sees.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ENGINE = path.join(__dirname, "../src/capture-engine.js");
const pure = require(ENGINE);

const BODY = { n: "body" }, HTML = { n: "html" };
const styles = (map) => (e) => map.get(e) || {};
const bgOf = (b, h, extra) => pure.pageBackground(
  styles(new Map([[BODY, { backgroundColor: b }], [HTML, Object.assign({ backgroundColor: h }, extra)]])), BODY, HTML);
const canvas = (w, h, px) => ({ width: w, height: h, getContext: () => ({ getImageData: () => ({ data: px }) }) });

test("pageBackground: an opaque body wins", () => {
  assert.equal(bgOf("rgb(11, 18, 32)", "rgb(255, 0, 0)"), "rgb(11, 18, 32)");
});

test("pageBackground: transparent body falls through to an opaque html", () => {
  assert.equal(bgOf("rgba(0, 0, 0, 0)", "rgb(11, 18, 32)"), "rgb(11, 18, 32)");
  assert.equal(bgOf("transparent", "rgb(11, 18, 32)"), "rgb(11, 18, 32)");
});

test("pageBackground: both transparent is white, as before 1.6.2", () => {
  assert.equal(bgOf("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"), "#ffffff");
  assert.equal(bgOf(undefined, undefined), "#ffffff");
});

test("pageBackground: a dark page (light text on #0b1220) is dark, not white", () => {
  assert.equal(bgOf("rgb(11, 18, 32)", "rgba(0, 0, 0, 0)"), "rgb(11, 18, 32)");
});

test("pageBackground: alpha below 1 is not opaque (skipped); alpha 1 and modern syntax are", () => {
  assert.equal(bgOf("rgba(0, 0, 0, 0.5)", "rgb(20, 30, 40)"), "rgb(20, 30, 40)");
  assert.equal(bgOf("rgba(0, 0, 0, 0.5)", "rgba(0, 0, 0, 0.9)"), "#ffffff");
  assert.equal(bgOf("rgba(10, 20, 30, 1)", "rgb(1, 1, 1)"), "rgb(10, 20, 30)");
  assert.equal(bgOf("rgb(10 20 30 / 0)", "rgb(1, 1, 1)"), "rgb(1, 1, 1)");
  assert.equal(bgOf("color(srgb 0.1 0.2 0.3)", "rgb(1, 1, 1)"), "rgb(26, 51, 77)");
});

test("pageBackground: a gradient on a transparent body is not rendered; the opaque ancestor colour is used", () => {
  // computed background-color stays transparent for a gradient (it lives in background-image)
  assert.equal(bgOf("rgba(0, 0, 0, 0)", "rgb(30, 30, 30)"), "rgb(30, 30, 30)");
});

test("pageBackground: nothing opaque but color-scheme dark gives the browser's dark canvas", () => {
  assert.equal(bgOf("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", { colorScheme: "dark" }), "#121212");
  assert.equal(bgOf("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", { colorScheme: "light dark" }), "#ffffff");
  assert.equal(bgOf("rgb(250, 250, 250)", "rgba(0, 0, 0, 0)", { colorScheme: "dark" }), "rgb(250, 250, 250)");
});

test("pageBackground: an unparseable colour is skipped", () => {
  assert.equal(bgOf("oklch(0.2 0.02 250)", "rgb(1, 2, 3)"), "rgb(1, 2, 3)");
});

test("toImageOptions: backgroundColor is the page colour, white by default", () => {
  assert.equal(pure.toImageOptions({}).backgroundColor, "#ffffff");
  assert.equal(pure.toImageOptions({}, "rgb(11, 18, 32)").backgroundColor, "rgb(11, 18, 32)");
});

test("blank: judged against the page colour: a dark page that drew nothing is blank, white is not", () => {
  const dark = [11, 18, 32, 255];
  assert.equal(pure.blank(canvas(100, 80, dark), "rgb(11, 18, 32)"), true);
  assert.equal(pure.blank(canvas(100, 80, [255, 255, 255, 255]), "rgb(11, 18, 32)"), false);
  assert.equal(pure.blank(canvas(100, 80, dark)), false, "default is white");
});

test("wrapper: a dark page hands html-to-image its real colour, and the fallback gets it too", async () => {
  let got, fallbackOpts;
  global.document = { body: BODY, documentElement: HTML };
  global.getComputedStyle = styles(new Map([[BODY, { backgroundColor: "rgb(11, 18, 32)" }], [HTML, {}]]));
  global.window = {
    html2canvas: (e, o) => { fallbackOpts = o; return Promise.resolve("real"); },
    htmlToImage: { toCanvas: (e, o) => { got = o; return Promise.reject(new Error("boom")); } },
  };
  delete require.cache[require.resolve(ENGINE)];
  require(ENGINE);
  try {
    await global.window.html2canvas({ querySelectorAll: () => [] }, { scale: 1, backgroundColor: null });
    assert.equal(got.backgroundColor, "rgb(11, 18, 32)");
    assert.equal(fallbackOpts.backgroundColor, "rgb(11, 18, 32)");
  } finally {
    delete global.window; delete global.document; delete global.getComputedStyle;
    delete require.cache[require.resolve(ENGINE)];
  }
});
