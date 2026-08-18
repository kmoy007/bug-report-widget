/* bug-report.js — portable in-app bug reporting widget.
 *
 * Drop:   <script src="html2canvas.min.js" defer></script>
 *         <script src="bug-report.js" defer></script>
 * Result: floating 🐛 button bottom-right, captures viewport on tap,
 *         shows a modal with preview + textarea, POSTs to /api/bugs.
 *
 * Configure by setting window.BugReportConfig BEFORE this script loads:
 *   window.BugReportConfig = {
 *     endpoint: "/api/bugs",            // default
 *     idPrefix: "bug-report",           // collision-proof your DOM
 *     buildSha: "abc1234",              // or () => string
 *     theme: { accent: "#007AFF", ... } // override CSS tokens
 *     position: { bottom: 20, right: 20 } // px, before user drag
 *   };
 *
 * UMD: also exports `BugReportWidget` on `window` for tests + programmatic
 * use. In Node (no DOM), exports `createController` etc. for unit testing
 * the pure pieces.
 *
 * Distilled from leap-timesheet's lib/bug-report.js + claude-tmux-dashboard's
 * static/bug-report.js. See bug-report-pattern.md for the design rationale.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.BugReportWidget = api;
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      if (!window.__bugReportSkipAutoInit) api.init();
    }
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    endpoint: "/api/bugs",
    idPrefix: "bug-report",
    buildSha: "",
    position: { bottom: 20, right: 20 },
    // Diameter of the floating button, px. Host apps embedded inside another
    // shell often want a smaller footprint so it reads as chrome rather than
    // page content. The glyph scales with it.
    buttonSize: 52,
    captureTimeoutMs: 6000,
    // Decoded-byte ceiling for the screenshot payload. Mirrors the reference
    // backend's server-side cap (which stays authoritative — never trust the
    // client). The client cap exists so a capture that would be rejected is
    // re-encoded smaller (or dropped) instead of dead-ending the report in a
    // 413 the user can't do anything about.
    maxScreenshotBytes: 5 * 1024 * 1024,
    storageKey: "bug-report-button-position-v2",
    theme: {
      accent: "#007AFF",
      buttonBg: "#ffffff",
      buttonInk: "#1a1a1e",
      modalBg: "#ffffff",
      modalInk: "#1a1a1e",
      mutedInk: "#666666",
      errorInk: "#c0392b",
      toastBg: "rgba(40,40,42,0.92)",
      toastInk: "#ffffff",
      font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
      radius: "12px",
    },
  };

  function mergeConfig(user) {
    user = user || {};
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var k2 in user) {
      if (k2 === "theme" || k2 === "position") {
        var merged = {};
        for (var t in DEFAULTS[k2]) merged[t] = DEFAULTS[k2][t];
        for (var t2 in user[k2]) merged[t2] = user[k2][t2];
        out[k2] = merged;
      } else {
        out[k2] = user[k2];
      }
    }
    return out;
  }

  // ─── Pure helpers (testable in Node) ───────────────────────────────

  // True if a canvas appears blank (all transparent / all white). Safari
  // edge case: html2canvas occasionally returns a tainted canvas with no
  // pixel data. Density of 8×8 (64 samples) reliably finds at least one
  // non-white pixel on any page with real content; 4×4 sometimes false-
  // negatives on wide layouts with white cards.
  function isBlankCanvas(canvas) {
    if (!canvas || !canvas.getContext) return true;
    if (!canvas.width || !canvas.height) return true;
    var ctx;
    try { ctx = canvas.getContext("2d"); } catch (e) { return true; }
    if (!ctx) return true;
    try {
      var w = canvas.width, h = canvas.height;
      var n = 8;
      for (var x = 0; x < n; x++) {
        for (var y = 0; y < n; y++) {
          var px = Math.max(0, Math.min(w - 1, Math.floor((x + 0.5) * w / n)));
          var py = Math.max(0, Math.min(h - 1, Math.floor((y + 0.5) * h / n)));
          var data = ctx.getImageData(px, py, 1, 1).data;
          if (data[3] > 0 && !(data[0] === 255 && data[1] === 255 && data[2] === 255)) {
            return false;
          }
        }
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  // Decoded byte size of a data URL's base64 payload — i.e. what a server
  // that base64-decodes before checking its cap will measure.
  function dataUrlBytes(dataUrl) {
    if (typeof dataUrl !== "string") return 0;
    var i = dataUrl.indexOf(",");
    var b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    var pad = 0;
    if (b64.slice(-2) === "==") pad = 2;
    else if (b64.slice(-1) === "=") pad = 1;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
  }

  // Serialise a canvas to a data URL whose DECODED size is ≤ maxBytes.
  // Ladder: PNG (lossless) → JPEG 0.85 → JPEG 0.6 → half-resolution JPEG
  // 0.6 → null. A null means the report goes out without a screenshot,
  // which beats a 413 the user can't recover from.
  //
  // JPEG has no alpha channel and browsers composite transparent pixels
  // onto BLACK, so the canvas is flattened onto white before any JPEG
  // encode. If flattening fails (no createElement / getContext in exotic
  // hosts) the unflattened canvas is used — a dark screenshot still beats
  // no screenshot.
  function encodeCanvasUnderCap(canvas, maxBytes, doc) {
    function fits(url) { return url && dataUrlBytes(url) <= maxBytes ? url : null; }
    try {
      var png = fits(canvas.toDataURL("image/png"));
      if (png) return png;
    } catch (e) { return null; }
    var flat = canvas;
    try {
      var f = doc.createElement("canvas");
      f.width = canvas.width; f.height = canvas.height;
      var fctx = f.getContext("2d");
      fctx.fillStyle = "#ffffff";
      fctx.fillRect(0, 0, f.width, f.height);
      fctx.drawImage(canvas, 0, 0);
      flat = f;
    } catch (e) { /* fall through with the unflattened canvas */ }
    var qualities = [0.85, 0.6];
    for (var i = 0; i < qualities.length; i++) {
      try {
        var jpg = fits(flat.toDataURL("image/jpeg", qualities[i]));
        if (jpg) return jpg;
      } catch (e) { return null; }
    }
    try {
      var h = doc.createElement("canvas");
      h.width = Math.max(1, Math.round(flat.width / 2));
      h.height = Math.max(1, Math.round(flat.height / 2));
      var hctx = h.getContext("2d");
      hctx.fillStyle = "#ffffff";
      hctx.fillRect(0, 0, h.width, h.height);
      hctx.drawImage(flat, 0, 0, h.width, h.height);
      return fits(h.toDataURL("image/jpeg", 0.6));
    } catch (e) { return null; }
  }

  function buildPostBody(opts) {
    return {
      title: opts.title || (opts.details || "").split("\n")[0].slice(0, 100),
      details: String(opts.details || "").slice(0, 10 * 1024),
      screenshot: opts.screenshot || null,
      metaUrl: opts.metaUrl || "",
      metaUserAgent: opts.metaUserAgent || "",
      metaBuildSha: opts.metaBuildSha || "",
      tags: Array.isArray(opts.tags) ? opts.tags : ["bug"],
      addedBy: opts.addedBy || "web",
    };
  }

  // ─── Capture (browser only) ────────────────────────────────────────

  // Always resolves: data URL on success, null on failure, blank canvas,
  // or timeout. The timeout is load-bearing — html2canvas has been known
  // to hang on iOS Safari with certain CSS features (filters, blend
  // modes, large viewports). Without it the widget can lock up.
  // html2canvas does not render iframe CONTENT — an embedded frame comes out as
  // a blank rectangle, so a screenshot of a page whose main content is framed
  // shows nothing (reported in the wild as "the screenshot misses the content").
  // For SAME-ORIGIN frames we can reach the inner document, render it
  // separately, and paste it into the parent capture at the frame's position.
  // Cross-origin frames are untouchable by design and stay blank.
  // `origin` is the top-left of the captured region in VIEWPORT coordinates
  // — {left: 0, top: 0} for a viewport-cropped capture, doc.body's rect for
  // a full-body capture — so frame rects (which getBoundingClientRect always
  // reports viewport-relative) land at the right canvas position either way.
  function compositeIframes(html2canvas, doc, canvas, scale, origin) {
    var frames;
    try { frames = Array.prototype.slice.call(doc.querySelectorAll("iframe")); }
    catch (e) { return Promise.resolve(canvas); }
    if (!frames.length) return Promise.resolve(canvas);

    var jobs = frames.map(function (f) {
      var idoc = null, rect = null;
      try {
        // throws (or returns null) for cross-origin — treated as "skip"
        idoc = f.contentDocument;
        rect = f.getBoundingClientRect();
      } catch (e) { return null; }
      if (!idoc || !idoc.body || !rect || rect.width < 1 || rect.height < 1) return null;
      if (f.getAttribute && f.getAttribute("data-bug-report-exclude") != null) return null;
      return { el: f, doc: idoc, rect: rect };
    }).filter(Boolean);
    if (!jobs.length) return Promise.resolve(canvas);

    var ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return Promise.resolve(canvas);

    return Promise.all(jobs.map(function (j) {
      return html2canvas(j.doc.body, {
        useCORS: true, logging: false, scale: scale,
        backgroundColor: null,
        width: Math.ceil(j.rect.width), height: Math.ceil(j.rect.height),
        windowWidth: Math.ceil(j.rect.width), windowHeight: Math.ceil(j.rect.height),
      }).then(function (sub) {
        try {
          // position of the frame within the captured region, in canvas pixels
          var x = (j.rect.left - origin.left) * scale;
          var y = (j.rect.top - origin.top) * scale;
          ctx.drawImage(sub, x, y, j.rect.width * scale, j.rect.height * scale);
        } catch (e) { /* one bad frame must not lose the whole screenshot */ }
      }).catch(function () { /* same */ });
    })).then(function () { return canvas; });
  }

  function captureScreenshot(deps, cfg) {
    var html2canvas = deps.html2canvas;
    var doc = deps.document;
    return new Promise(function (resolve) {
      var done = false;
      function settle(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { settle(null); }, cfg.captureTimeoutMs);

      if (!html2canvas || !doc) { settle(null); return; }
      var btnId = cfg.idPrefix + "-button";
      var modalId = cfg.idPrefix + "-modal";
      var win = deps.window || (typeof window !== "undefined" ? window : null);
      var scale = Math.min((win && win.devicePixelRatio) || 1, 2);

      // Capture the VIEWPORT, not the whole document. Rendering doc.body
      // uncropped scales with scroll height: a long list page produced a
      // viewport-wide × full-scroll-height PNG that blew past the server's
      // size cap (413, report dead-ended) and previewed as a sliver. What
      // the user sees when they hit the button is the bug context anyway.
      // Falls back to the uncropped capture when viewport geometry is
      // unavailable (headless hosts, exotic embeds).
      var viewW = (doc.documentElement && doc.documentElement.clientWidth) || (win && win.innerWidth) || 0;
      var viewH = (doc.documentElement && doc.documentElement.clientHeight) || (win && win.innerHeight) || 0;
      var scrollX = (win && (win.scrollX != null ? win.scrollX : win.pageXOffset)) || 0;
      var scrollY = (win && (win.scrollY != null ? win.scrollY : win.pageYOffset)) || 0;
      var cropped = viewW > 0 && viewH > 0;

      var opts = {
        useCORS: true,
        logging: false,
        scale: scale,
        // Exclude the widget itself — both the floating button and the
        // modal — so neither contributes pixels to its own screenshot.
        // Also honor an opt-out attribute consumers can mark on their
        // own elements (e.g. a password field, a sensitive widget).
        ignoreElements: function (el) {
          if (!el) return false;
          if (el.id === btnId || el.id === modalId) return true;
          if (el.getAttribute && el.getAttribute("data-bug-report-exclude") != null) return true;
          return false;
        },
      };
      if (cropped) {
        opts.x = scrollX;
        opts.y = scrollY;
        opts.width = viewW;
        opts.height = viewH;
        opts.windowWidth = viewW;
        opts.windowHeight = viewH;
      }

      try {
        html2canvas(doc.body, opts).then(function (canvas) {
          // Frame rects are viewport-relative; so is the canvas when
          // cropped. Uncropped, positions are body-relative.
          var origin = cropped
            ? { left: 0, top: 0 }
            : doc.body.getBoundingClientRect();
          // paste any same-origin iframe content in before serialising
          return compositeIframes(html2canvas, doc, canvas, scale, origin).then(function (merged) {
            try {
              if (isBlankCanvas(merged)) { settle(null); return; }
              settle(encodeCanvasUnderCap(merged, cfg.maxScreenshotBytes || DEFAULTS.maxScreenshotBytes, doc));
            } catch (e) { settle(null); }
          });
        }).catch(function () { settle(null); });
      } catch (e) { settle(null); }
    });
  }

  // ─── DOM construction (browser only) ───────────────────────────────

  function styleStr(obj) {
    var parts = [];
    for (var k in obj) parts.push(k + ":" + obj[k]);
    return parts.join(";");
  }

  function buildButton(doc, cfg, onClick) {
    var btn = doc.createElement("button");
    btn.id = cfg.idPrefix + "-button";
    btn.type = "button";
    btn.setAttribute("aria-label", "Report a bug");
    btn.setAttribute("data-bug-report-exclude", "true");
    btn.textContent = "🐛";
    var size = Math.max(24, Math.min(96, Number(cfg.buttonSize) || 52));
    btn.style.cssText = styleStr({
      position: "fixed",
      bottom: "calc(env(safe-area-inset-bottom, 0px) + " + cfg.position.bottom + "px)",
      right: "calc(env(safe-area-inset-right, 0px) + " + cfg.position.right + "px)",
      "z-index": "99998",
      width: size + "px",
      height: size + "px",
      "border-radius": "50%",
      border: "0",
      background: cfg.theme.buttonBg,
      color: cfg.theme.buttonInk,
      "box-shadow": "0 6px 18px rgba(0,0,0,0.22), 0 0 0 0.5px rgba(0,0,0,0.08)",
      "font-size": Math.round(size * 0.46) + "px",
      "line-height": "1",
      "font-family": cfg.theme.font,
      cursor: "grab",
      padding: "0",
      "user-select": "none",
      "touch-action": "none",
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
    });

    var pos = loadStoredPos(cfg);
    if (pos) applyAbsolutePos(btn, pos.left, pos.top);

    btn.addEventListener("click", function (e) {
      if (btn._suppressClick) { btn._suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
      onClick();
    });
    makeDraggable(btn, cfg);
    return btn;
  }

  function applyAbsolutePos(btn, left, top) {
    btn.style.left = left + "px";
    btn.style.top = top + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  }

  function loadStoredPos(cfg) {
    try {
      var raw = (typeof localStorage !== "undefined") && localStorage.getItem(cfg.storageKey);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.top === "number") return p;
    } catch (e) {}
    return null;
  }

  function savePos(cfg, left, top) {
    try { localStorage.setItem(cfg.storageKey, JSON.stringify({ left: left, top: top })); } catch (e) {}
  }

  function makeDraggable(btn, cfg) {
    var dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0, moved = false;
    btn.addEventListener("pointerdown", function (e) {
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      var rect = btn.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      btn.style.cursor = "grabbing";
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    });
    btn.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      var W = btn.offsetWidth, H = btn.offsetHeight;
      var L = Math.max(4, Math.min(window.innerWidth - W - 4, origLeft + dx));
      var T = Math.max(4, Math.min(window.innerHeight - H - 4, origTop + dy));
      applyAbsolutePos(btn, L, T);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      btn.style.cursor = "grab";
      try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        btn._suppressClick = true;
        var rect = btn.getBoundingClientRect();
        savePos(cfg, rect.left, rect.top);
      }
    }
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);
  }

  function buildModal(doc, cfg, callbacks) {
    var t = cfg.theme;
    var overlay = doc.createElement("div");
    overlay.id = cfg.idPrefix + "-modal";
    overlay.setAttribute("data-bug-report-exclude", "true");
    overlay.style.cssText = styleStr({
      position: "fixed", inset: "0", "z-index": "100000",
      background: "rgba(0,0,0,0.5)",
      display: "flex", "align-items": "flex-end", "justify-content": "center",
      padding: "0", "font-family": t.font,
    });

    var box = doc.createElement("div");
    box.style.cssText = styleStr({
      background: t.modalBg, color: t.modalInk,
      "border-radius": "16px 16px 0 0",
      padding: "16px",
      "max-width": "560px", width: "100%", "max-height": "92vh",
      overflow: "auto",
      "box-shadow": "0 -8px 24px rgba(0,0,0,0.2)",
      "padding-bottom": "calc(env(safe-area-inset-bottom, 0px) + 16px)",
    });
    overlay.appendChild(box);
    // On wider screens, center the modal instead of bottom-sheet.
    if (typeof window !== "undefined" && window.innerWidth > 720) {
      overlay.style.alignItems = "center";
      overlay.style.padding = "24px";
      box.style.borderRadius = t.radius;
      box.style.paddingBottom = "16px";
    }

    var title = doc.createElement("h2");
    title.textContent = "Report a bug";
    title.style.cssText = "font-size:18px;font-weight:600;margin:0 0 6px 0";
    box.appendChild(title);

    var hint = doc.createElement("p");
    hint.id = overlay.id + "-hint";
    hint.style.cssText = "font-size:13px;color:" + t.mutedInk + ";margin:0 0 12px 0";
    hint.textContent = "Capturing screenshot…";
    box.appendChild(hint);

    var preview = doc.createElement("img");
    preview.id = overlay.id + "-preview";
    preview.alt = "";
    preview.style.cssText = "display:none;max-width:100%;max-height:220px;border-radius:10px;margin:0 0 12px 0;background:rgba(0,0,0,0.04)";
    box.appendChild(preview);

    var textarea = doc.createElement("textarea");
    textarea.id = overlay.id + "-textarea";
    textarea.placeholder = "What happened? What did you expect?";
    textarea.style.cssText = styleStr({
      width: "100%", "min-height": "110px",
      padding: "10px 12px",
      border: "0.5px solid rgba(0,0,0,0.18)",
      "border-radius": "10px",
      "font-family": "inherit", "font-size": "16px",
      "box-sizing": "border-box", resize: "vertical",
      background: t.modalBg, color: t.modalInk,
    });
    box.appendChild(textarea);

    var error = doc.createElement("div");
    error.id = overlay.id + "-error";
    error.style.cssText = "color:" + t.errorInk + ";font-size:13px;margin-top:8px;display:none";
    box.appendChild(error);

    var actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px";
    box.appendChild(actions);

    var cancel = doc.createElement("button");
    cancel.id = overlay.id + "-cancel";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:8px 14px;border:0;background:transparent;color:" + t.accent + ";border-radius:10px;cursor:pointer;font:inherit";
    actions.appendChild(cancel);

    var submit = doc.createElement("button");
    submit.id = overlay.id + "-submit";
    submit.type = "button";
    submit.textContent = "Submit";
    submit.style.cssText = "padding:10px 18px;border:0;background:" + t.accent + ";color:#fff;border-radius:10px;cursor:pointer;font:inherit;font-weight:600";
    actions.appendChild(submit);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) callbacks.onCancel && callbacks.onCancel();
    });
    cancel.addEventListener("click", function () { callbacks.onCancel && callbacks.onCancel(); });
    // Double-submit guard. The POST is async and nothing here changed on the
    // first tap, so on a phone — where the tap target is small and the network
    // is slow — people tap again. That filed the same report 2-3 times, seconds
    // apart, roughly doubling the queue for mobile reporters.
    //
    // NOTE the asymmetry: onSubmit calls showError(null) on the SUCCESS path to
    // clear any previous message, immediately before the fetch. So only a
    // TRUTHY msg may restore the button — re-enabling on every showError call
    // would undo the guard at the exact moment it's needed.
    var submitting = false;
    function resetSubmit() {
      submitting = false;
      submit.disabled = false;
      submit.style.opacity = "";
      submit.style.cursor = "pointer";
      submit.textContent = "Submit";
    }
    submit.addEventListener("click", function () {
      if (submitting) return;
      submitting = true;
      submit.disabled = true;
      submit.style.opacity = "0.6";
      submit.style.cursor = "default";
      submit.textContent = "Submitting\u2026";
      callbacks.onSubmit && callbacks.onSubmit(textarea.value, function showError(msg) {
        error.textContent = msg || "";
        error.style.display = msg ? "block" : "none";
        if (msg) resetSubmit();   // a real failure — let them try again
      });
    });
    return overlay;
  }

  function buildToast(doc, cfg, message) {
    var toast = doc.createElement("div");
    toast.id = cfg.idPrefix + "-toast";
    toast.setAttribute("data-bug-report-exclude", "true");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    toast.style.cssText = styleStr({
      position: "fixed",
      top: "max(env(safe-area-inset-top, 0px), 14px)",
      left: "50%", transform: "translateX(-50%)",
      "z-index": "100001",
      background: cfg.theme.toastBg, color: cfg.theme.toastInk,
      padding: "10px 16px",
      "border-radius": "14px",
      "font-family": cfg.theme.font, "font-size": "14px",
      "backdrop-filter": "blur(20px)",
      "-webkit-backdrop-filter": "blur(20px)",
    });
    return toast;
  }

  function removeById(doc, id) {
    var el = doc.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ─── Controller (one per page) ─────────────────────────────────────

  function createController(opts) {
    opts = opts || {};
    var cfg = mergeConfig(opts.config);
    var deps = {
      document: opts.document,
      window: opts.window,
      fetch: opts.fetch,
      html2canvas: opts.html2canvas,
    };
    var resolvedBuildSha = function () {
      var b = cfg.buildSha;
      if (typeof b === "function") return b() || "";
      return b || "";
    };

    var capturedDataUrl = null;
    var modalId = cfg.idPrefix + "-modal";
    var btnId = cfg.idPrefix + "-button";
    var toastId = cfg.idPrefix + "-toast";

    function showToast(message) {
      removeById(deps.document, toastId);
      var t = buildToast(deps.document, cfg, message);
      deps.document.body.appendChild(t);
      deps.window && deps.window.setTimeout && deps.window.setTimeout(function () {
        removeById(deps.document, toastId);
      }, 3500);
    }

    function closeModal() {
      capturedDataUrl = null;
      removeById(deps.document, modalId);
    }

    function openModal() {
      if (deps.document.getElementById(modalId)) return;  // re-entry guard

      var overlay = buildModal(deps.document, cfg, {
        onCancel: closeModal,
        onSubmit: function (description, showError) {
          if (!description || !description.trim()) {
            showError("Please describe what happened.");
            return;
          }
          showError(null);
          var body = buildPostBody({
            details: description.trim(),
            screenshot: capturedDataUrl,
            metaUrl: (deps.window && deps.window.location && deps.window.location.href) || "",
            metaUserAgent: (deps.window && deps.window.navigator && deps.window.navigator.userAgent) || "",
            metaBuildSha: resolvedBuildSha(),
            tags: ["bug"],
            addedBy: "web",
          });
          deps.fetch(cfg.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then(function (resp) {
            if (!resp || !resp.ok) {
              return resp.json().catch(function () { return {}; }).then(function (data) {
                var msg = (data && (data.error && (data.error.message || data.error))) ||
                          ("Could not submit (HTTP " + (resp && resp.status) + ")");
                showError(String(msg));
              });
            }
            closeModal();
            showToast("Bug report submitted — thank you!");
          }).catch(function (e) {
            showError("Network error: " + (e && e.message));
          });
        },
      });
      deps.document.body.appendChild(overlay);

      var ta = deps.document.getElementById(modalId + "-textarea");
      if (ta && ta.focus) try { ta.focus(); } catch (_) {}

      // Capture in the background. Modal is excluded via ignoreElements,
      // so this is safe even though the modal is now visible.
      var hintEl = deps.document.getElementById(modalId + "-hint");
      var previewEl = deps.document.getElementById(modalId + "-preview");
      captureScreenshot(deps, cfg).then(function (dataUrl) {
        capturedDataUrl = dataUrl;
        // Modal may have been closed by the user mid-capture; only paint
        // if it's still in the DOM.
        if (!deps.document.getElementById(modalId)) return;
        if (dataUrl) {
          if (previewEl) { previewEl.src = dataUrl; previewEl.style.display = "block"; }
          if (hintEl) { hintEl.textContent = "Screenshot captured."; }
        } else {
          if (hintEl) { hintEl.textContent = "Screenshot unavailable — you can still submit text."; }
        }
      });
    }

    function ensureButton() {
      if (!deps.document || !deps.document.body) return null;
      var existing = deps.document.getElementById(btnId);
      if (existing) return existing;
      var btn = buildButton(deps.document, cfg, openModal);
      deps.document.body.appendChild(btn);
      return btn;
    }

    function inject() { ensureButton(); }

    return {
      inject: inject,
      openModal: openModal,
      closeModal: closeModal,
      _config: cfg,
      _state: function () {
        return {
          buttonMounted: !!deps.document.getElementById(btnId),
          modalOpen: !!deps.document.getElementById(modalId),
          capturedDataUrl: capturedDataUrl,
        };
      },
    };
  }

  function init() {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    var flag = "__bugReportControllerInited";
    if (window[flag]) return window[flag];
    var controller = createController({
      document: document,
      window: window,
      fetch: window.fetch.bind(window),
      html2canvas: window.html2canvas,
      config: window.BugReportConfig || {},
    });
    window[flag] = controller;
    controller.inject();
    return controller;
  }

  return {
    init: init,
    createController: createController,
    buildPostBody: buildPostBody,
    isBlankCanvas: isBlankCanvas,
    captureScreenshot: captureScreenshot,
    dataUrlBytes: dataUrlBytes,
    encodeCanvasUnderCap: encodeCanvasUnderCap,
    DEFAULTS: DEFAULTS,
  };
});
