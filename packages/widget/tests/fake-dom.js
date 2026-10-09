// A small fake DOM with a real tree (unlike the flat id maps in the older test
// files): elements have parents, getElementById only finds what is still
// attached, and appendChild MOVES a node, which is what the reparenting tests
// are about. Not a test file itself (npm test globs tests/*.test.js).

function makeDom() {
  function matchSimple(node, sel) {
    sel = sel.trim();
    var m;
    if ((m = /^\[id="(.+)"\]$/.exec(sel))) return node.id === m[1];
    if ((m = /^#(.+)$/.exec(sel))) return node.id === m[1];
    if ((m = /^(\w+)\[(\w+)\]$/.exec(sel))) return node.tagName === m[1] && node._attrs[m[2]] != null;
    if (/^\w+$/.test(sel)) return node.tagName === sel;
    return false;
  }

  function el(tag) {
    var node = {
      nodeType: 1, tagName: tag, id: "", children: [], parentNode: null,
      style: {}, _attrs: {}, _l: {}, textContent: "", value: "", disabled: false,
      src: "", title: "", offsetWidth: 40, offsetHeight: 40, clientWidth: 800, clientHeight: 600,
      appendChild: function (c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        this.children.push(c); c.parentNode = this; return c;
      },
      removeChild: function (c) {
        this.children = this.children.filter(function (x) { return x !== c; });
        c.parentNode = null; return c;
      },
      remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute: function (k, v) { this._attrs[k] = v; },
      getAttribute: function (k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
      removeAttribute: function (k) { delete this._attrs[k]; },
      addEventListener: function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
      removeEventListener: function (t, fn) { this._l[t] = (this._l[t] || []).filter(function (f) { return f !== fn; }); },
      dispatch: function (t, ev) {
        ev = ev || {};
        var self = this;
        if (!("preventDefault" in ev)) ev.preventDefault = function () { ev.defaultPrevented = true; };
        if (!("stopPropagation" in ev)) ev.stopPropagation = function () {};
        (this._l[t] || []).slice().forEach(function (f) { f.call(self, ev); });
        return ev;
      },
      click: function () { this.dispatch("click", { target: this }); },
      focus: function () {},
      setPointerCapture: function () {}, releasePointerCapture: function () {},
      getBoundingClientRect: function () { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; },
      matches: function (sel) { return sel === ":modal" ? !!this._modal : matchSimple(this, sel); },
      querySelectorAll: function (sel) {
        var out = [];
        (function walk(n) {
          n.children.forEach(function (c) { if (matchSimple(c, sel)) out.push(c); walk(c); });
        })(this);
        return out;
      },
      querySelector: function (sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    return node;
  }

  var html = el("html"), body = el("body"), head = el("head");
  html.appendChild(head); html.appendChild(body);
  var doc = {
    documentElement: html, body: body, head: head,
    createElement: function (tag) {
      var e = el(tag);
      if (tag === "canvas") {
        e.width = 0; e.height = 0;
        e.getContext = function () { return e._ctx || (e._ctx = makeCtx()); };
        e.toDataURL = function () { return "data:image/png;base64,AAAA"; };
      }
      return e;
    },
    getElementById: function (id) { return html.querySelector('[id="' + id + '"]'); },
    querySelectorAll: function (sel) { return html.querySelectorAll(sel); },
    querySelector: function (sel) { return html.querySelector(sel); },
    getElementsByTagName: function () { return []; },
    _l: {},
    addEventListener: function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener: function (t, fn) { this._l[t] = (this._l[t] || []).filter(function (f) { return f !== fn; }); },
    dispatch: function (t, ev) {
      ev = ev || {};
      if (!("preventDefault" in ev)) ev.preventDefault = function () { ev.defaultPrevented = true; };
      (this._l[t] || []).slice().forEach(function (f) { f(ev); });
      return ev;
    },
    listenerCount: function (t) { return (this._l[t] || []).length; },
  };
  return doc;
}

// A canvas 2D context that records what was asked of it.
function makeCtx() {
  var calls = [];
  var ctx = { calls: calls };
  ["clearRect", "drawImage", "beginPath", "moveTo", "lineTo", "stroke", "strokeRect", "fillRect"].forEach(function (n) {
    ctx[n] = function () { calls.push(n); };
  });
  ctx.count = function (n) { return calls.filter(function (c) { return c === n; }).length; };
  return ctx;
}

module.exports = { makeDom: makeDom, makeCtx: makeCtx };
