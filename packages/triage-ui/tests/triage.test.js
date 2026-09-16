// The triage UI, and its agreement with the spec.
//
// The point of packaging this screen was that four apps had hand-written
// it and drifted. So the assertions that matter are the ones that would
// have caught that drift: the lifecycle it draws buttons for, the kinds
// it accepts, and the fields it renders.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SPEC = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "spec", "report-contract.json"), "utf8"));

require(path.join(__dirname, "..", "src", "triage.js"));
const triage = globalThis.__bugReportTriage;

describe("the module contract", () => {
  it("hands itself to globalThis and never writes the CJS export token", () => {
    // Any file carrying that token is rewritten to an ES module by
    // vite-plugin-commonjs in apps that bundle, and the classic <script>
    // tag then dies on parse — in dev only, so it stays invisible.
    assert.ok(triage, "globalThis.__bugReportTriage missing");
    assert.equal(typeof triage.mount, "function");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "triage.js"), "utf8");
    assert.ok(!src.includes("module." + "exports"));
  });
});

describe("it draws the lifecycle the spec declares", () => {
  it("offers exactly the spec's transitions", () => {
    assert.deepEqual(triage.OFFERED, SPEC.offered);
  });

  it("knows exactly the spec's statuses and kinds", () => {
    assert.deepEqual(triage.STATUSES, SPEC.statuses);
    assert.deepEqual(triage.KINDS, SPEC.kinds);
  });

  it("asks for a reason wherever the spec requires one", () => {
    assert.deepEqual(triage.REASON_REQUIRED_FOR, SPEC.reasonRequiredFor);
  });

  it("never offers a move the spec's server map forbids", () => {
    for (const [from, tos] of Object.entries(triage.OFFERED)) {
      for (const to of tos) {
        assert.ok(SPEC.transitions[from].includes(to),
          `offers ${from} → ${to}, which the server map does not allow`);
      }
    }
  });
});

describe("the card", () => {
  const { summaryHtml, detailHtml } = triage._internals;
  const REPORT = {
    id: "bug-20260915-084210-7c327e",
    title: "Hour picker sticks",
    kind: "feature",
    tags: ["bug", "feature-request", "agent-self-report"],
    status: "triaged",
    addedBy: "agent",
    addedAt: "2026-09-15T08:42:10.000Z",
    actorEmail: "ken@example.com",
    screenshot: true,
    details: "Tapping 7.5 twice leaves the picker open.",
    metaUrl: "https://app/index.html",
    metaUserAgent: "Mozilla/5.0",
    metaBuildSha: "24598ba",
    transcript: [{ user: "log 2h", assistant: "which code?" }],
    audit: [{ changedAt: "2026-09-15T09:10:00Z", changedBy: "ken@example.com",
              fromStatus: "open", toStatus: "triaged", note: "" }],
  };

  it("shows the kind the SERVER sent, never one it re-derived", () => {
    // The drift this package exists to end: each viewer re-derived kind
    // from tags, and when a kind was retired the collapse had to be
    // remembered in every copy.
    assert.match(summaryHtml(REPORT), /bugt-kind-feature">feature</);
    const asBug = summaryHtml({ ...REPORT, kind: "bug" });
    assert.match(asBug, /bugt-kind-bug">bug</);
    // Tags still say feature-request; the card must not care.
    assert.ok(!/feature</.test(asBug));
  });

  it("ignores a kind the spec does not declare", () => {
    assert.ok(!/bugt-kind-/.test(summaryHtml({ ...REPORT, kind: "capability" })));
  });

  it("renders every detail field the spec declares", () => {
    const html = detailHtml(REPORT, { endpoint: "/api/bugs" });
    assert.match(html, /Tapping 7\.5 twice/);      // details
    assert.match(html, /24598ba/);                  // metaBuildSha
    assert.match(html, /https:\/\/app\/index\.html/); // metaUrl
    assert.match(html, /Mozilla\/5\.0/);            // metaUserAgent
    assert.match(html, /open → triaged/);           // audit
  });

  it("renders the transcript a backend bundled, and nothing when there is none", () => {
    // Stored by every backend in this repo and displayed by none before
    // this package — worse than not collecting it.
    assert.match(detailHtml(REPORT, { endpoint: "/api/bugs" }), /Conversation before the report/);
    const none = detailHtml({ ...REPORT, transcript: [] }, { endpoint: "/api/bugs" });
    assert.ok(!/Conversation before the report/.test(none));
  });

  it("offers only the transitions legal from the report's status", () => {
    const html = detailHtml(REPORT, { endpoint: "/api/bugs" }); // triaged
    assert.match(html, /data-to="resolved"/);
    assert.match(html, /data-to="declined"/);
    assert.ok(!/data-to="open"/.test(html), "a triaged row must not offer Reopen");
  });

  it("escapes everything it interpolates", () => {
    const nasty = { ...REPORT, title: '<img src=x onerror=alert(1)>',
                    details: '</div><script>alert(1)</script>' };
    assert.ok(!summaryHtml(nasty).includes("<img src=x"));
    assert.ok(!detailHtml(nasty, { endpoint: "/api/bugs" }).includes("<script>alert(1)"));
  });

  it("links a screenshot only when the report has one", () => {
    assert.match(detailHtml(REPORT, { endpoint: "/api/bugs" }), /bugt-shot/);
    assert.ok(!/bugt-shot/.test(detailHtml({ ...REPORT, screenshot: false }, { endpoint: "/api/bugs" })));
  });

  it("gives the screenshot a caption that says what it is", () => {
    // "screenshot" tells a screen-reader user nothing about why it is here.
    assert.match(detailHtml(REPORT, { endpoint: "/api/bugs" }),
      /alt="The screen at the moment the report was filed"/);
  });
});
