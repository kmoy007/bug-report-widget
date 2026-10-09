// 1.6.0: the submit is bounded, says what it is doing, can carry an idempotency
// key, and Escape closes the dialog.
//
// Behaviour and history ported from leap-timesheet's copy of the widget, where
// each of these cost a real bug: bug-20260911-222709 (the server stored the row
// and answered 201 in 296 ms, the browser never acted on it, and the reporter
// sat in front of a dialog frozen on "Submitting…" for a report that HAD been
// filed) and UX-5 (Escape).

const test = require("node:test");
const assert = require("node:assert/strict");
const widget = require("../src/bug-report.js");
const { makeDom } = require("./fake-dom.js");

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeH2c() {
  const canvas = {
    width: 100, height: 100,
    getContext: () => ({ getImageData: () => ({ data: [10, 20, 30, 255] }) }),
    toDataURL: () => "data:image/png;base64," + "QUJD".repeat(300),   // ~900 bytes
  };
  return () => Promise.resolve(canvas);
}

function harness({ config, fetchImpl } = {}) {
  const doc = makeDom();
  const posts = [];
  const events = [];
  const win = {
    location: { href: "https://example.test/p", pathname: "/p" },
    navigator: { userAgent: "t" },
    AbortController: function () { this.signal = {}; this.abort = () => { win.aborted = true; }; },
    aborted: false,
  };
  const ctl = widget.createController({
    document: doc, window: win,
    fetch: fetchImpl || ((url, init) => {
      posts.push({ url, init, body: JSON.parse(init.body) });
      return new Promise(() => {});   // never answers
    }),
    html2canvas: fakeH2c(),
    config: Object.assign({
      submitTimeoutMs: 30, slowNoticeMs: 10,
      onClientEvent: (kind, detail) => events.push({ kind, detail }),
    }, config || {}),
  });
  const q = (s) => doc.getElementById("bug-report-modal" + s);
  return { doc, win, ctl, posts, events, q };
}

async function openFilled(h, text) {
  h.ctl.openModal();
  await settle(5);                       // let the capture land
  h.q("-textarea").value = text || "it hangs";
  return h.q("-submit");
}

test("a submit that never answers gives the button back instead of freezing on Submitting…", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  assert.equal(submit.textContent, "Submitting…");
  await settle(70);
  assert.ok(h.q(""), "the modal stays open so the text is not lost");
  assert.equal(submit.textContent, "Submit");
  assert.equal(submit.disabled, false);
  assert.match(h.q("-error").textContent, /no answer from the server after 0 seconds/i);
});

test("a stalled request is aborted so it stops holding a connection", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  await settle(70);
  assert.equal(h.win.aborted, true);
  assert.ok(h.posts[0].init.signal, "the AbortController's signal was handed to fetch");
});

test("the status line (role=status) says what is being sent, and clears at the end", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  const status = h.q("-status");
  assert.equal(status.getAttribute("role"), "status");
  assert.match(status.textContent, /^Sending… uploading a .* screenshot\.$/);
  assert.equal(status.style.display, "block");
  await settle(70);
  assert.equal(status.style.display, "none");
});

test("a 'Still sending…' notice appears after slowNoticeMs", async () => {
  const h = harness({ config: { submitTimeoutMs: 80, slowNoticeMs: 15 } });
  const submit = await openFilled(h);
  submit.click();
  await settle(40);
  assert.match(h.q("-status").textContent, /^Still sending…/);
});

test("with idempotentSubmit the timeout says it is safe to submit again, and the retry reuses the key", async () => {
  let stall = true;
  const posts = [];
  const h = harness({
    config: { idempotentSubmit: true },
    fetchImpl: (url, init) => {
      posts.push(JSON.parse(init.body));
      return stall ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, json: async () => ({ id: "x" }) });
    },
  });
  const submit = await openFilled(h);
  submit.click();
  await settle(70);
  assert.match(h.q("-error").textContent, /may already be filed/);
  assert.match(h.q("-error").textContent, /won't be filed twice/);
  stall = false;
  submit.click();
  await settle(20);
  assert.equal(posts.length, 2);
  assert.ok(posts[0].clientKey && posts[0].clientKey.length >= 16, "a key is sent");
  assert.equal(posts[0].clientKey, posts[1].clientKey, "same report, same key");
  assert.equal(h.q(""), null, "the retry closes the dialog");
});

test("a different report gets a different key", async () => {
  const h = harness({ config: { idempotentSubmit: true } });
  h.ctl.openModal();
  const first = h.ctl._state().submissionKey;
  h.ctl.closeModal();
  h.ctl.openModal();
  assert.ok(first);
  assert.notEqual(first, h.ctl._state().submissionKey);
});

test("without idempotentSubmit no key is sent and the timeout does not promise what the server may not do", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  await settle(70);
  assert.equal("clientKey" in h.posts[0].body, false, "the wire format is exactly 1.5.0's");
  const err = h.q("-error").textContent;
  assert.match(err, /may or may not have been filed/);
  assert.doesNotMatch(err, /won't be filed twice/);
});

test("onClientEvent hears about a submit timeout, and a throwing hook cannot break the widget", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  await settle(70);
  const ev = h.events.filter((e) => e.kind === "submit-timeout");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.idempotent, false);
  assert.match(ev[0].detail.message, /^no response after \d+ms; payload \d+ bytes$/);

  const h2 = harness({ config: { onClientEvent: () => { throw new Error("hook bug"); } } });
  const s2 = await openFilled(h2);
  s2.click();
  await settle(70);
  assert.equal(s2.textContent, "Submit", "still ended cleanly");
});

test("the screenshotError and clientKey fields are left out of a plain report", async () => {
  const h = harness();
  const submit = await openFilled(h);
  submit.click();
  assert.deepEqual(Object.keys(h.posts[0].body).sort(),
    ["addedBy", "details", "metaBuildSha", "metaUrl", "metaUserAgent", "screenshot", "tags", "title"]);
});

test("a late success after Cancel does not close a modal opened since", async () => {
  let release;
  const h = harness({
    config: { submitTimeoutMs: 500 },
    fetchImpl: () => new Promise((r) => { release = r; }),
  });
  const submit = await openFilled(h);
  submit.click();
  h.ctl.closeModal();                       // the reporter cancels
  h.ctl.openModal();                        // and starts another report
  release({ ok: true, status: 201, json: async () => ({}) });
  await settle(10);
  assert.ok(h.q(""), "the new modal survived the old report's success");
  void submit;
});

test("Escape closes the modal and the listener goes with it", async () => {
  const h = harness();
  h.ctl.openModal();
  assert.equal(h.doc.listenerCount("keydown"), 1);
  const ev = h.doc.dispatch("keydown", { key: "Enter" });
  assert.ok(h.q(""), "other keys do nothing");
  const esc = h.doc.dispatch("keydown", { key: "Escape" });
  assert.equal(h.q(""), null);
  assert.equal(esc.defaultPrevented, true, "so a host <dialog> is not closed by the same key");
  assert.equal(h.doc.listenerCount("keydown"), 0);
  void ev;
});

test("Escape leaves the modal alone while the screenshot viewer is open (the viewer takes it)", async () => {
  const h = harness();
  h.ctl.openModal();
  const viewer = h.doc.createElement("div");
  viewer.id = widget.VIEWER_ID;
  h.doc.body.appendChild(viewer);
  h.doc.dispatch("keydown", { key: "Escape" });
  assert.ok(h.q(""), "the viewer's own Escape closes the viewer, not the report");
});
