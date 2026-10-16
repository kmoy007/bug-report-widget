/* capture-engine.js — make the bug widget's screenshots look like the page.
 *
 * The widget (pinned, static/bug-report.js) draws the page with html2canvas,
 * which re-implements CSS layout and gets this page wrong: text piled on text,
 * blocks out of place (bug-20261008-203620). html-to-image hands the page to
 * the browser's own renderer instead, so it looks like what the person saw.
 *
 * The widget calls window.html2canvas(el, opts) at init, so this installs a
 * function with that signature (the bits the widget uses: x/y/width/height crop,
 * scale, ignoreElements) in front of the real one. If the new engine fails or
 * draws nothing, the real html2canvas runs, so a capture is never lost to this.
 *
 * Optional. Load AFTER html2canvas.min.js and html-to-image.js, BEFORE bug-report.js:
 *   <script src="html2canvas.min.js" defer></script>
 *   <script src="html-to-image.js" defer></script>
 *   <script src="capture-engine.js" defer></script>
 *   <script src="bug-report.js" defer></script>
 * html-to-image is MIT (html-to-image.LICENSE), v1.11.13, copied from the npm tarball.
 * Known gaps: a <video> is drawn as one still frame (1.6.6), or a dark "Video not in screenshot
 * (cross-origin)" tile when the browser will not let a script read it; cross-origin iframe content
 * is not drawn (nothing can). Same-origin frames it draws itself.
 */
