// 1.6.7: LeapHQ bug-20261020-213458, filed from an iPhone (iOS 26 Safari).
//
// (1) "the screenshot didn't capture the whole screen". The capture was cropped
// to documentElement.clientHeight, which iOS keeps at the SMALL viewport (toolbar
// shown): measured in the iOS Simulator, client 714 against a visible 754 once
// the toolbar collapsed on scroll, so the bottom 40px of what was on screen was
// missing. Opening the form also focuses its textarea, which brings up the
// keyboard, shrinks the visible area and scrolls the page — before the capture
// ran. So the area is the visual viewport, measured before the form opens.
//
// (2) "I can still interact with the screen underneath". Swiping the dimmed
// backdrop scrolled the page behind the sheet. Now the page is `inert`, touch
// and wheel scrolling outside the form is stopped, and whatever the keyboard did
// to the scroll position is undone on close.
//
// The browser half (iOS really honouring these) was checked by hand in the iOS
// Simulator; these pin the decisions with a fake DOM.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");
const { makeDom } = require("./fake-dom.js");

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// An iPhone 17 in portrait, toolbar collapsed: layout 402×714, visible 402×754.
function iphone(over) {
  return Object.assign({
    innerWidth: 402, innerHeight: 754, scrollX: 0, scrollY: 577, devicePixelRatio: 3,
    visualViewport: { width: 402, height: 754, offsetLeft: 0, offsetTop: 0 },
    location: { href: "https://example.test/home", pathname: "/home" }, navigator: { userAgent: "iPhone" },
  }, over || {});
}
function iphoneDoc() {
  const doc = makeDom();
  doc.documentElement.clientWidth = 402;
  doc.documentElement.clientHeight = 714;
  return doc;
}
function canvas() {
  return {
    width: 100, height: 100,
    getContext: () => ({ getImageData: () => ({ data: [10, 20, 30, 255] }), drawImage() {} }),
    toDataURL: () => "data:image/png;base64,QUJD",
  };
}

// ── (1) what is on screen ───────────────────────────────────────────────────

test("visibleArea: the visual viewport, not clientHeight (iOS toolbar collapsed)", () => {
  const a = widget.visibleArea(iphone(), iphoneDoc());
  assert.equal(a.width, 402);
  assert.equal(a.height, 754, "clientHeight (714) leaves the bottom 40px of the screen out");
  assert.equal(a.x, 0);
  assert.equal(a.y, 577);
  assert.equal(a.windowWidth, 402);
  assert.equal(a.windowHeight, 754, "laid out where position:fixed;bottom:0 sits now");
});

test("visibleArea: a pinch-zoomed page is the zoomed part, placed by the visual viewport's offset", () => {
  const a = widget.visibleArea(iphone({
    innerHeight: 300, visualViewport: { width: 160.4, height: 300.2, offsetLeft: 50, offsetTop: 120 },
  }), iphoneDoc());
  assert.deepEqual([a.x, a.y, a.width, a.height], [50, 697, 160, 300]);
  assert.deepEqual([a.left, a.top], [50, 120], "iframe rects are layout-viewport relative");
  assert.equal(a.windowWidth, 402);
  assert.equal(a.windowHeight, 714, "the layout viewport, not the zoomed piece");
});

test("visibleArea: without visualViewport, the layout width and the taller height; null without geometry", () => {
  const doc = iphoneDoc();
  const a = widget.visibleArea(iphone({ visualViewport: undefined }), doc);
  assert.deepEqual([a.width, a.height], [402, 754]);
  doc.documentElement.clientWidth = 0; doc.documentElement.clientHeight = 0;
  assert.equal(widget.visibleArea({}, doc), null);
});

test("the capture crops to the visible area and pins the scroll position it was measured at", async () => {
  const seen = [];
  const doc = iphoneDoc();
  const h2c = (el, o) => { seen.push(o); return Promise.resolve(canvas()); };
  const r = await widget.captureScreenshotDetailed({ document: doc, window: iphone(), html2canvas: h2c }, widget.DEFAULTS);
  assert.ok(r.dataUrl);
  const o = seen[0];
  assert.deepEqual([o.x, o.y, o.width, o.height], [0, 577, 402, 754]);
  assert.deepEqual([o.windowWidth, o.windowHeight, o.scrollX, o.scrollY], [402, 754, 0, 577]);
});

