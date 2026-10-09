// Operations as diagrams. Routes: #/operations/<section> where section is observe, respond,
// runbooks, upgrade, capacity, contract or security; a query picks the item shown in the panel.
(function (KA) {
  "use strict";
  var u = KA.u, ui = KA.ui, esc = u.esc, md = KA.md, R = KA.route;
  var SECTIONS = [
    ["observe", "Observe", "What to watch at every layer, and when to page"],
    ["respond", "Respond", "The investigation loop and the first fifteen minutes"],
    ["runbooks", "Runbooks", "What to do when an alert fires, as flowcharts"],
    ["upgrade", "Upgrade", "The order of an EKS upgrade and what breaks"],
    ["capacity", "Capacity", "How many pods fit on a node, and why"],
    ["contract", "Workload contract", "What a production Deployment declares"],
    ["security", "Security", "The layers around a pod"],
  ];
  var view = {};

  view.mount = function (main, route) {
    var ctx = { f: ui.frame(main, "stage--ops") };
    view.update(ctx, route);
    return ctx;
  };
  view.unmount = function () {};

  view.update = function (ctx, route) {
    var sec = SECTIONS.some(function (s) { return s[0] === route.parts[0]; }) ? route.parts[0] : "observe";
    var title = SECTIONS.filter(function (s) { return s[0] === sec; })[0];
    ctx.f.head.innerHTML = '<div class="seg" role="group" aria-label="Section">' + SECTIONS.map(function (s) {
      return '<a href="#/operations/' + s[0] + '" class="' + (s[0] === sec ? "is-on" : "") + '">' + esc(s[1]) + "</a>";
    }).join("") + "</div>";
    var nav = '<header class="ph"><p class="eyebrowless">Operations</p><h1>' + esc(title[1]) + "</h1></header><p class=\"lede\">" + esc(title[2]) + ".</p>";
    SECTION[sec](ctx, route, nav);
    KA.setTitle(title[1]);
  };

  function link(sec, q) { return R.build(["operations", sec], q); }

  var SECTION = {};

  // ---------------------------------------------------------------- observe
  SECTION.observe = function (ctx, route, nav) {
    var O = KA.data.ops.observe, sel = O.layers.filter(function (l) { return l.id === route.query.layer; })[0];
    ctx.f.body.innerHTML = '<div class="stack"><div class="stack-axis" aria-hidden="true"><span>Page on what users feel</span><span>Ticket on causes below</span></div><ol class="stack-rows">' +
      O.layers.map(function (l) {
        return '<li><a class="stack-row' + (sel === l ? " is-on" : "") + '" href="' + link("observe", { layer: l.id }) + '">' +
          '<span class="sr-name">' + esc(l.name) + '</span><span class="sr-sig">' + l.metrics.map(function (m) { return "<code>" + esc(m) + "</code>"; }).join("") + "</span>" +
          '<span class="sr-alert sr-alert--' + l.alert + '"><b>' + (l.alert === "page" ? "Page" : "Ticket") + "</b> " + esc(l.alertText) + "</span></a></li>";
      }).join("") + "</ol></div>";
    var alerts = KA.data.alerts, pages = alerts.filter(function (a) { return a.severity === "page"; });
    var detail = sel ?
      '<a class="back" href="#/operations/observe">All layers</a><h2>' + esc(sel.name) + "</h2><p>" + esc(sel.why) + "</p><h3>Metrics</h3><ul>" + sel.metrics.map(function (m) { return "<li><code>" + esc(m) + "</code></li>"; }).join("") +
      "</ul><h3>Logs and events</h3><ul>" + sel.logs.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul><h3>A query to keep</h3>" + ui.code(sel.query) :
      "<h2>Alert on symptoms, ticket on causes</h2>" + ui.table(["Kind", "Severity", "Fires on", "Goes to"], O.kinds) +
      "<h2>SLO burn-rate alerts</h2><p>For a 99.9% availability SLO, alert on how fast the error budget burns, over a long and a short window.</p>" + ui.table(["Burn rate", "Long window", "Short window", "Budget spent", "Severity"], O.burn) +
      '<h2>Dashboards, in the order you open them</h2><ol class="dash">' + O.dashboards.map(function (d) { return "<li><b>" + esc(d[0]) + "</b> " + esc(d[1]) + "</li>"; }).join("") + "</ol>" +
      "<h2>Alert rules in this repository</h2><p><code>reference/observability/alerts.yaml</code> holds " + alerts.length + " rules: " + pages.length + " page, " + (alerts.length - pages.length) + " open tickets. Each links to a failure entry or a runbook.</p>" +
      '<ul class="alerts">' + alerts.map(function (a) {
        var to = a.leadsTo.split(":"), href = to[0] === "failure" ? "#/failures/" + to[1] : "#/operations/runbooks/" + to[1];
        return '<li><span class="sev sev--' + a.severity + '">' + a.severity + '</span><a href="' + href + '"><code>' + esc(a.alert) + "</code></a></li>";
      }).join("") + "</ul>";
    ui.setPanel(ctx.f, nav + detail);
  };

  // ---------------------------------------------------------------- respond
  function split2(t) {
    if (t.length <= 20) return [t];
    var mid = Math.floor(t.length / 2), a = t.lastIndexOf(" ", mid), b = t.indexOf(" ", mid);
    var cut = a < 0 ? b : b < 0 ? a : (mid - a <= b - mid ? a : b);
    return [t.slice(0, cut), t.slice(cut + 1)];
  }
  SECTION.respond = function (ctx, route, nav) {
    var Rs = KA.data.ops.respond, n = Rs.loop.length, sel = route.query.step != null ? +route.query.step : -1;
    var cx = 310, cy = 205, rx = 205, ry = 150, svg = '<svg class="loop" viewBox="0 0 620 410" role="img" aria-label="The investigation loop">';
    svg += '<ellipse class="loop-ring" cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '"/>';
    svg += '<text class="loop-c" x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle">The investigation loop</text><text class="loop-c2" x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle">from symptom to cause</text>';
    Rs.loop.forEach(function (s, i) {
      var a0 = (-90 + (i + 0.5) * 360 / n) * Math.PI / 180, ax = cx + rx * Math.cos(a0), ay = cy + ry * Math.sin(a0);
      var tx = -rx * Math.sin(a0), ty = ry * Math.cos(a0), rot = Math.atan2(ty, tx) * 180 / Math.PI;
      svg += '<path class="loop-arrow" d="M-6 -5L6 0L-6 5Z" transform="translate(' + ax.toFixed(1) + " " + ay.toFixed(1) + ") rotate(" + rot.toFixed(1) + ')"/>';
    });
    Rs.loop.forEach(function (s, i) {
      var a = (-90 + i * 360 / n) * Math.PI / 180, x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a), lines = split2(s.t), h = lines.length > 1 ? 50 : 38;
      svg += '<a href="' + link("respond", { step: i }) + '" class="loop-node' + (i === sel ? " is-on" : "") + '"><g transform="translate(' + x.toFixed(1) + " " + y.toFixed(1) + ')">' +
        '<rect x="-98" y="' + (-h / 2) + '" width="196" height="' + h + '" rx="' + (h / 2) + '"/><circle cx="-76" cy="0" r="13"/><text class="loop-n" x="-76" y="1" text-anchor="middle" dominant-baseline="central">' + (i + 1) + "</text>" +
        lines.map(function (l, k) { return '<text x="-56" y="' + ((k - (lines.length - 1) / 2) * 17 + 1) + '" dominant-baseline="central">' + esc(l) + "</text>"; }).join("") + "</g></a>";
    });
    svg += "</svg>";
    var tl = '<h2 class="canvas-h">The first fifteen minutes</h2><ol class="timeline">' + Rs.first15.map(function (s) {
      return '<li class="' + (s.yes ? "tl-decide" : "") + '"><span>' + esc(s.t) + "</span>" + (s.yes ? '<div class="tl-branches"><p><b>Yes</b> ' + esc(s.yes) + "</p><p><b>No</b> " + esc(s.no) + "</p></div>" : "") + "</li>";
    }).join("") + "</ol>";
    ctx.f.body.innerHTML = '<div class="respond">' + svg + tl + "</div>";
    var st = Rs.loop[sel];
    var detail = st ?
      '<a class="back" href="#/operations/respond">The whole loop</a><h2>' + (sel + 1) + ". " + esc(st.t) + "</h2><p>" + esc(st.d) + "</p>" + (st.run ? "<h3>Commands</h3>" + ui.code(st.run) : "") +
      '<nav class="hop-nav">' + (sel > 0 ? '<a class="btn" href="' + link("respond", { step: sel - 1 }) + '">Previous</a>' : "<span></span>") +
      (sel < n - 1 ? '<a class="btn btn--primary" href="' + link("respond", { step: sel + 1 }) + '">Next</a>' : "") + "</nav>" :
      "<h2>Severity</h2>" + ui.table(["Level", "Means", "Response"], Rs.severity) +
      "<h2>Roles</h2>" + ui.table(["Role", "Does", "Does not"], Rs.roles) +
      "<h2>The operations lead's first commands</h2>" + ui.code(Rs.checklist) +
      '<p class="note">Practise the loop on the <a href="#/incidents">incident replays</a>.</p>';
    ui.setPanel(ctx.f, nav + detail);
  };

  // ---------------------------------------------------------------- runbooks
  function plain(s) { return String(s || "").replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); }
  function shortItem(it) {
    if (it.title) return it.title;
    var t = plain(it.text).split(/(?<=[.:;])\s/)[0];
    if (t) return t.length > 78 ? t.slice(0, 76) + "…" : t;
    return "Run: " + KA.text(it.run).split("\n")[0].slice(0, 60);
  }
  SECTION.runbooks = function (ctx, route, nav) {
    var rbs = KA.data.runbooks, rb = KA.idx.runbook(route.parts[1]) || rbs[0], sel = route.query.item;
    ctx.f.body.innerHTML = '<div class="rb"><header class="rb-head"><h2>' + esc(rb.title) + "</h2>" +
      "<p><b>Trigger</b> " + md.inline(rb.trigger) + "</p>" + (rb.impact ? "<p><b>Impact</b> " + md.inline(rb.impact) + "</p>" : "") + "</header>" +
      '<ol class="rb-lanes">' + rb.phases.map(function (p, pi) {
        return '<li class="rb-lane"><div class="rb-phase"><span class="rb-n">' + (pi + 1) + "</span><b>" + esc(p.title) + "</b>" + (p.hint ? "<small>" + esc(p.hint) + "</small>" : "") + "</div>" +
          '<div class="rb-items">' + p.items.map(function (it, ii) {
            var key = pi + ":" + ii;
            if (it.when) return '<div class="rb-item rb-item--branch"><span class="rb-if">If you see</span> ' + md.inline(it.when) + ' <span class="rb-then">then</span> ' + md.inline(it.then) + "</div>";
            return '<a class="rb-item' + (sel === key ? " is-on" : "") + (it.run ? " rb-item--cmd" : "") + '" href="' + R.build(["operations", "runbooks", rb.id], { item: key }) + '">' + esc(shortItem(it)) + "</a>";
          }).join("") + "</div></li>";
      }).join("") + "</ol></div>";
    var item = null;
    if (sel) { var k = sel.split(":"); item = rb.phases[+k[0]] && rb.phases[+k[0]].items[+k[1]]; }
    var detail = '<h2>All runbooks</h2><ul class="rblist">' + rbs.map(function (r) {
      return '<li><a class="' + (r === rb ? "is-on" : "") + '" href="#/operations/runbooks/' + r.id + '">' + esc(r.title) + "</a></li>";
    }).join("") + "</ul>";
    if (item) {
      detail = '<a class="back" href="#/operations/runbooks/' + rb.id + '">' + esc(rb.title) + "</a><h2>" + esc(item.title || shortItem(item)) + "</h2>" +
        (item.text ? md.render(item.text) : "") + (item.run ? ui.code(item.run) : "") + detail;
    }
    ui.setPanel(ctx.f, nav + detail);
  };

  // ---------------------------------------------------------------- upgrade
  SECTION.upgrade = function (ctx, route, nav) {
    var U = KA.data.ops.upgrade, sel = route.query.step != null ? +route.query.step : -1;
    var skew = '<svg class="skew" viewBox="0 0 520 170" role="img" aria-label="Version skew: kubelets may be up to three minor versions older than the API server; kubectl within one">' +
      ["n−3", "n−2", "n−1", "n", "n+1"].map(function (v, i) { var x = 150 + i * 80; return '<line class="sk-grid" x1="' + x + '" y1="20" x2="' + x + '" y2="150"/><text class="sk-ax" x="' + x + '" y="166" text-anchor="middle">' + v + "</text>"; }).join("") +
      [["API server", 3, 3, "sk-cp"], ["kubelets", 0, 3, "sk-node"], ["kubectl", 2, 4, "sk-cli"]].map(function (r, i) {
        var y = 40 + i * 40, x0 = 150 + r[1] * 80, x1 = 150 + r[2] * 80;
        return '<text class="sk-l" x="10" y="' + (y + 5) + '">' + r[0] + '</text><rect class="' + r[3] + '" x="' + (x0 - 12) + '" y="' + (y - 11) + '" width="' + (x1 - x0 + 24) + '" height="22" rx="11"/>';
      }).join("") + "</svg>";
    ctx.f.body.innerHTML = '<div class="upg"><ol class="seq">' + U.steps.map(function (s, i) {
      return '<li><a class="seq-step' + (i === sel ? " is-on" : "") + '" href="' + link("upgrade", { step: i }) + '"><span class="seq-n">' + (i + 1) + "</span><b>" + esc(s.t) + "</b>" +
        (s.risks.length ? '<small>' + u.plural(s.risks.length, "known failure") + "</small>" : "") + "</a></li>";
    }).join("") + '</ol><h2 class="canvas-h">Version skew you are allowed</h2>' + skew + "</div>";
    var s = U.steps[sel];
    var detail = s ?
      '<a class="back" href="#/operations/upgrade">Whole sequence</a><h2>' + (sel + 1) + ". " + esc(s.t) + "</h2><p>" + esc(s.d) + "</p>" + (s.run ? ui.code(s.run) : "") +
      (s.risks.length ? "<h3>What can break here</h3><p class=\"chips\">" + KA.failChips(s.risks) + "</p>" : "") :
      "<h2>Facts that shape the order</h2>" + ui.table(["Fact", "So"], U.facts) +
      '<p>The full procedure, with commands and checks, is the <a href="#/operations/runbooks/cluster-upgrade">cluster upgrade runbook</a>.</p>';
    ui.setPanel(ctx.f, nav + detail);
  };

  // ---------------------------------------------------------------- capacity
  SECTION.capacity = function (ctx, route, nav) {
    var C = KA.data.ops.capacity;
    ctx.f.body.innerHTML = '<div class="capacity"><h2 class="canvas-h">How many pods fit on one node</h2><div class="calc-host"></div></div>';
    ui.capacity(u.$(".calc-host", ctx.f.body));
    ui.setPanel(ctx.f, nav + "<h2>Five things that run out</h2>" +
      ui.table(["Dimension", "Measure", "Runs out as", "Entry"], C.dimensions.map(function (d) { return [d[0], d[1], d[2], d[3].map(function (id) { return "[" + KA.shortTitle(KA.idx.failure(id).title) + "](#/failures/" + id + ")"; }).join(", ")]; })) +
      "<h2>Rules that keep capacity predictable</h2><ul>" + C.rules.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" +
      "<h2>Find over-requested workloads</h2>" + ui.code(C.query));
  };

  // ---------------------------------------------------------------- contract
  SECTION.contract = function (ctx, route, nav) {
    var C = KA.data.ops.contract, sel = C.spots[route.query.spot] ? route.query.spot : "resources";
    ctx.f.body.innerHTML = '<div class="contract"><p class="canvas-h">The production Deployment for orders-api. Highlighted lines are part of the contract: select one.</p><pre class="manifest">' + C.manifest.map(function (l) {
      return l[0] ? '<a class="ml ml--spot' + (l[0] === sel ? " is-on" : "") + '" href="' + link("contract", { spot: l[0] }) + '">' + esc(l[1]) + "</a>" : '<span class="ml">' + esc(l[1]) + "</span>";
    }).join("\n") + "</pre></div>";
    var s = C.spots[sel];
    ui.setPanel(ctx.f, nav + "<h2>" + esc(s.t) + "</h2><p>" + esc(s.d) + "</p>" +
      (s.prevents.length ? "<h3>Prevents</h3><p class=\"chips\">" + KA.failChips(s.prevents) + "</p>" : "") +
      '<h3>The whole contract</h3><p class="chips">' + Object.keys(C.spots).map(function (k) {
        return '<a class="chip' + (k === sel ? " is-on" : "") + '" href="' + link("contract", { spot: k }) + '">' + esc(C.spots[k].t) + "</a>";
      }).join("") + '</p><p class="note">The full manifests live in <a href="reference/apps/orders-api.yaml"><code>reference/apps/</code></a>.</p>');
  };

  // ---------------------------------------------------------------- security
  SECTION.security = function (ctx, route, nav) {
    var rings = KA.data.ops.security.rings, sel = route.query.ring != null && rings[+route.query.ring] ? +route.query.ring : 0;
    var c = 300, svg = '<svg class="rings" viewBox="0 0 600 600" role="img" aria-label="Security layers from the AWS account inwards to the pod">';
    rings.forEach(function (r, i) {
      var rad = 290 - i * 38;
      svg += '<a href="' + link("security", { ring: i }) + '" class="ring ring--' + i + (i === sel ? " is-on" : "") + '"><circle cx="' + c + '" cy="' + c + '" r="' + rad + '"/>' +
        '<text x="' + c + '" y="' + (c - rad + 23) + '" text-anchor="middle">' + esc(r.t) + "</text></a>";
    });
    svg += "</svg>";
    ctx.f.body.innerHTML = '<div class="security">' + svg + "</div>";
    var r = rings[sel];
    ui.setPanel(ctx.f, nav + "<h2>" + esc(r.t) + "</h2><p>" + esc(r.d) + "</p><h3>Controls</h3><ul>" + r.controls.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" +
      (r.failures.length ? "<h3>Failures in this layer</h3><p class=\"chips\">" + KA.failChips(r.failures) + "</p>" : "") +
      '<nav class="hop-nav">' + (sel > 0 ? '<a class="btn" href="' + link("security", { ring: sel - 1 }) + '">Outer layer</a>' : "<span></span>") +
      (sel < rings.length - 1 ? '<a class="btn btn--primary" href="' + link("security", { ring: sel + 1 }) + '">Inner layer</a>' : "") + "</nav>");
  };

  KA.views = KA.views || {};
  KA.views.operations = view;
})(window.KA);
