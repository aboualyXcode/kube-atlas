// The map renderer. Draws a map definition (districts, stations, edges) as SVG and exposes the
// states every view uses: dim, select, lens, hops with moving tokens, callouts, step marks and
// failure badges. The geometry helpers at the top have no DOM dependency; tests use them to
// check that no station overlaps another and no edge runs through a station.
(function (KA) {
  "use strict";

  // ---------------------------------------------------------------- geometry
  function P(p) { return Math.round(p.x * 10) / 10 + " " + Math.round(p.y * 10) / 10; }
  function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }
  function towards(from, to, len) {
    var L = dist(from, to) || 1;
    return { x: from.x + (to.x - from.x) * len / L, y: from.y + (to.y - from.y) * len / L };
  }
  function anchor(b, tx, ty, pad) {
    var dx = tx - b.x, dy = ty - b.y;
    if (!dx && !dy) return { x: b.x, y: b.y };
    var hw = b.w / 2 + pad, hh = b.h / 2 + pad;
    var s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: b.x + dx * s, y: b.y + dy * s };
  }
  // When a routed edge leaves a station, leave at right angles if the waypoint lines up with it.
  function orthoAnchor(b, p, pad) {
    if (p.x >= b.x - b.w / 2 && p.x <= b.x + b.w / 2) return { x: p.x, y: p.y < b.y ? b.y - b.h / 2 - pad : b.y + b.h / 2 + pad };
    if (p.y >= b.y - b.h / 2 && p.y <= b.y + b.h / 2) return { x: p.x < b.x ? b.x - b.w / 2 - pad : b.x + b.w / 2 + pad, y: p.y };
    return anchor(b, p.x, p.y, pad);
  }
  function boxes(map) {
    var out = {};
    map.stations.forEach(function (s) { out[s.id] = { id: s.id, x: s.x, y: s.y, w: s.w || 160, h: s.h || 46 }; });
    return out;
  }
  function edgePoints(a, b, via) {
    if (!via || !via.length) return [anchor(a, b.x, b.y, 3), anchor(b, a.x, a.y, 3)];
    var v = via.map(function (p) { return { x: p[0], y: p[1] }; });
    return [orthoAnchor(a, v[0], 3)].concat(v, [orthoAnchor(b, v[v.length - 1], 3)]);
  }
  function rounded(pts, r) {
    if (pts.length === 2) return "M" + P(pts[0]) + "L" + P(pts[1]);
    var d = "M" + P(pts[0]);
    for (var i = 1; i < pts.length - 1; i++) {
      var a = pts[i - 1], b = pts[i], c = pts[i + 1];
      var rr = Math.min(r, dist(a, b) / 2, dist(b, c) / 2);
      d += "L" + P(towards(b, a, rr)) + "Q" + P(b) + " " + P(towards(b, c, rr));
    }
    return d + "L" + P(pts[pts.length - 1]);
  }
  function pointAt(pts, t) {
    var total = 0, i, segs = [];
    for (i = 0; i < pts.length - 1; i++) { var l = dist(pts[i], pts[i + 1]); segs.push(l); total += l; }
    var want = total * t;
    for (i = 0; i < segs.length; i++) {
      if (want <= segs[i] || i === segs.length - 1) return towards(pts[i], pts[i + 1], Math.min(want, segs[i]));
      want -= segs[i];
    }
    return pts[0];
  }
  function arc(a, b, bend) {
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var off = Math.min(140, len * 0.22) * (bend || 1);
    var c = { x: (a.x + b.x) / 2 - dy / len * off, y: (a.y + b.y) / 2 + dx / len * off };
    var s = anchor(a, c.x, c.y, 4), e = anchor(b, c.x, c.y, 4);
    return "M" + P(s) + "Q" + P(c) + " " + P(e);
  }
  // Liang-Barsky: does the segment p-q pass through box b (shrunk by `shrink`)?
  function segHitsBox(p, q, b, shrink) {
    var x0 = b.x - b.w / 2 + shrink, x1 = b.x + b.w / 2 - shrink, y0 = b.y - b.h / 2 + shrink, y1 = b.y + b.h / 2 - shrink;
    var t0 = 0, t1 = 1, dx = q.x - p.x, dy = q.y - p.y;
    var pp = [-dx, dx, -dy, dy], qq = [p.x - x0, x1 - p.x, p.y - y0, y1 - p.y];
    for (var i = 0; i < 4; i++) {
      if (pp[i] === 0) { if (qq[i] < 0) return false; continue; }
      var r = qq[i] / pp[i];
      if (pp[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 < t1;
  }
  function problems(map) {
    var out = [], B = boxes(map), ids = Object.keys(B);
    ids.forEach(function (id, i) {
      var a = B[id];
      if (a.x - a.w / 2 < 0 || a.y - a.h / 2 < 0 || a.x + a.w / 2 > map.width || a.y + a.h / 2 > map.height) out.push(map.id + ": station " + id + " is outside the map");
      ids.slice(i + 1).forEach(function (jd) {
        var b = B[jd];
        if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 8 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 8) out.push(map.id + ": stations " + id + " and " + jd + " overlap");
      });
    });
    map.edges.forEach(function (e) {
      var a = B[e.from], b = B[e.to];
      if (!a || !b) return;
      var pts = edgePoints(a, b, e.via);
      for (var k = 0; k < pts.length - 1; k++) {
        ids.forEach(function (id) {
          if (id !== e.from && id !== e.to && segHitsBox(pts[k], pts[k + 1], B[id], 2)) out.push(map.id + ": edge " + e.from + " -> " + e.to + " runs through " + id);
        });
      }
    });
    return out;
  }
  function label(map, id) {
    var s = map.stations.filter(function (x) { return x.id === id; })[0] || {};
    var c = KA.data.components[id] || { name: id };
    return String(s.label || (map.id === "eks" && c.eksName) || c.label || c.name).replace(/\n/g, " ");
  }
  KA.geom = { anchor: anchor, orthoAnchor: orthoAnchor, boxes: boxes, edgePoints: edgePoints, rounded: rounded, pointAt: pointAt, arc: arc, segHitsBox: segHitsBox, problems: problems, label: label };

  // ---------------------------------------------------------------- renderer
  var counter = 0;
  var STATE = ["is-on", "is-active", "is-trail", "is-origin", "is-path", "is-symptom", "is-sel", "is-nb", "is-lens", "is-branch", "is-pulse"];

  KA.Map = function (host, def, opts) {
    opts = opts || {};
    var u = KA.u, svg = u.svg, D = KA.data;
    var uid = "m" + (++counter);
    var B = boxes(def);
    var full = { x: -12, y: -12, w: def.width + 24, h: def.height + 24 };
    var view = Object.assign({}, full);
    var stationEls = {}, edges = [], adj = {}, gen = 0, calloutCount = {}, marks = {}, hovered = null;

    var root = svg("svg", { class: "map", viewBox: [view.x, view.y, view.w, view.h].join(" "), role: "group", "aria-label": def.title + " map", preserveAspectRatio: "xMidYMid meet" });
    var defs = svg("defs", null, root);
    ["active", "trail", "fault", "branch", "lit"].forEach(function (k) {
      var m = svg("marker", { id: uid + "-mk-" + k, class: "mk mk--" + k, viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, defs);
      svg("path", { d: "M0 0L10 5L0 10z", fill: "currentColor" }, m);
    });
    var gDistricts = svg("g", { class: "districts" }, root);
    var gEdges = svg("g", { class: "edges" }, root);
    var gHops = svg("g", { class: "hops" }, root);
    var gStations = svg("g", { class: "stations" }, root);
    var gTop = svg("g", { class: "overlay" }, root);

    def.districts.forEach(function (d) {
      var g = svg("g", { class: "district district--" + d.tone + (d.outline ? " district--outline" : "") }, gDistricts);
      svg("rect", { x: d.x, y: d.y, width: d.w, height: d.h, rx: 18 }, g);
      svg("text", { class: "district-label", x: d.x + 16, y: d.y + 20 }, g).textContent = d.label;
    });

    def.edges.forEach(function (e) {
      var a = B[e.from], b = B[e.to];
      if (!a || !b) return;
      var pts = edgePoints(a, b, e.via);
      var g = svg("g", { class: "ed ed--" + e.kind, "data-from": e.from, "data-to": e.to }, gEdges);
      var d = rounded(pts, 14);
      svg("path", { class: "ed-line", d: d }, g);
      var mid = pointAt(pts, 0.5);
      svg("text", { class: "ed-label", x: mid.x, y: mid.y - 7, "text-anchor": "middle" }, g).textContent = e.label;
      var rec = { e: e, g: g, pts: pts, d: d };
      edges.push(rec);
      (adj[e.from] = adj[e.from] || []).push({ id: e.to, rec: rec });
      (adj[e.to] = adj[e.to] || []).push({ id: e.from, rec: rec });
    });

    def.stations.forEach(function (s) {
      var c = D.components[s.id], b = B[s.id];
      var text = (s.label || (def.id === "eks" && c.eksName) || c.label || c.name).split("\n");
      var sub = s.sub !== undefined ? s.sub : (def.id === "eks" && c.eksSub !== undefined ? c.eksSub : (c.sub || ""));
      var g = svg("g", { class: "st st--" + c.plane, "data-id": s.id, transform: "translate(" + b.x + " " + b.y + ")", tabindex: "0", role: "button", "aria-label": text.join(" ") + ", " + D.planes[c.plane].name }, gStations);
      svg("rect", { class: "st-halo", x: -b.w / 2 - 6, y: -b.h / 2 - 6, width: b.w + 12, height: b.h + 12, rx: 15 }, g);
      svg("rect", { class: "st-box", x: -b.w / 2, y: -b.h / 2, width: b.w, height: b.h, rx: 10 }, g);
      svg("rect", { class: "st-tag", x: -b.w / 2 + 7, y: -b.h / 2 + 9, width: 4, height: b.h - 18, rx: 2 }, g);
      var items = text.map(function (t) { return { t: t, cls: "st-label", lh: 17 }; });
      if (sub) items.push({ t: sub, cls: "st-sub", lh: 15 });
      var yy = -items.reduce(function (n, it) { return n + it.lh; }, 0) / 2;
      items.forEach(function (it) {
        svg("text", { class: it.cls, x: -b.w / 2 + 17, y: yy + it.lh / 2, "dominant-baseline": "central" }, g).textContent = it.t;
        yy += it.lh;
      });
      stationEls[s.id] = g;
    });

    host.appendChild(root);
    var tools = u.html('<div class="map-tools" role="group" aria-label="Zoom"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">&minus;</button><button type="button" data-z="fit">Fit</button></div>');
    host.appendChild(tools);
    tools.addEventListener("click", function (ev) {
      var z = ev.target.getAttribute("data-z");
      if (z === "in") zoom(1 / 1.3); else if (z === "out") zoom(1.3); else if (z === "fit") fit();
    });

    // ---------------------------------------------------------------- interaction
    var suppress = false, pointers = {}, drag = null, pinch = null;
    function select(id) { if (opts.onSelect) opts.onSelect(id); }
    root.addEventListener("click", function (ev) {
      if (suppress) { suppress = false; return; }
      var st = ev.target.closest && ev.target.closest(".st");
      if (st) select(st.getAttribute("data-id"));
      else if (opts.onBackground) opts.onBackground();
    });
    root.addEventListener("keydown", function (ev) {
      var st = ev.target.closest && ev.target.closest(".st");
      if (st && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); select(st.getAttribute("data-id")); }
    });
    function onHover(ev, on) {
      var st = ev.target.closest && ev.target.closest(".st");
      if (!st) return;
      if (!on && ev.relatedTarget && st.contains(ev.relatedTarget)) return;
      hover(on ? st.getAttribute("data-id") : null);
    }
    root.addEventListener("pointerover", function (ev) { onHover(ev, true); });
    root.addEventListener("pointerout", function (ev) { onHover(ev, false); });
    root.addEventListener("focusin", function (ev) { onHover(ev, true); });
    root.addEventListener("focusout", function (ev) { onHover(ev, false); });

    function setView(v) { view = v; root.setAttribute("viewBox", [v.x, v.y, v.w, v.h].join(" ")); }
    function toUser(cx, cy) {
      var m = root.getScreenCTM();
      if (!m) return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      var pt = root.createSVGPoint(); pt.x = cx; pt.y = cy;
      return pt.matrixTransform(m.inverse());
    }
    function zoom(k, cx, cy) {
      var p = cx == null ? { x: view.x + view.w / 2, y: view.y + view.h / 2 } : toUser(cx, cy);
      var nw = u.clamp(view.w * k, def.width * 0.22, def.width * 1.6), kk = nw / view.w;
      setView({ x: p.x - (p.x - view.x) * kk, y: p.y - (p.y - view.y) * kk, w: nw, h: view.h * kk });
    }
    function fit() { setView(Object.assign({}, full)); }
    root.addEventListener("wheel", function (ev) {
      if (!ev.ctrlKey && !ev.metaKey && !opts.wheelZoom) return;
      ev.preventDefault();
      zoom(ev.deltaY > 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
    }, { passive: false });
    root.addEventListener("pointerdown", function (ev) {
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 1) drag = { x: ev.clientX, y: ev.clientY, v: Object.assign({}, view), moved: false, id: ev.pointerId };
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
        drag = null;
      }
    });
    root.addEventListener("pointermove", function (ev) {
      if (!pointers[ev.pointerId]) return;
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = Object.keys(pointers);
      if (pinch && ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoom((pinch.w * pinch.d / d) / view.w, (a.x + b.x) / 2, (a.y + b.y) / 2);
        suppress = true;
        return;
      }
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) { drag.moved = true; try { root.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } root.classList.add("is-panning"); }
      var m = root.getScreenCTM(), s = m ? m.a : 1;
      setView({ x: drag.v.x - dx / s, y: drag.v.y - dy / s, w: drag.v.w, h: drag.v.h });
    });
    function endPointer(ev) {
      delete pointers[ev.pointerId];
      if (drag && drag.moved) suppress = true;
      if (Object.keys(pointers).length < 2) pinch = null;
      if (!Object.keys(pointers).length) { drag = null; root.classList.remove("is-panning"); }
    }
    root.addEventListener("pointerup", endPointer);
    root.addEventListener("pointercancel", endPointer);

    // ---------------------------------------------------------------- states
    function addClass(id, cls) {
      var g = stationEls[id];
      if (!g) return;
      g.classList.add(cls, "is-on");
    }
    function findEdge(a, b) {
      for (var i = 0; i < edges.length; i++) {
        var r = edges[i];
        if (r.e.from === a && r.e.to === b) return { rec: r, d: r.d };
        if (r.e.from === b && r.e.to === a) return { rec: r, d: rounded(r.pts.slice().reverse(), 14) };
      }
      return null;
    }
    function hover(id) {
      if (hovered === id) return;
      u.$$(".is-near", root).forEach(function (el) { el.classList.remove("is-near"); });
      hovered = id;
      root.classList.toggle("is-hover", !!id);
      if (!id) return;
      stationEls[id].classList.add("is-near");
      (adj[id] || []).forEach(function (n) { stationEls[n.id].classList.add("is-near"); n.rec.g.classList.add("is-near"); });
      if (opts.onHover) opts.onHover(id);
    }
    function clear() {
      gen++;
      gHops.textContent = "";
      gTop.textContent = "";
      calloutCount = {};
      marks = {};
      Object.keys(stationEls).forEach(function (id) { var cl = stationEls[id].classList; STATE.forEach(function (s) { cl.remove(s); }); });
      edges.forEach(function (r) { r.g.classList.remove("is-on", "is-lit"); });
      root.classList.remove("is-dim");
    }
    function dim(on) { root.classList.toggle("is-dim", on !== false); }
    function selectStation(id) {
      if (!stationEls[id]) return;
      dim(true);
      addClass(id, "is-sel");
      (adj[id] || []).forEach(function (n) { addClass(n.id, "is-nb"); n.rec.g.classList.add("is-on", "is-lit"); });
    }
    function lens(ids) {
      dim(true);
      ids.forEach(function (id) { addClass(id, "is-lens"); });
      edges.forEach(function (r) { if (ids.indexOf(r.e.from) >= 0 && ids.indexOf(r.e.to) >= 0) r.g.classList.add("is-on"); });
    }
    function pulse(id) { addClass(id, "is-pulse"); }
    function hop(a, b, o) {
      o = o || {};
      var cls = o.cls || "active", myGen = gen;
      var done = function () { if (o.done && myGen === gen) o.done(); };
      if (!B[a] || !B[b]) { done(); return null; }
      if (a === b) {
        pulse(a);
        if (o.instant || u.reducedMotion()) done(); else setTimeout(done, 520);
        return null;
      }
      var found = findEdge(a, b);
      if (found) found.rec.g.classList.add("is-on");
      var d = found ? found.d : arc(B[a], B[b], o.bend);
      var path = svg("path", { class: "hop hop--" + cls, d: d }, gHops);
      if (o.arrow !== false) path.setAttribute("marker-end", "url(#" + uid + "-mk-" + cls + ")");
      if (o.instant || o.token === false || u.reducedMotion() || !path.getTotalLength) { done(); return path; }
      var len = path.getTotalLength();
      var dur = o.dur || Math.max(450, Math.min(1000, len * 1.5));
      var tok = svg("circle", { class: "token token--" + cls, r: 6.5 }, gTop);
      var t0 = null;
      function step(ts) {
        if (myGen !== gen) return;
        if (t0 === null) t0 = ts;
        var k = Math.min(1, (ts - t0) / dur);
        var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        var p = path.getPointAtLength(len * e);
        tok.setAttribute("cx", p.x);
        tok.setAttribute("cy", p.y);
        if (k < 1) requestAnimationFrame(step);
        else { if (tok.parentNode) tok.parentNode.removeChild(tok); done(); }
      }
      requestAnimationFrame(step);
      return path;
    }
    function callout(id, text, cls) {
      var b = B[id];
      if (!b) return;
      var n = (calloutCount[id] = (calloutCount[id] || 0) + 1);
      var roomAbove = b.y - b.h / 2 - 34 > 0;
      var above = n === 1 ? roomAbove : !roomAbove;
      var y = above ? b.y - b.h / 2 - 19 : b.y + b.h / 2 + 19;
      var g = svg("g", { class: "callout callout--" + (cls || "note"), transform: "translate(" + b.x + " " + y + ")" }, gTop);
      svg("path", { d: above ? "M-6 11L0 18L6 11Z" : "M-6 -11L0 -18L6 -11Z" }, g);
      var r = svg("rect", { x: 0, y: -12, height: 24, rx: 12 }, g);
      var t = svg("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" }, g);
      t.textContent = text;
      var w = 0;
      try { w = t.getComputedTextLength(); } catch (e) { w = 0; }
      w = (w || text.length * 7) + 22;
      r.setAttribute("x", -w / 2);
      r.setAttribute("width", w);
    }
    function mark(id, text) {
      var b = B[id];
      if (!b) return;
      marks[id] = marks[id] ? marks[id] + ", " + text : String(text);
      var old = u.$('[data-mark="' + id + '"]', gTop);
      if (old) old.parentNode.removeChild(old);
      var label = marks[id], w = Math.max(24, label.length * 8 + 14);
      var g = svg("g", { class: "mark", "data-mark": id, transform: "translate(" + (b.x - b.w / 2 + 4) + " " + (b.y - b.h / 2 - 2) + ")" }, gTop);
      svg("rect", { x: -w / 2, y: -12, width: w, height: 24, rx: 12 }, g);
      svg("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" }, g).textContent = label;
    }
    function badges(counts) {
      Object.keys(stationEls).forEach(function (id) {
        var g = stationEls[id], old = g.querySelector(".st-badge");
        if (old) g.removeChild(old);
        var n = counts && counts[id];
        if (!n) return;
        var b = B[id];
        var bg = svg("g", { class: "st-badge", transform: "translate(" + (b.w / 2 - 4) + " " + (-b.h / 2 + 4) + ")" }, g);
        svg("circle", { r: 12 }, bg);
        svg("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" }, bg).textContent = n;
      });
    }
    function destroy() {
      gen++;
      if (root.parentNode) root.parentNode.removeChild(root);
      if (tools.parentNode) tools.parentNode.removeChild(tools);
    }

    return {
      el: root, def: def, clear: clear, dim: dim, addClass: addClass, select: selectStation, lens: lens,
      pulse: pulse, hop: hop, callout: callout, mark: mark, badges: badges, fit: fit, zoom: zoom,
      focus: function (id) { hover(id || null); },
      has: function (id) { return !!B[id]; },
      neighbors: function (id) { return adj[id] || []; },
      label: function (id) { return label(def, id); },
      destroy: destroy,
    };
  };
})(window.KA);
