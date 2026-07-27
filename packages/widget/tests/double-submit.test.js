// The submit button must file exactly one report, however many times it's tapped.
//
// Regression: the click handler called onSubmit with no guard. The POST is
// async and nothing on screen changed on the first tap, so on a phone — small
// target, slow network — people tapped again. Real reports arrived 2-3 times,
// seconds apart (2026-07-01 x3, 2026-07-23 x2, 2026-07-27 x2), roughly doubling
// the queue for mobile reporters and burying real signal in duplicates.
//
// Driven through createController's injected deps, so this exercises the actual
// DOM handler rather than a reimplementation of it.

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");

// ── the smallest DOM that createController needs ────────────────────────────
function makeDoc() {
  const byId = new Map();
  function el(tag) {
    const node = {
      tagName: tag, children: [], style: {}, dataset: {}, _listeners: {},
      _attrs: {}, textContent: "", value: "", disabled: false,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      removeEventListener() {},
      click() { (this._listeners.click || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {} })); },
      focus() {},
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    Object.defineProperty(node, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; byId.set(v, this); },
    });
    return node;
  }
  const body = el("body");
  return {
    body,
    documentElement: el("html"),
    createElement: el,
    getElementById: (id) => byId.get(id) || null,
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _find: (suffix) => [...byId.entries()].find(([k]) => k.endsWith(suffix))?.[1] || null,
  };
}

function harness({ fetchImpl } = {}) {
  const doc = makeDoc();
  const posts = [];
  const ctl = widget.createController({
    document: doc,
    window: { location: { href: "https://example.test/page" }, navigator: { userAgent: "test" } },
    fetch: fetchImpl || ((url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      // never settles — mimics a slow network, which is when people re-tap
      return new Promise(() => {});
    }),
    html2canvas: null,
    config: { endpoint: "/api/bugs" },
  });
  return { doc, posts, ctl };
}

function openAndFill(h, text) {
  h.ctl.openModal();
  const ta = h.doc._find("-textarea");
  assert.ok(ta, "modal textarea not found");
  ta.value = text;
  return h.doc._find("-submit");
}

test("a single tap files one report", () => {
  const h = harness();
  openAndFill(h, "something broke").click();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.details, "something broke");
});

test("tapping submit three times still files ONE report", () => {
  const h = harness();
  const submit = openAndFill(h, "the layout is broken on mobile");
  submit.click();
  submit.click();
  submit.click();
  assert.equal(h.posts.length, 1,
    `filed ${h.posts.length} reports for one bug — this is the duplicate-queue bug`);
});

test("the button shows it is working, so the tap registers visibly", () => {
  const h = harness();
  const submit = openAndFill(h, "x");
  submit.click();
  assert.equal(submit.disabled, true);
  assert.match(submit.textContent, /Submitting/);
});

test("a validation failure re-enables the button so it can be retried", () => {
  const h = harness();
  const submit = openAndFill(h, "   ");     // blank -> rejected before any POST
  submit.click();
  assert.equal(h.posts.length, 0, "blank description should not POST");
  assert.equal(submit.disabled, false, "user is now stuck with a dead button");
  assert.equal(submit.textContent, "Submit");
});

test("after fixing the validation error the retry files exactly one report", () => {
  const h = harness();
  const submit = openAndFill(h, "");
  submit.click();                            // rejected
  h.doc._find("-textarea").value = "now with detail";
  submit.click();                            // accepted
  submit.click();                            // and guarded again
  assert.equal(h.posts.length, 1);
});

test("a failed POST re-enables the button", async () => {
  const h = harness({
    fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
  });
  const submit = openAndFill(h, "server will reject this");
  submit.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(submit.disabled, false, "a 500 must not leave the report unfilable");
  assert.equal(submit.textContent, "Submit");
});

test("a network error re-enables the button", async () => {
  const h = harness({ fetchImpl: () => Promise.reject(new Error("offline")) });
  const submit = openAndFill(h, "network will fail");
  submit.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(submit.disabled, false);
});
