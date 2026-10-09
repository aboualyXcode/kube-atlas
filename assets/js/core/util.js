// Small helpers shared by every view. No dependencies.
(function (KA) {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var u = {};

  u.esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  u.$ = function (sel, el) { return (el || document).querySelector(sel); };
  u.$$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  // Parse an HTML string into a single element (or a fragment when several roots).
  u.html = function (str) {
    var t = document.createElement("template");
    t.innerHTML = String(str).trim();
    return t.content.childNodes.length === 1 ? t.content.firstChild : t.content;
  };

  u.svg = function (tag, attrs, parent) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(el);
    return el;
  };

  // Event delegation: u.on(root, "click", "[data-go]", fn(event, matchedEl))
  u.on = function (root, type, sel, fn) {
    var handler = function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest(sel) : null;
      if (t && root.contains(t)) fn(ev, t);
    };
    root.addEventListener(type, handler);
    return function () { root.removeEventListener(type, handler); };
  };

  u.reducedMotion = function () {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };

  u.store = {
    get: function (k, d) { try { var v = localStorage.getItem("kube-atlas:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("kube-atlas:" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  u.copy = function (text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("is-done");
      setTimeout(function () { btn.textContent = old; btn.classList.remove("is-done"); }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

  u.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  u.uniq = function (arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); };
  u.plural = function (n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); };

  // A cancellable timer group, so views can stop animations when they unmount.
  u.timers = function () {
    var ids = [];
    return {
      after: function (ms, fn) { var id = setTimeout(fn, ms); ids.push(id); return id; },
      clear: function () { ids.forEach(clearTimeout); ids = []; },
    };
  };

  KA.u = u;
})(window.KA);
