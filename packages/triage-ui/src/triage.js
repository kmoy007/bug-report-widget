// bug-report-triage — the admin queue, as a module.
//
// The widget package files reports. This one READS them: the triage
// screen an admin works through. Backend-agnostic, same as the widget —
// it speaks the spec in ../spec (openapi.yaml for the wire format,
// report-contract.json for the lifecycle) and nothing else.
//
// Why this exists: four apps in one suite each hand-wrote this screen,
// and three of them by porting the first one's HTML. They had already
// drifted in the ways copies do — one collapsed two kinds into one, one
// rendered a field the others didn't, one had no screen at all and its
// reports could only be read by listing a file share. The store and the
// routes were shared from day one; the screen was the half nobody
// packaged, which is exactly the half a person looks at.
//
// Dependency-free and framework-free on purpose: the consuming apps are
// stdlib-Python HTTP servers, Flask templates and an Azure Functions
// app. A build step would exclude most of them.
//
// NOTE the deliberate absence of the CommonJS export token below. Any
// file carrying it gets rewritten to an ES module by vite-plugin-commonjs
// in apps that bundle, and the classic <script> tag then dies on parse —
// in dev only, which is how it stays invisible. The module hands itself
// to globalThis instead; Node tests require() the file and read it from
// there.

(function () {
  "use strict";

  // ─── The lifecycle, from packages/spec/report-contract.json ────────
  // Duplicated as literals rather than fetched: this renders a triage
  // screen, and a screen that cannot draw its own buttons until a second
  // request lands is worse than one that knows them. The test asserts
  // these equal the spec file, so they cannot drift from it.
  var STATUSES = ["open", "triaged", "resolved", "declined"];
  var OFFERED = {
    open: ["triaged", "declined"],
    triaged: ["resolved", "declined"],
    resolved: ["open"],
    declined: ["open"],
  };
  var REASON_REQUIRED_FOR = ["declined"];
  var KINDS = ["bug", "feature"];
  var LABEL = {
    open: "Reopen", triaged: "Mark triaged",
    resolved: "Mark resolved", declined: "Decline",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDate(iso) {
    return String(iso || "").slice(0, 10) || "—";
  }

  // ─── The card ──────────────────────────────────────────────────────

  function summaryHtml(b) {
    var tags = Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",");
    var self = tags.indexOf("agent-self-report") !== -1;
    // `kind` comes from the SERVER. It used to be re-derived from tags in
    // each viewer — two derivations of one fact, with nothing comparing
    // them, which is a parity mirror however short the function is.
    var kind = KINDS.indexOf(b.kind) !== -1 ? b.kind : null;
    return '<details class="bugt' + (self ? " bugt-self" : "") + '" data-id="' + esc(b.id) + '">'
      + "<summary>"
      + '<span class="bugt-title">' + esc(b.title || "(untitled)") + "</span>"
      + '<span class="bugt-chip bugt-st-' + esc(b.status) + '">' + esc(b.status) + "</span>"
      + (kind ? '<span class="bugt-chip bugt-kind-' + esc(kind) + '">' + esc(kind) + "</span>" : "")
      + '<span class="bugt-chip">' + esc(fmtDate(b.addedAt)) + "</span>"
      + '<span class="bugt-chip">' + esc(b.addedBy || "web") + "</span>"
      + (b.screenshot ? '<span class="bugt-chip" title="has a screenshot">📷</span>' : "")
      + (self ? '<span class="bugt-chip">agent</span>' : "")
      + "</summary>"
      + '<div class="bugt-body"><div class="bugt-note">loading…</div></div>'
      + "</details>";
  }

  function kv(label, value) {
    if (!value) return "";
    return '<div class="bugt-kv"><span class="bugt-key">' + esc(label) + "</span>" + esc(value) + "</div>";
  }

  function detailHtml(b, opts) {
    var audit = Array.isArray(b.audit) ? b.audit : [];
    var auditHtml = audit.length
      ? audit.map(function (a) {
        return '<div class="bugt-audit">' + esc(fmtDate(a.changedAt)) + " · "
          + esc(a.fromStatus || "new") + " → " + esc(a.toStatus)
          + (a.changedBy ? " · " + esc(a.changedBy) : "")
          + (a.note ? ' · <span class="bugt-audit-note">' + esc(a.note) + "</span>" : "")
          + "</div>";
      }).join("")
      : '<div class="bugt-note">No history recorded.</div>';

    // The chat turns the filing app bundled, where it bundles any. Stored
    // by every backend here and, until this package, displayed by none —
    // which is worse than not collecting it.
    var turns = Array.isArray(b.transcript) ? b.transcript : [];
    var transcriptHtml = turns.length
      ? '<div class="bugt-section"><strong>Conversation before the report</strong>'
        + turns.map(function (t) {
          return '<div class="bugt-turn"><span class="bugt-who">user</span>' + esc(t.user || "") + "</div>"
            + (t.assistant ? '<div class="bugt-turn"><span class="bugt-who">assistant</span>' + esc(t.assistant) + "</div>" : "");
        }).join("")
        + "</div>"
      : "";

    var shot = b.screenshot
      ? '<img class="bugt-shot" alt="The screen at the moment the report was filed" src="'
        + esc(opts.endpoint + "/" + encodeURIComponent(b.id) + "/screenshot") + '">'
      : "";

    var actions = (OFFERED[b.status] || []).map(function (to) {
      return '<button type="button" class="bugt-btn" data-to="' + esc(to) + '">'
        + esc(LABEL[to] || to) + "</button>";
    }).join(" ");

    return '<div class="bugt-details">' + esc(b.details || "(no description was given)") + "</div>"
      + shot
      + kv("Report", b.id)
      + kv("Filed by", b.actorEmail)
      + kv("Page", b.metaUrl)
      + kv("Build", b.metaBuildSha)
      + kv("Browser", b.metaUserAgent)
      + transcriptHtml
      + '<div class="bugt-actions">' + actions + "</div>"
      + '<div class="bugt-section"><strong>History</strong>' + auditHtml + "</div>";
  }

  // ─── Mount ─────────────────────────────────────────────────────────

  function mount(opts) {
    opts = opts || {};
    var root = opts.root;
    var endpoint = opts.endpoint || "/api/bugs";
    var fetchFn = opts.fetch || (typeof fetch === "function" ? fetch : null);
    var doc = (root && root.ownerDocument) || (typeof document !== "undefined" ? document : null);
    if (!root || !doc || !fetchFn) throw new Error("triage.mount needs {root} and a fetch");

    var state = { status: "", kind: "", days: "30" };

    function controlsHtml() {
      return '<div class="bugt-controls">'
        + '<label class="bugt-field">Status <select data-c="status">'
        + '<option value="">All statuses</option>'
        + STATUSES.map(function (s) {
          return '<option value="' + s + '"' + (s === "open" ? " selected" : "") + ">" + s + "</option>";
        }).join("")
        + "</select></label>"
        + '<label class="bugt-field">Kind <select data-c="kind">'
        + '<option value="">All kinds</option>'
        + KINDS.map(function (k) { return '<option value="' + k + '">' + k + "</option>"; }).join("")
        + "</select></label>"
        + '<label class="bugt-field">Days <select data-c="days">'
        + ["7", "30", "90", "365"].map(function (d) {
          return '<option value="' + d + '"' + (d === "30" ? " selected" : "") + ">" + d + "</option>";
        }).join("")
        + "</select></label>"
        + '<button type="button" class="bugt-btn" data-c="reload">Reload</button>'
        + "</div><div class=\"bugt-list\"></div>";
    }

    root.innerHTML = controlsHtml();
    state.status = "open";
    var list = root.querySelector(".bugt-list");

    async function load() {
      list.innerHTML = '<div class="bugt-note">loading…</div>';
      var qs = "days=" + encodeURIComponent(state.days);
      if (state.status) qs += "&status=" + encodeURIComponent(state.status);
      try {
        var res = await fetchFn(endpoint + "?" + qs);
        if (res.status === 403) {
          // Say what to do about it. Every app here gates reading to an
          // allowlist that fails closed, and the address to add is the
          // one people SIGN IN as — getting that wrong locks the queue to
          // nobody, which has happened to three of them.
          list.innerHTML = '<div class="bugt-note">' + esc(opts.forbiddenHint
            || "Not authorised to triage. Add the address you sign in as to the admin allowlist.") + "</div>";
          return;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        var bugs = (data.bugs || []).filter(function (b) {
          // Kind is DERIVED from tags server-side, so there is no column
          // to query on — filtered here, over rows the server already
          // narrowed by status and age.
          return !state.kind || (b.kind || "bug") === state.kind;
        });
        if (!bugs.length) {
          list.innerHTML = '<div class="bugt-note">Nothing here — no reports match.</div>';
          return;
        }
        list.innerHTML = bugs.map(summaryHtml).join("");
        Array.prototype.forEach.call(list.querySelectorAll(".bugt"), function (el) {
          el.addEventListener("toggle", function () {
            if (el.open && el.dataset.loaded !== "1") loadOne(el);
          });
        });
      } catch (e) {
        list.innerHTML = '<div class="bugt-note">' + esc(e.message) + "</div>";
      }
    }

    async function loadOne(el) {
      var id = el.dataset.id;
      var body = el.querySelector(".bugt-body");
      try {
        var res = await fetchFn(endpoint + "/" + encodeURIComponent(id));
        if (!res.ok) throw new Error("HTTP " + res.status);
        var b = await res.json();
        if (b.error) throw new Error(b.error);
        body.innerHTML = detailHtml(b, { endpoint: endpoint });
        el.dataset.loaded = "1";
        Array.prototype.forEach.call(body.querySelectorAll(".bugt-actions button"), function (btn) {
          btn.addEventListener("click", function () { transition(id, btn.dataset.to, btn); });
        });
      } catch (e) {
        // Not cached: collapsing and reopening must retry, rather than
        // leaving a permanent "could not load" on a live report.
        body.innerHTML = '<div class="bugt-note">Could not load this report: ' + esc(e.message) + "</div>";
      }
    }

    async function transition(id, to, btn) {
      var note = "";
      if (REASON_REQUIRED_FOR.indexOf(to) !== -1) {
        // The server refuses a reason-less decline; ask here so that
        // refusal is never what the admin meets.
        note = (opts.prompt || prompt)("Why is this being declined? (recorded in the report's history)") || "";
        note = note.trim();
        if (!note) return;
      }
      btn.disabled = true;
      try {
        var res = await fetchFn(endpoint + "/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: to, note: note }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await load();
        if (typeof opts.onChange === "function") opts.onChange();
      } catch (e) {
        btn.disabled = false;
        if (typeof opts.onError === "function") opts.onError(e);
        else alert("Could not update: " + e.message);
      }
    }

    root.addEventListener("change", function (e) {
      var c = e.target && e.target.getAttribute && e.target.getAttribute("data-c");
      if (!c || c === "reload") return;
      state[c] = e.target.value;
      load();
    });
    root.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute("data-c") === "reload") load();
    });

    load();
    return { reload: load, state: state };
  }

  var api = {
    mount: mount,
    // Exposed for the contract test, and for an app that wants to render
    // its own chrome around the same lifecycle.
    STATUSES: STATUSES, OFFERED: OFFERED, KINDS: KINDS,
    REASON_REQUIRED_FOR: REASON_REQUIRED_FOR,
    _internals: { summaryHtml: summaryHtml, detailHtml: detailHtml, esc: esc },
  };

  if (typeof globalThis !== "undefined") globalThis.__bugReportTriage = api;
  if (typeof window !== "undefined") window.BugReportTriage = api;
})();
