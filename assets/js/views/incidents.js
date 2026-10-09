// Incident replays. Routes: #/incidents (list, hover to preview), #/incidents/<id> (overview),
// #/incidents/<id>/<hop> (one hop), and the hop after the last one shows the root cause.
(function (KA) {
  "use strict";
  var u = KA.u, ui = KA.ui, esc = u.esc, md = KA.md;
  var view = {};

  view.mount = function (main, route) {
    var ctx = { f: ui.frame(main, "stage--incidents") };
    u.on(ctx.f.panel, "pointerover", "[data-preview]", function (ev, el) { if (!ctx.inc) trail(ctx, KA.idx.incident(el.getAttribute("data-preview")), -1); });
    view.update(ctx, route);
    return ctx;
  };
  view.unmount = function (ctx) { if (ctx.map) ctx.map.destroy(); };

  function ensureMap(ctx, mapId) {
    if (ctx.map && ctx.mapId === mapId) return;
    if (ctx.map) ctx.map.destroy();
    ctx.mapId = mapId;
    ctx.map = KA.Map(ctx.f.body, KA.data.maps[mapId], { onSelect: function (id) { location.hash = "#/" + ui.viewFor(id) + "/c/" + id; } });
  }

  // Draw the investigation trail up to hop `n` (0-based). n = -1 draws the whole path as a preview.
  function trail(ctx, inc, n) {
    ensureMap(ctx, inc.map);
    var m = ctx.map, steps = inc.steps, last = n < 0 || n >= steps.length ? steps.length - 1 : n;
    m.clear();
    m.dim(true);
    for (var k = 0; k <= last; k++) {
      var s = steps[k], cur = k === n;
      m.addClass(s.at, cur ? "is-active" : "is-trail");
      if (k > 0) m.hop(steps[k - 1].at, s.at, cur ? { cls: "active" } : { cls: "trail", instant: true, arrow: false });
      else if (cur) m.pulse(s.at);
      m.mark(s.at, String(k + 1));
    }
    if (n >= 0 && n < steps.length) m.callout(steps[n].at, steps[n].title.length > 42 ? steps[n].title.slice(0, 40) + "…" : steps[n].title, "note");
    if (n < 0 || n >= steps.length) {
      m.addClass(steps[0].at, "is-symptom");
      m.callout(steps[0].at, "Noticed here", "symptom");
      inc.rootAt.forEach(function (id) { m.addClass(id, "is-origin"); m.callout(id, "Root cause", "cause"); });
    }
  }

  view.update = function (ctx, route) {
    var inc = route.parts[0] && KA.idx.incident(route.parts[0]);
    ctx.inc = inc || null;
    ctx.f.head.innerHTML = '<ul class="legend legend--prop"><li><span class="key key--trail"></span>Hops investigated</li><li><span class="key key--symptom"></span>Noticed here</li><li><span class="key key--origin"></span>Root cause</li></ul>';
    if (!inc) return list(ctx);
    var n = route.parts[1] ? +route.parts[1] : 0;
    if (!(n >= 0 && n <= inc.steps.length + 1)) n = 0;
    if (n === 0) return overview(ctx, inc);
    if (n <= inc.steps.length) return hop(ctx, inc, n);
    return conclusion(ctx, inc);
  };

  function list(ctx) {
    var D = KA.data;
    trail(ctx, D.incidents[0], -1);
    ui.setPanel(ctx.f,
      '<header class="ph"><h1>Incidents, replayed</h1></header>' +
      '<p class="lede">Each investigation starts from what someone noticed and follows dependencies one hop at a time until it reaches the change that caused it. The map shows the path; the panel shows each command and what it proved. Hover an incident to preview its path.</p>' +
      '<ul class="incident-list">' + D.incidents.map(function (x) {
        var stations = u.uniq(x.steps.map(function (s) { return s.at; }));
        return '<li><a href="#/incidents/' + x.id + '" data-preview="' + x.id + '"><span class="sev sev--' + x.sev.toLowerCase() + '">' + x.sev + "</span><b>" + esc(x.title) + "</b><span>" + esc(x.summary) + "</span><small>" +
          u.plural(x.steps.length, "hop") + " across " + u.plural(stations.length, "component") + "</small></a></li>";
      }).join("") + "</ul>" +
      '<h2>The method behind them</h2><p>State the symptom, find the first failing hop, read status and events, name the mechanism, then ask why until you reach a change. <a href="#/operations/respond">See the investigation loop</a>.</p>');
    KA.setTitle("Incidents");
  }

  function head(inc) {
    return '<header class="ph"><p class="chips"><span class="sev sev--' + inc.sev.toLowerCase() + '">' + inc.sev + '</span><span class="chip">' + esc(inc.when) + "</span></p><h1>" + esc(inc.title) + "</h1></header>";
  }

  function overview(ctx, inc) {
    trail(ctx, inc, -1);
    var map = KA.data.maps[inc.map];
    ui.setPanel(ctx.f, '<a class="back" href="#/incidents">All incidents</a>' + head(inc) +
      '<p class="lede">' + esc(inc.summary) + "</p>" +
      '<h2>The investigation</h2><ol class="steps">' + inc.steps.map(function (s, k) {
        return '<li><a href="#/incidents/' + inc.id + "/" + (k + 1) + '"><span class="steps-n">' + (k + 1) + "</span>" + esc(s.title) + '<small>' + esc(KA.geom.label(map, s.at)) + "</small></a></li>";
      }).join("") + "</ol>" +
      '<p><a class="cta" href="#/incidents/' + inc.id + '/1">Start the replay</a></p>');
    KA.setTitle(inc.title);
  }

  function dots(inc, n) {
    var out = '<nav class="progress" aria-label="Hops">';
    for (var k = 1; k <= inc.steps.length + 1; k++) {
      out += '<a href="#/incidents/' + inc.id + "/" + k + '" class="dot' + (k === n ? " is-on" : k < n ? " is-done" : "") + '" aria-label="' + (k > inc.steps.length ? "Root cause" : "Hop " + k) + '"></a>';
    }
    return out + "</nav>";
  }

  function hop(ctx, inc, n) {
    var s = inc.steps[n - 1], map = KA.data.maps[inc.map];
    trail(ctx, inc, n - 1);
    ui.setPanel(ctx.f, '<a class="back" href="#/incidents/' + inc.id + '">' + esc(inc.title) + "</a>" + dots(inc, n) +
      '<p class="hop-at">Hop ' + n + " of " + inc.steps.length + ", at <b>" + esc(KA.geom.label(map, s.at)) + "</b></p>" +
      "<h1 class=\"hop-title\">" + esc(s.title) + "</h1>" +
      "<h3>Run</h3>" + ui.code(s.run) +
      "<h3>It printed</h3>" + '<pre class="out">' + esc(s.output) + "</pre>" +
      '<div class="finding"><b>What it proves</b><p>' + md.inline(s.finding) + "</p></div>" +
      (s.entries && s.entries.length ? '<p class="chips"><span class="chips-k">Catalog</span> ' + KA.failChips(s.entries) + "</p>" : "") +
      '<nav class="hop-nav"><a class="btn" href="#/incidents/' + inc.id + "/" + (n - 1) + '">' + (n === 1 ? "Overview" : "Previous hop") + "</a>" +
      '<a class="btn btn--primary" href="#/incidents/' + inc.id + "/" + (n + 1) + '">' + (n === inc.steps.length ? "Root cause" : "Next hop") + "</a></nav>");
    KA.setTitle(inc.title + ", hop " + n);
  }

  function conclusion(ctx, inc) {
    trail(ctx, inc, inc.steps.length);
    var entries = u.uniq([].concat.apply([], inc.steps.map(function (s) { return s.entries || []; })));
    var C = inc.chain;
    ui.setPanel(ctx.f, '<a class="back" href="#/incidents/' + inc.id + '">' + esc(inc.title) + "</a>" + dots(inc, inc.steps.length + 1) +
      '<h1 class="hop-title">Root cause</h1><p class="lede">' + esc(inc.rootCause) + "</p>" +
      '<h2>The causal chain</h2><ol class="chain">' + C.nodes.map(function (node, i) {
        var contrib = C.contributing.filter(function (c) { return c.to === i; });
        return '<li class="chain-node' + (node.kind ? " chain-node--" + node.kind : "") + '"><span class="chain-t">' + esc(node.t) + "</span>" +
          (contrib.length ? '<ul class="chain-contrib">' + contrib.map(function (c) { return "<li>" + esc(c.t) + "</li>"; }).join("") + "</ul>" : "") + "</li>";
      }).join("") + "</ol>" +
      '<h2>What fixed it</h2><ul class="fixes">' + inc.fixes.map(function (x) { return '<li><span class="fix-k">' + esc(x.kind) + "</span>" + esc(x.text) + "</li>"; }).join("") + "</ul>" +
      (entries.length ? "<h2>Catalog entries on the way</h2><p class=\"chips\">" + KA.failChips(entries) + "</p>" : "") +
      '<nav class="hop-nav"><a class="btn" href="#/incidents/' + inc.id + "/" + inc.steps.length + '">Previous hop</a><a class="btn btn--primary" href="#/incidents">All incidents</a></nav>');
    KA.setTitle(inc.title + ", root cause");
  }

  KA.views = KA.views || {};
  KA.views.incidents = view;
})(window.KA);
