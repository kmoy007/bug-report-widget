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

  // The canvas is filled white first, so "drew nothing" means all white, not
  // transparent. Same 8x8 sample as the widget's own isBlankCanvas. Pure (takes
  // anything with width, height and getContext("2d").getImageData), so it is
  // unit-tested in Node. Unreadable (tainted) counts as NOT blank: the fallback
  // to html2canvas would not read it any better.
  function blank(c) {
    try {
      var ctx = c.getContext("2d"), n = 8;
      for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) {
        var px = Math.min(c.width - 1, Math.floor((x + 0.5) * c.width / n));
        var py = Math.min(c.height - 1, Math.floor((y + 0.5) * c.height / n));
        var d = ctx.getImageData(px, py, 1, 1).data;
        if (!(d[0] === 255 && d[1] === 255 && d[2] === 255)) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  // The options html-to-image gets for a given html2canvas-style call. Pure.
  function toImageOptions(opts) {
    opts = opts || {};
    var o = {
      pixelRatio: opts.scale || 1,
      cacheBust: false,
      backgroundColor: "#ffffff",
      filter: function (n) {
        if (n.nodeType !== 1) return true;
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
    if (typeof module === "object" && module.exports) module.exports = { blank: blank, toImageOptions: toImageOptions };
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
    var o = toImageOptions(opts);
    var unpin = pinSvgStyles(el);
    return h2i.toCanvas(el, o).then(function (c) {
      unpin();
      if (blank(c)) throw new Error("blank");
      return c;
    }).catch(function () { unpin(); return real(el, opts); });
  };
})();
