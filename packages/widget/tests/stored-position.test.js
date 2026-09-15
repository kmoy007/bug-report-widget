// A dragged button must come back INSIDE the viewport, whatever size the
// window is now.
//
// Regression: the drag handler clamped, but loadStoredPos() handed the stored
// {left, top} straight to the button. Drag it near the bottom-right of a big
// window, open the app in a smaller one, and the button renders off-screen —
// the widget looks permanently missing, and the only cure was clearing
// `bug-report-button-position-v2` from localStorage by hand, per browser.
// That is how the fleet dashboard lost its button for its main reporter.
//
// Driven through createController, so the real mount path is exercised.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");

function makeDoc() {
  const byId = new Map();
  function el(tag) {
    const node = {
      tagName: tag, children: [], style: {}, _listeners: {}, _attrs: {}, textContent: "",
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      focus() {},
    };
    Object.defineProperty(node, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; byId.set(v, this); },
    });
    return node;
  }
  return { body: el("body"), documentElement: el("html"), createElement: el, getElementById: (id) => byId.get(id) || null };
}

function makeWindow(w, h) {
  const listeners = {};
  return {
    innerWidth: w, innerHeight: h,
    location: { href: "https://example.test/" }, navigator: { userAgent: "test" },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    resizeTo(nw, nh) { this.innerWidth = nw; this.innerHeight = nh; (listeners.resize || []).forEach((f) => f()); },
  };
}

function withStorage(stored, fn) {
  const saved = globalThis.localStorage;
  const data = new Map(stored ? [["bug-report-button-position-v2", JSON.stringify(stored)]] : []);
  const writes = [];
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { writes.push([k, v]); data.set(k, v); },
  };
  try { return fn(writes); } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
}

function mount(win, config) {
  const doc = makeDoc();
  const ctl = widget.createController({
    document: doc, window: win, fetch: () => new Promise(() => {}), html2canvas: null,
    config: Object.assign({ buttonSize: 38 }, config || {}),
  });
  ctl.inject();
  return { doc, btn: doc.getElementById("bug-report-button") };
}

const px = (v) => Number(String(v).replace("px", ""));

test("a position stored on a big window is restored inside a small one", () => {
  // dragged to the bottom-right of a 2560×1440 monitor
  withStorage({ left: 2500, top: 1380 }, () => {
    const { btn } = mount(makeWindow(1280, 800));
    assert.equal(px(btn.style.left), 1280 - 38 - 4);
    assert.equal(px(btn.style.top), 800 - 38 - 4);
  });
});

test("a position that already fits is restored exactly", () => {
  withStorage({ left: 300, top: 200 }, () => {
    const { btn } = mount(makeWindow(1280, 800));
    assert.equal(px(btn.style.left), 300);
    assert.equal(px(btn.style.top), 200);
  });
});

test("a negative stored position is pulled back on-screen", () => {
  withStorage({ left: -120, top: -40 }, () => {
    const { btn } = mount(makeWindow(390, 844));
    assert.equal(px(btn.style.left), 4);
    assert.equal(px(btn.style.top), 4);
  });
});

test("shrinking the window after mount re-clamps, growing it restores the stored spot", () => {
  withStorage({ left: 1200, top: 700 }, (writes) => {
    const win = makeWindow(1280, 800);
    const { btn } = mount(win);
    assert.equal(px(btn.style.left), 1200);
    win.resizeTo(600, 500);
    assert.equal(px(btn.style.left), 600 - 38 - 4);
    assert.equal(px(btn.style.top), 500 - 38 - 4);
    win.resizeTo(1280, 800);
    assert.equal(px(btn.style.left), 1200, "the user's chosen spot survives a temporary shrink");
    assert.equal(writes.length, 0, "clamping for display never rewrites the stored preference");
  });
});

test("no stored position leaves the default bottom-right anchoring alone", () => {
  withStorage(null, () => {
    const { btn } = mount(makeWindow(1280, 800));
    assert.equal(btn.style.left, undefined);
    assert.match(btn.style.cssText, /bottom:calc/);
  });
});

test("clampPos: unknown geometry (0) leaves the position untouched", () => {
  assert.deepEqual(widget.clampPos({ left: 9999, top: -5 }, 0, 0, 52, 52), { left: 9999, top: -5 });
});

test("the modal title is configurable and defaults to 'Report a bug'", () => {
  withStorage(null, () => {
    for (const [config, want] of [[{}, "Report a bug"], [{ title: "Report a problem" }, "Report a problem"]]) {
      const doc = makeDoc();
      const ctl = widget.createController({
        document: doc, window: makeWindow(1280, 800), fetch: () => new Promise(() => {}), html2canvas: null, config,
      });
      ctl.openModal();
      const modal = doc.getElementById("bug-report-modal");
      const h2 = modal.children[0].children.find((c) => c.tagName === "h2");
      assert.equal(h2.textContent, want);
    }
  });
});