test("same-origin frames land at their place inside the visible area when zoomed", async () => {
  const drawn = [];
  const doc = iphoneDoc();
  const inner = makeDom();
  const frame = doc.createElement("iframe");
  frame.contentDocument = inner;
  frame.getBoundingClientRect = () => ({ left: 70, top: 150, width: 40, height: 30 });
  doc.body.appendChild(frame);
  const c = canvas();
  c.getContext = () => ({ getImageData: () => ({ data: [10, 20, 30, 255] }), drawImage: (...a) => drawn.push(a) });
  const win = iphone({ devicePixelRatio: 1, visualViewport: { width: 200, height: 300, offsetLeft: 50, offsetTop: 120 } });
  await widget.captureScreenshotDetailed({ document: doc, window: win, html2canvas: () => Promise.resolve(c) }, widget.DEFAULTS);
  assert.equal(drawn.length, 1);
  assert.deepEqual([drawn[0][1], drawn[0][2]], [20, 30], "frame rect minus the visible area's offset");
});

test("openModal measures the screen BEFORE the form opens (the keyboard changes it after)", async () => {
  const doc = iphoneDoc();
  const win = iphone();
  const seen = [];
  const ctl = widget.createController({ document: doc, window: win, fetch: () => new Promise(() => {}),
    html2canvas: (el, o) => { seen.push(o); return Promise.resolve(canvas()); } });
  ctl.inject();
  // Focusing the textarea is what brings up iOS's keyboard: it shrinks the
  // visible area and scrolls the page.
  const realCreate = doc.createElement;
  doc.createElement = function (tag) {
    const e = realCreate.call(doc, tag);
    if (tag === "textarea") e.focus = () => { win.visualViewport.height = 400; win.innerHeight = 400; win.scrollY = 1014; };
    return e;
  };
  ctl.openModal();
  await settle(5);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].y, seen[0].height, seen[0].scrollY], [577, 754, 577]);
});

// ── (2) the page behind the form ────────────────────────────────────────────

function pageWithForm(win) {
  const doc = makeDom();
  const main = doc.createElement("main"); doc.body.appendChild(main);
  const nav = doc.createElement("nav"); doc.body.appendChild(nav);
  const own = doc.createElement("aside"); own.setAttribute("inert", ""); doc.body.appendChild(own);
  const ctl = widget.createController({ document: doc, window: win || { location: {}, navigator: {} },
    fetch: () => new Promise(() => {}), html2canvas: null });
  ctl.inject();
  return { doc, ctl, main, nav, own, form: () => doc.getElementById("bug-report-modal") };
}
const isInert = (n) => n.getAttribute("inert") != null;

test("while the form is open the page behind it is inert, and only what we made inert is released", () => {
  const p = pageWithForm();
  p.ctl.openModal();
  assert.ok(isInert(p.main) && isInert(p.nav), "the page cannot be tapped, focused or read behind the form");
  assert.ok(isInert(p.doc.getElementById("bug-report-button")));
  assert.ok(!isInert(p.form()), "the form itself stays usable");
  p.ctl.closeModal();
  assert.ok(!isInert(p.main) && !isInert(p.nav));
  assert.ok(isInert(p.own), "a node the app made inert itself is left as it was");
});

test("the screenshot viewer and the toast opened over the form are not made inert", () => {
  const p = pageWithForm();
  const viewer = p.doc.createElement("div"); viewer.id = widget.VIEWER_ID; p.doc.body.appendChild(viewer);
  p.ctl.openModal();
  assert.ok(!isInert(viewer));
});

test("moved into a modal <dialog>, the form makes the dialog's other children inert and releases <body>'s", () => {
  const doc = makeDom();
  const page = doc.createElement("main"); doc.body.appendChild(page);
  const d = doc.createElement("dialog"); d._modal = true; doc.body.appendChild(d);
  const inside = doc.createElement("form"); d.appendChild(inside);
  const observers = [];
  function MO(cb) { this.observe = () => {}; observers.push(cb); }
  const ctl = widget.createController({ document: doc, window: { MutationObserver: MO, location: {}, navigator: {} },
    fetch: () => new Promise(() => {}), html2canvas: null });
  ctl.inject();
  ctl.openModal();
  assert.ok(isInert(d), "the dialog is a sibling while the form is on <body>");
  d.setAttribute("open", ""); observers.forEach((cb) => cb([]));
  assert.equal(doc.getElementById("bug-report-modal").parentNode, d);
  assert.ok(isInert(inside), "inside the dialog, its content is what is behind the form");
  assert.ok(!isInert(d), "the dialog now holds the form, so it must not be inert");
  assert.ok(!isInert(page), "showModal() covers the rest; ours is released");
  ctl.closeModal();
  assert.ok(!isInert(inside));
});

