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
 * Known gaps: it does not draw <video> frames or iframe content; html2canvas does not either.
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
  // Pure: takes anything with nodeType and nodeName.
  function neverShown(n) {
    if (!n || n.nodeType !== 1) return false;
    var name = String(n.nodeName || n.tagName || "").toUpperCase();
    return name === "NOSCRIPT" || name === "TEMPLATE";
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
      pageBackground: pageBackground, parseColor: parseColor, neverShown: neverShown };
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

  window.html2canvas = function (el, opts) {
    opts = opts || {};
    var bg = "#ffffff";
    try { bg = pageBackground(getComputedStyle, document.body, document.documentElement); } catch (e) { /* white */ }
    var o = toImageOptions(opts, bg);
    var unpin = pinSvgStyles(el);
    return h2i.toCanvas(el, o).then(function (c) {
      unpin();
      if (blank(c, bg)) throw new Error("blank");
      return c;
    }).catch(function () {
      unpin();
      // html2canvas gets the page colour too, instead of transparent
      var ro = opts.backgroundColor == null ? Object.assign({}, opts, { backgroundColor: bg }) : opts;
      return real(el, ro);
    });
  };
})();