(function () {
  "use strict";

  // A computed css colour as [r, g, b, a] (a in 0..1), or null if it is not one
  // of the simple forms a browser reports: rgb()/rgba() with commas or spaces
  // and an optional "/ alpha", color(srgb r g b / a), #rgb/#rrggbb, "transparent".
  function parseColor(s) {
    if (typeof s !== "string") return null;
    s = s.trim().toLowerCase();
    if (s === "transparent") return [0, 0, 0, 0];
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    m = /^(rgba?|color\(srgb)\s*\(?([^)]*)\)$/.exec(s);
    if (!m) return null;
    var parts = m[2].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    var v = parts.map(function (x) {
      return /%$/.test(x) ? parseFloat(x) / 100 : parseFloat(x);
    });
    if (v.some(isNaN)) return null;
    var srgb = m[1] !== "rgb" && m[1] !== "rgba";
    var rgb = [0, 1, 2].map(function (i) {
      var n = srgb || /%$/.test(parts[i]) ? v[i] * 255 : v[i];
      return Math.max(0, Math.min(255, Math.round(n)));
    });
    return [rgb[0], rgb[1], rgb[2], v.length === 4 ? Math.max(0, Math.min(1, v[3])) : 1];
  }

  // The colour the person SEES behind the page: the first fully opaque computed
  // background-color walking body, then the root element (a canvas paints the
  // root's background behind everything). A colour with alpha below 1, a
  // gradient/image over a transparent colour, or something unparseable is not
  // opaque, so it is skipped: we do not render gradients. Neither opaque: a page
  // that asks for a dark colour-scheme gets the browser's dark canvas colour,
  // anything else white (what every capture was before 1.6.2). Pure: `gcs` is
  // getComputedStyle-like, returning backgroundColor and colorScheme.
  function pageBackground(gcs, body, docEl) {
    var els = [body, docEl];
    for (var i = 0; i < els.length; i++) {
      if (!els[i]) continue;
      var c = parseColor((gcs(els[i]) || {}).backgroundColor);
      if (c && c[3] === 1) return "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")";
    }
    var scheme = String(((docEl && gcs(docEl)) || {}).colorScheme || "").toLowerCase();
    if (/\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)) return "#121212";
    return "#ffffff";
  }

  // The canvas is filled with the page colour first (bg, default white), so
  // "drew nothing" means all that colour, not transparent. Same 8x8 sample as
  // the widget's own isBlankCanvas. Pure (takes anything with width, height and
  // getContext("2d").getImageData), so it is unit-tested in Node. Unreadable
  // (tainted) counts as NOT blank: the fallback to html2canvas would not read
  // it any better.
  function blank(c, bg) {
    var want = parseColor(bg || "#ffffff") || [255, 255, 255, 1];
    try {
      var ctx = c.getContext("2d"), n = 8;
      for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) {
        var px = Math.min(c.width - 1, Math.floor((x + 0.5) * c.width / n));
        var py = Math.min(c.height - 1, Math.floor((y + 0.5) * c.height / n));
        var d = ctx.getImageData(px, py, 1, 1).data;
        if (!(d[0] === want[0] && d[1] === want[1] && d[2] === want[2])) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // Elements whose content the live page does not show but a capture would:
  // html-to-image renders the clone as an SVG image WITHOUT scripting, where
  // <noscript> fallback content is displayed (as raw text, e.g. a stray
  // "<button ...>go</button>"). <template> content is inert and never shown.
  // An <img> with no src draws nothing on the page, but html-to-image fails on it, and
  // one such image (a hidden pane's picture, filled when it opens) rejected the whole
  // capture, which then fell back to html2canvas and its worse picture (PlacementImageViewer,
  // 2026-10-13). Pure: takes anything with nodeType and nodeName.
  function neverShown(n) {
    if (!n || n.nodeType !== 1) return false;
    var name = String(n.nodeName || n.tagName || "").toUpperCase();
    if (name === "IMG") return !(n.getAttribute && n.getAttribute("src"));
    // A <video> with a source: html-to-image would draw it on a canvas and toDataURL() it, which
    // throws for a cross-origin video and rejects the whole capture even when the video is
    // hidden (display:none does not stop the clone). Every visible one has an <img> in its
    // place for the capture (standInVideos); a hidden one draws nothing on the page.
    // The rule is the same as standInVideos': a video with a source is replaced (visible) or draws
    // nothing (no box), so html-to-image never clones one. If a stand-in fails, the video is left
    // out of the picture rather than risking the capture.
    if (name === "VIDEO") return !!n.currentSrc;
    return name === "NOSCRIPT" || name === "TEMPLATE";
  }

  // Where object-fit puts a video's picture inside its box (bw x bh), given the picture's own
  // size (vw x vh): {x, y, w, h} in box pixels. "contain" letterboxes, "cover" fills and
  // crops, anything else (fill, none, scale-down, unknown) is treated as "fill". Pure.
  function fitRect(fit, vw, vh, bw, bh) {
    if ((fit !== "contain" && fit !== "cover") || !(vw > 0) || !(vh > 0)) return { x: 0, y: 0, w: bw, h: bh };
    var k = fit === "contain" ? Math.min(bw / vw, bh / vh) : Math.max(bw / vw, bh / vh);
    var w = vw * k, h = vh * k;
    return { x: (bw - w) / 2, y: (bh - h) / 2, w: w, h: h };
  }

  // What puts a video where it sits on the page, which a rule keyed on the element type
  // (`#rvcam .evframe video{position:absolute;inset:0;margin:auto}`) does not give an <img>:
  // copied from the video's computed style onto the stand-in, so it lands in the same place
  // and does not push the layout (StoppageViewer's Step through camera).
  var VIDEO_LAYOUT = ["position", "top", "right", "bottom", "left", "marginTop", "marginRight",
    "marginBottom", "marginLeft", "display", "cssFloat", "transform", "transformOrigin", "zIndex",
    "boxSizing", "borderRadius", "verticalAlign", "backgroundColor"];

  var VIDEO_PLACEHOLDER = "Video not in screenshot (cross-origin)";
  var VIDEO_NOT_LOADED = "Video not loaded yet";

  // A w x h dark tile with one centred line of light grey text, as a data URL. Always works
  // (a fresh canvas is never tainted).
  function tile(doc, w, h, text) {
    var t = doc.createElement("canvas");
    t.width = w; t.height = h;
    var x = t.getContext("2d");
    x.fillStyle = "#000";
    x.fillRect(0, 0, w, h);
    x.fillStyle = "#bbb";
    x.font = Math.max(12, Math.min(20, Math.round(w / 20))) + "px sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, w / 2, h / 2);
    return t.toDataURL();
  }

  // html-to-image clones a <video> by drawing it on a canvas and calling toDataURL(). A video
  // from another origin without CORS taints that canvas, toDataURL throws a SecurityError,
  // and the whole capture was rejected, so the report fell back to html2canvas, which draws
  // no video and piles the help text one letter per line (StoppageViewer bug-20261014-163549
  // and bug-20261014-231951: the clip is a signed blob URL). So for the capture each visible
  // video is stood in for by an <img> of the same look and size, put right before it, and the
  // video is only hidden (removing it would pause it or lose its place). The picture is the
  // video's current frame; if the browser will not give that up (tainted), a dark tile that
  // says so. Nothing here may throw: a video must never be the reason a capture fails.
  // Pure-ish: takes a list of video-like elements, a document, fitOf(video) -> object-fit and
  // styleOf(video) -> a getComputedStyle-like object (read before the video is hidden);
  // returns the (idempotent) function that puts everything back.
  function standInVideos(videos, doc, fitOf, styleOf) {
    var saved = [];
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      try {
        var w = v.clientWidth, h = v.clientHeight;
        if (!(w > 0 && h > 0) || !v.currentSrc || !v.parentNode) continue;
        var url;
        if (!(v.readyState >= 2) || !(v.videoWidth > 0 && v.videoHeight > 0)) {
          // no frame yet: drawImage would draw nothing and say nothing, a transparent stand-in
          url = tile(doc, w, h, VIDEO_NOT_LOADED);
        } else {
          try {
            var c = doc.createElement("canvas");
            c.width = w; c.height = h;
            var r = fitRect(fitOf(v), v.videoWidth, v.videoHeight, w, h);
            c.getContext("2d").drawImage(v, r.x, r.y, r.w, r.h);
            url = c.toDataURL();
          } catch (tainted) {
            url = tile(doc, w, h, VIDEO_PLACEHOLDER);
          }
        }
        var img = doc.createElement("img");
        img.className = v.className;
        img.style.cssText = v.style.cssText;
        var cs = null;
        try { cs = styleOf ? styleOf(v) : null; } catch (e) { /* the class and inline style alone */ }
        for (var j = 0; cs && j < VIDEO_LAYOUT.length; j++) {
          if (cs[VIDEO_LAYOUT[j]]) img.style[VIDEO_LAYOUT[j]] = cs[VIDEO_LAYOUT[j]];
        }
        img.style.width = w + "px";
        img.style.height = h + "px";
        img.src = url;
        var before = v.style.display;
        v.parentNode.insertBefore(img, v);
        v.style.display = "none";
        saved.push([v, img, before]);
      } catch (e) { /* this video stays as it was: the capture goes on without a frame of it */ }
    }
    return function () {
      var s;
      while ((s = saved.pop())) {
        try { if (s[1].parentNode) s[1].parentNode.removeChild(s[1]); } catch (e) { /* gone already */ }
        s[0].style.display = s[2];
      }
    };
  }

  // The options html-to-image gets for a given html2canvas-style call. Pure.
  function toImageOptions(opts, bg) {
    opts = opts || {};
    var o = {
      pixelRatio: opts.scale || 1,
      cacheBust: false,
      backgroundColor: bg || "#ffffff",
      filter: function (n) {
        if (n.nodeType !== 1) return true;
        if (neverShown(n)) return false;
        if (opts.ignoreElements && opts.ignoreElements(n)) return false;
        // The cost is per node, and a busy day is thousands of them. Anything
        // that starts below the visible area cannot move what is above it, so
        // leave it out (what is ABOVE the area must stay: removing it would
        // shift the visible content up).
        if (opts.height && n.getBoundingClientRect().top > opts.height + 100) return false;
        return true;
      },
    };
    if (opts.width && opts.height) {
      o.width = opts.width; o.height = opts.height;
      // draw the page shifted so the visible part lands in the canvas
      o.style = { transform: "translate(" + -(opts.x || 0) + "px," + -(opts.y || 0) + "px)",
                  transformOrigin: "0 0" };
    }
    return o;
  }

  // Node (the unit tests) has no window: expose the pure parts and stop.
  if (typeof window === "undefined") {
    if (typeof module === "object" && module.exports) module.exports = { blank: blank, toImageOptions: toImageOptions,
      pageBackground: pageBackground, parseColor: parseColor, neverShown: neverShown,
      pinSummaryMarkers: pinSummaryMarkers, fitRect: fitRect, standInVideos: standInVideos };
    return;
  }
  var real = window.html2canvas, h2i = window.htmlToImage;
  if (!real || !h2i || !h2i.toCanvas) return;

  // Inline SVG here (the day chart) is styled by CSS rules like `#chart .rate`.
  // html-to-image drops those on SVG children, so the chart came out black with
  // oversized labels. Pin the computed values onto each SVG element for the
  // length of the capture, then put the attributes back.
  var SVG_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
    "stroke-dasharray", "stroke-linejoin", "stroke-linecap", "opacity", "font-family",
    "font-size", "font-weight", "text-anchor", "dominant-baseline", "visibility"];
  function pinSvgStyles(root) {
    var saved = [];
    var nodes = root.querySelectorAll("svg *");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], cs = getComputedStyle(n), css = "";
      for (var j = 0; j < SVG_PROPS.length; j++) {
        var v = cs.getPropertyValue(SVG_PROPS[j]);
        if (v) css += SVG_PROPS[j] + ":" + v + ";";
      }
      saved.push([n, n.getAttribute("style")]);
      n.setAttribute("style", (n.getAttribute("style") || "") + ";" + css);
    }
    return function () {
      saved.forEach(function (p) {
        if (p[1] == null) p[0].removeAttribute("style"); else p[0].setAttribute("style", p[1]);
      });
    };
  }

  // A <summary> is a list item whose marker is the disclosure triangle. In the clone,
  // rendered as an SVG image, that marker came out as a decimal "1." beside the text
  // (found on PlacementImageViewer's bug queue, 2026-10-13; Chromium and WebKit alike).
  // Take the marker off for the length of the capture, then put it back: a screenshot
  // without the triangle is right, one with a stray number is not. Pure: takes a list
  // of anything with a style, and returns the function that restores them.
  function pinSummaryMarkers(summaries) {
    var saved = [];
    for (var i = 0; i < summaries.length; i++) {
      saved.push([summaries[i], summaries[i].style.listStyleType]);
      summaries[i].style.listStyleType = "none";
    }
    return function () {
      saved.forEach(function (p) { p[0].style.listStyleType = p[1]; });
    };
  }

  // The widget gives up on a capture at its captureTimeoutMs, but a promise that never settles
  // would leave the stand-ins in the live page (a video hidden, a frozen frame or dark tile
  // in its place). So the engine puts the page back by itself after this long, whatever
  // html-to-image is doing: longer than any capture the apps wait for (they use 20 s).
  var UNPIN_AFTER_MS = 30000;

  window.html2canvas = function (el, opts) {
    opts = opts || {};
    var bg = "#ffffff";
    try { bg = pageBackground(getComputedStyle, document.body, document.documentElement); } catch (e) { /* white */ }
    var o = toImageOptions(opts, bg);
    var unpinSvg = pinSvgStyles(el), unpinMarkers = pinSummaryMarkers(el.querySelectorAll("summary"));
    var videos = el.querySelectorAll("video");
    var unpinVideos = !videos.length ? function () {} : standInVideos(videos, document, function (v) {
      try { return getComputedStyle(v).objectFit; } catch (e) { return "fill"; }
    }, function (v) { return getComputedStyle(v); });
    var unpin = function () { unpinSvg(); unpinMarkers(); unpinVideos(); };
    var timer = setTimeout(unpin, UNPIN_AFTER_MS);
    var settled = function () { clearTimeout(timer); unpin(); };
    // via a then: a toCanvas that throws synchronously is a rejection, so it reaches the fallback
    return Promise.resolve().then(function () { return h2i.toCanvas(el, o); }).then(function (c) {
      settled();
      if (blank(c, bg)) throw new Error("blank");
      return c;
    }).catch(function (first) {
      settled();
      // html2canvas gets the page colour too, instead of transparent
      var ro = opts.backgroundColor == null ? Object.assign({}, opts, { backgroundColor: bg }) : opts;
      // If the fallback fails too, say why the better engine failed first:
      // otherwise the report names only the fallback's error.
      return Promise.resolve().then(function () { return real(el, ro); }).catch(function (second) {
        var why = (first && (first.message || first.type)) || String(first);
        var e = new Error(((second && second.message) || String(second)) + " (after html-to-image: " + why + ")");
        if (second && second.name) e.name = second.name;
        throw e;
      });
    });
  };
})();