test("a touch or wheel scroll is stopped unless it scrolls something inside the form", () => {
  const p = pageWithForm();
  p.ctl.openModal();
  for (const type of ["touchmove", "wheel"]) {
    assert.equal(p.doc.listenerCount(type), 1, type + " listener while open");
    const onBackdrop = p.doc.dispatch(type, { target: p.form() });
    assert.equal(onBackdrop.defaultPrevented, true, type + " on the backdrop would scroll the page");
  }
  const ta = p.doc.getElementById("bug-report-modal-textarea");
  ta.scrollHeight = 400; ta.clientHeight = 110;          // a long description scrolls
  assert.notEqual(p.doc.dispatch("touchmove", { target: ta }).defaultPrevented, true);
  ta.scrollHeight = 110;                                 // a short one does not: the page would
  assert.equal(p.doc.dispatch("touchmove", { target: ta }).defaultPrevented, true);
  const viewer = p.doc.createElement("div"); viewer.id = widget.VIEWER_ID; p.doc.body.appendChild(viewer);
  assert.notEqual(p.doc.dispatch("touchmove", { target: viewer }).defaultPrevented, true, "the viewer pans and pinches");
  p.ctl.closeModal();
  assert.equal(p.doc.listenerCount("touchmove"), 0);
  assert.equal(p.doc.listenerCount("wheel"), 0);
});

test("on close the page goes back to where it was (iOS's keyboard scrolled it), and is not touched otherwise", () => {
  const calls = [];
  const win = { location: {}, navigator: {}, scrollX: 0, scrollY: 577, scrollTo: (x, y) => { calls.push([x, y]); win.scrollY = y; } };
  const p = pageWithForm(win);
  p.ctl.openModal();
  win.scrollY = 1014;                                    // the keyboard came up
  p.ctl.closeModal();
  assert.deepEqual(calls, [[0, 577]]);
  p.ctl.openModal();
  p.ctl.closeModal();
  assert.deepEqual(calls, [[0, 577]], "no scrollTo when nothing moved");
});

test("visibleArea: a desktop's horizontal scrollbar (innerHeight > visible) does not stretch the layout height", () => {
  const doc = iphoneDoc();
  doc.documentElement.clientHeight = 700;
  const a = widget.visibleArea({ innerWidth: 1215, innerHeight: 715, scrollX: 0, scrollY: 0,
    visualViewport: { width: 1200, height: 700, offsetLeft: 0, offsetTop: 0 } }, doc);
  assert.equal(a.windowHeight, 700, "innerHeight counts the scrollbar; fixed;bottom:0 would land under it");
});

test("the real Cancel button and Escape release the page too", () => {
  for (const close of [(p) => p.doc.getElementById("bug-report-modal-cancel").click(),
                       (p) => p.doc.dispatch("keydown", { key: "Escape" })]) {
    const p = pageWithForm();
    p.ctl.openModal();
    assert.ok(isInert(p.main));
    close(p);
    assert.equal(p.form(), null);
    assert.ok(!isInert(p.main));
    assert.equal(p.doc.listenerCount("touchmove"), 0);
  }
});

function observed() {
  const doc = makeDom();
  const page = doc.createElement("main"); doc.body.appendChild(page);
  const observers = [];
  function MO(cb) { this.observe = () => {}; observers.push(cb); }
  const ctl = widget.createController({ document: doc, window: { MutationObserver: MO, location: {}, navigator: {} },
    fetch: () => new Promise(() => {}), html2canvas: null });
  ctl.inject();
  return { doc, ctl, page, fire: (recs) => observers.forEach((cb) => cb(recs || [])) };
}

test("a dialog removed with the form inside: the form comes back to <body> and the page behind is inert again", () => {
  const o = observed();
  const d = o.doc.createElement("dialog"); d._modal = true; d.setAttribute("open", ""); o.doc.body.appendChild(d);
  o.fire();
  o.ctl.openModal(); o.fire();
  assert.equal(o.doc.getElementById("bug-report-modal").parentNode, d);
  assert.ok(!isInert(o.page), "showModal() covers it while the dialog is up");
  d.remove();
  o.fire([{ removedNodes: [d] }]);
  assert.equal(o.doc.getElementById("bug-report-modal").parentNode, o.doc.body);
  assert.ok(isInert(o.page), "back on <body>, the page behind must not be usable");
});

test("a form removed by the host without closeModal does not leave the page inert or unscrollable", () => {
  const o = observed();
  o.ctl.openModal();
  assert.ok(isInert(o.page));
  o.doc.getElementById("bug-report-modal").remove();      // e.g. the app re-rendered <body>
  o.fire();
  assert.ok(!isInert(o.page));
  assert.equal(o.doc.listenerCount("touchmove"), 0);
  assert.equal(o.doc.listenerCount("wheel"), 0);
});
