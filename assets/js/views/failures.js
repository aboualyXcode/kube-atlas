// Failures. The index shows symptoms fanning out to causes, where failures start on each map, and
// every entry by layer, with a paste box that matches kubectl and AWS output. The detail page
// animates the failure across its map and keeps the six parts in tabs.
// Routes: #/failures?symptom=<id> | ?mode=origins&map=<id>&at=<station> | ?mode=list | ?mode=paste
//         #/failures/<id>?tab=<symptom|component|cause|investigate|fix|prevent|all>
(function (KA) {
  "use strict";
  var u = KA.u, ui = KA.ui, esc = u.esc, md = KA.md, R = KA.route;
  var TABS = [["symptom", "Symptom"], ["component", "Component"], ["cause", "Cause"], ["investigate", "Investigate"], ["fix", "Fix"], ["prevent", "Prevent"]];
  var view = {};

  view.mount = function (main, route) {
    var ctx = { main: main };
    view.update(ctx, route);
    return ctx;
  };
  view.unmount = function (ctx) { teardown(ctx); };

  function teardown(ctx) {
    if (ctx.prop) ctx.prop.stop();
    if (ctx.map) ctx.map.destroy();
    if (ctx.ro) ctx.ro.disconnect();
    ctx.prop = ctx.map = ctx.ro = null;
  }

  view.update = function (ctx, route) {
    var id = route.parts[0];
    if (id && KA.idx.failure(id)) return detail(ctx, KA.idx.failure(id), route.query.tab || "symptom");
    return index(ctx, route.query);
  };

  // ================================================================ index
  function index(ctx, q) {
    var mode = q.mode === "origins" || q.mode === "list" ? q.mode : "symptoms";
    if (ctx.kind !== "index") {
      teardown(ctx);
      ctx.kind = "index";
      ctx.failureId = null;
      ctx.f = ui.frame(ctx.main, "stage--failures");
      pasteZone(ctx);
      u.on(ctx.f.body, "pointerover", ".fan-cause", function (ev, el) { hitLine(ctx, el.getAttribute("data-i")); });
      u.on(ctx.f.body, "pointerout", ".fan-cause", function () { hitLine(ctx, null); });
    }
    ctx.q = q;
    ctx.mode = mode;
    var D = KA.data, causes = D.failures.filter(function (f) { return f.kind === "cause"; }).length;
    ctx.f.head.innerHTML = '<div class="seg" role="group" aria-label="View">' +
      [["symptoms", "From a symptom"], ["origins", "Where they start"], ["list", "All failures"]].map(function (m) {
        return '<a class="' + (mode === m[0] ? "is-on" : "") + '" href="' + R.build(["failures"], m[0] === "symptoms" ? {} : { mode: m[0] }) + '">' + m[1] + "</a>";
      }).join("") + "</div>" +
      (mode === "origins" ? '<div class="seg seg--small" role="group" aria-label="Map">' + ["cluster", "eks"].map(function (m) {
        return '<a class="' + ((q.map || "cluster") === m ? "is-on" : "") + '" href="' + R.build(["failures"], { mode: "origins", map: m }) + '">' + (m === "eks" ? "EKS map" : "Cluster map") + "</a>";
      }).join("") + "</div>" : "") +
      '<p class="head-note">' + D.failures.length + " failures: " + causes + " name a cause, " + (D.failures.length - causes) + " describe a symptom.</p>";

    if (ctx.map && (mode !== "origins" || ctx.mapId !== (q.map || "cluster"))) { ctx.map.destroy(); ctx.map = null; }
    if (ctx.ro && mode !== "symptoms") { ctx.ro.disconnect(); ctx.ro = null; }
    if (mode === "symptoms") fan(ctx, q.symptom);
    if (mode === "origins") origins(ctx, q.map || "cluster", q.at);
    if (mode === "list") list(ctx);
    if (q.mode === "paste") setTimeout(function () { var t = u.$("#paste", ctx.f.panel); if (t) t.focus(); }, 30);
    KA.setTitle("Failures");
  }

  function pasteZone(ctx) {
    var samples = [["oomkilled", "a crashing pod"], ["alb-targets-unhealthy", "ALB 503s"], ["dns-timeouts", "a DNS timeout"], ["pod-aws-access-denied", "AccessDenied"]];
    ui.setPanel(ctx.f,
      '<section class="paste"><h1 class="paste-h">What is the cluster telling you?</h1>' +
      '<label for="paste">Paste a pod status, an event, <code>kubectl describe</code> output or a log line.</label>' +
      '<textarea id="paste" rows="6" spellcheck="false" autocomplete="off" placeholder="Warning  FailedScheduling  default-scheduler  0/6 nodes are available: 3 Insufficient cpu"></textarea>' +
      '<p class="paste-try"><span>Try</span> ' + samples.map(function (s) { return '<button type="button" class="chip" data-sample="' + s[0] + '">' + s[1] + "</button>"; }).join(" ") + "</p>" +
      '<div class="paste-results" aria-live="polite"></div>' +
      '<p class="note">Matching runs in your browser; nothing is sent anywhere.</p></section>' +
      '<section class="panel-ctx"></section>');
    var ta = u.$("#paste", ctx.f.panel);
    var timer = null;
    ta.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { runMatch(ctx, ta.value); }, 120); });
    u.on(ctx.f.panel, "click", "[data-sample]", function (ev, el) {
      ta.value = KA.text(KA.idx.failure(el.getAttribute("data-sample")).samples[0]);
      runMatch(ctx, ta.value);
    });
  }

  function runMatch(ctx, text) {
    var box = u.$(".paste-results", ctx.f.panel);
    ctx.hit = null;
    if (!text.trim()) { box.innerHTML = ""; refreshHits(ctx); return; }
    var res = KA.match(text, 5);
    if (!res.length) {
      box.innerHTML = '<p class="empty">No entry matched. Paste more context, such as the Events section of <code>kubectl describe</code>.</p>';
      refreshHits(ctx);
      return;
    }
    var top = res[0].score;
    ctx.hit = res[0].id;
    box.innerHTML = '<ol class="results">' + res.map(function (m) {
      var f = KA.idx.failure(m.id);
      return '<li><a href="#/failures/' + m.id + '">' + ui.kind(f.kind) + "<b>" + esc(KA.shortTitle(f.title)) + '</b><span class="score" aria-label="score ' + m.score + '"><span style="width:' + Math.round(m.score / top * 100) + '%"></span></span></a></li>';
    }).join("") + "</ol>" +
      (res.length > 1 && KA.idx.failure(res[0].id).kind === "cause" ? '<p class="note">The best match names a cause. Lower matches are the symptoms it produces.</p>' : "");
    refreshHits(ctx);
  }

  function refreshHits(ctx) {
    if (ctx.kind !== "index") return;
    if (ctx.mode === "symptoms") {
      if (ctx.hit) {
        var sym = KA.idx.symptomsFor(ctx.hit)[0];
        if (sym && (!ctx.q.symptom || ctx.q.symptom !== sym.id)) { fan(ctx, sym.id); return; }
      }
      u.$$(".fan-cause", ctx.f.body).forEach(function (a) { a.classList.toggle("is-hit", a.getAttribute("href") === "#/failures/" + ctx.hit); });
      drawLines(ctx);
    }
    if (ctx.mode === "origins" && ctx.map) originsState(ctx);
    if (ctx.mode === "list") u.$$(".ix a", ctx.f.body).forEach(function (a) { a.classList.toggle("is-hit", a.getAttribute("href") === "#/failures/" + ctx.hit); });
  }

  // ---------------------------------------------------------------- symptom fan
  function fan(ctx, symId) {
    var T = KA.data.triage;
    var sym = T.filter(function (s) { return s.id === symId; })[0] || T[0];
    ctx.fanSym = sym.id;
    var groups = u.uniq(T.map(function (s) { return s.group; }));
    ctx.f.body.innerHTML = '<div class="fan">' +
      '<nav class="fan-list" aria-label="Symptoms">' + groups.map(function (g) {
        return '<p class="fan-group">' + esc(g) + "</p>" + T.filter(function (s) { return s.group === g; }).map(function (s) {
          return '<a class="fan-sym' + (s.id === sym.id ? " is-on" : "") + '"' + (s.id === sym.id ? ' aria-current="true"' : "") + ' href="' + R.build(["failures"], { symptom: s.id }) + '">' + esc(s.label) + '<span class="n">' + s.causes.length + "</span></a>";
        }).join("");
      }).join("") + "</nav>" +
      '<div class="fan-stage"><svg class="fan-lines" aria-hidden="true"></svg>' +
      '<div class="fan-root"><p class="fan-k">You see</p><h2>' + esc(sym.label) + "</h2><p>" + esc(sym.see) + "</p>" + ui.code(sym.check) + "</div>" +
      '<ol class="fan-causes" aria-label="Possible causes">' + sym.causes.map(function (c, i) {
        var f = KA.idx.failure(c.id);
        return '<li><a class="fan-cause' + (c.id === ctx.hit ? " is-hit" : "") + '" data-i="' + i + '" href="#/failures/' + c.id + '">' +
          '<span class="fc-top">' + ui.kind(f.kind) + ui.layer(f.layer) + "</span><b>" + esc(c.label || KA.shortTitle(f.title)) + "</b>" +
          '<span class="fc-tell"><span class="fc-if">If you see</span> ' + esc(c.tell) + "</span></a></li>";
      }).join("") + "</ol></div></div>";
    var stage = u.$(".fan-stage", ctx.f.body);
    if (ctx.ro) ctx.ro.disconnect();
    if (window.ResizeObserver) { ctx.ro = new ResizeObserver(function () { drawLines(ctx); }); ctx.ro.observe(stage); }
    drawLines(ctx);
    u.$(".panel-ctx", ctx.f.panel).innerHTML =
      "<h2>Symptoms and causes</h2><p>A <b>symptom</b> says where to look: <code>Pending</code>, <code>CrashLoopBackOff</code>, a 503. A <b>cause</b> names the mechanism: <code>OOMKilled</code>, <code>Insufficient cpu</code>, <code>x509</code>. Pick what you see on the left; the message in each box tells the causes apart.</p>";
  }

  function drawLines(ctx) {
    var stage = u.$(".fan-stage", ctx.f.body);
    if (!stage) return;
    var svgEl = u.$(".fan-lines", stage), root = u.$(".fan-root", stage);
    if (!svgEl || getComputedStyle(svgEl).display === "none") return;
    var sr = stage.getBoundingClientRect(), rr = root.getBoundingClientRect();
    svgEl.setAttribute("viewBox", "0 0 " + sr.width + " " + sr.height);
    svgEl.setAttribute("width", sr.width);
    svgEl.setAttribute("height", sr.height);
    var x0 = rr.right - sr.left, y0 = rr.top + Math.min(rr.height / 2, 60) - sr.top;
    svgEl.innerHTML = u.$$(".fan-cause", stage).map(function (a) {
      var r = a.getBoundingClientRect(), x1 = r.left - sr.left, y1 = r.top + r.height / 2 - sr.top, mx = (x0 + x1) / 2;
      return '<path data-i="' + a.getAttribute("data-i") + '" class="' + (a.classList.contains("is-hit") ? "is-hit" : "") + '" d="M' + x0 + " " + y0 + " C" + mx + " " + y0 + " " + mx + " " + y1 + " " + (x1 - 2) + " " + y1 + '"/>';
    }).join("") + '<circle class="fan-hub" cx="' + x0 + '" cy="' + y0 + '" r="5"/>';
  }

  function hitLine(ctx, i) {
    u.$$(".fan-lines path", ctx.f.body).forEach(function (p) { p.classList.toggle("is-near", p.getAttribute("data-i") === i); });
  }

  // ---------------------------------------------------------------- where failures start
  function origins(ctx, mapId, at) {
    var mapDef = KA.data.maps[mapId];
    if (!ctx.map) {
      ctx.f.body.innerHTML = "";
      ctx.mapId = mapId;
      ctx.map = KA.Map(ctx.f.body, mapDef, {
        onSelect: function (id) { R.go(R.build(["failures"], { mode: "origins", map: mapId, at: id })); },
        onBackground: function () { R.go(R.build(["failures"], { mode: "origins", map: mapId })); },
      });
      var counts = {};
      KA.data.failures.forEach(function (f) {
        if (f.propagation.map === mapId) f.propagation.origins.forEach(function (o) { counts[o.at] = (counts[o.at] || 0) + 1; });
      });
      ctx.map.badges(counts);
    }
    ctx.at = at && ctx.map.has(at) ? at : null;
    originsState(ctx);
    var list = ctx.at ? KA.idx.originatingAt(ctx.at, mapId) : [];
    u.$(".panel-ctx", ctx.f.panel).innerHTML = ctx.at ?
      "<h2>Failures that start at " + esc(KA.geom.label(mapDef, ctx.at)) + "</h2><ul class=\"faillist\">" + list.map(function (f) {
        return '<li><a href="#/failures/' + f.id + '">' + ui.kind(f.kind) + "<b>" + esc(KA.shortTitle(f.title)) + "</b><span>" + esc(f.summary) + "</span></a></li>";
      }).join("") + "</ul>" :
      "<h2>Where failures start</h2><p>Each red number counts the failures on this map that begin at that component. Most begin in your own objects and pods, or in AWS, and are noticed somewhere else. Click a component to list them.</p>";
  }

  function originsState(ctx) {
    ctx.map.clear();
    if (ctx.at) ctx.map.select(ctx.at);
    var f = ctx.hit && KA.idx.failure(ctx.hit);
    if (f && f.propagation.map === ctx.mapId) {
      ctx.map.dim(true);
      f.propagation.origins.forEach(function (o) { ctx.map.addClass(o.at, "is-origin"); ctx.map.callout(o.at, KA.shortTitle(f.title), "cause"); });
    }
  }

  // ---------------------------------------------------------------- index by layer
  function list(ctx) {
    ctx.f.body.innerHTML = '<div class="ix">' + KA.data.layers.map(function (l) {
      var fs = KA.data.failures.filter(function (f) { return f.layer === l.id; });
      return '<section class="ix-layer"><h3>' + esc(l.name) + "</h3><p>" + esc(l.hint) + "</p><ul>" + fs.map(function (f) {
        return '<li><a class="' + (f.id === ctx.hit ? "is-hit" : "") + '" href="#/failures/' + f.id + '">' + ui.kind(f.kind) + "<span>" + esc(KA.shortTitle(f.title)) + "</span></a></li>";
      }).join("") + "</ul></section>";
    }).join("") + "</div>";
    u.$(".panel-ctx", ctx.f.panel).innerHTML = "<h2>Every failure, by layer</h2><p>Each entry has the same six parts: symptom, affected component, root cause, investigation, resolution and prevention, plus an animated path on the map.</p>";
  }

  // ================================================================ detail
  function detail(ctx, f, tab) {
    if (ctx.kind === "detail" && ctx.failureId === f.id) { showTab(ctx, f, tab); return; }
    var P = f.propagation;
    if (ctx.kind !== "detail" || ctx.mapId !== P.map) {
      teardown(ctx);
      ctx.f = ui.frame(ctx.main, "stage--failure");
      ctx.mapId = P.map;
      ctx.map = KA.Map(ctx.f.body, KA.data.maps[P.map], { onSelect: function (id) { R.go("#/" + ui.viewFor(id) + "/c/" + id); } });
      u.on(ctx.f.head, "click", "[data-replay]", function () { replay(ctx); });
      u.on(ctx.f.panel, "click", "[data-tab]", function (ev, el) {
        R.go(R.build(["failures", ctx.failureId], { tab: el.getAttribute("data-tab") }), true);
      });
      u.on(ctx.f.panel, "pointerover", "[data-focus]", function (ev, el) { ctx.map.focus(el.getAttribute("data-focus")); });
      u.on(ctx.f.panel, "pointerout", "[data-focus]", function () { ctx.map.focus(null); });
      u.on(ctx.f.panel, "focusin", "[data-focus]", function (ev, el) { ctx.map.focus(el.getAttribute("data-focus")); });
    }
    ctx.kind = "detail";
    ctx.failureId = f.id;
    ctx.f.head.innerHTML = '<ul class="legend legend--prop"><li><span class="key key--origin"></span>Starts here</li><li><span class="key key--path"></span>Passes through</li><li><span class="key key--symptom"></span>You notice it</li><li><span class="key key--branch"></span>Knock-on effect</li></ul>' +
      '<button type="button" class="btn" data-replay>Replay</button>';
    var syms = KA.idx.symptomsFor(f.id);
    ui.setPanel(ctx.f,
      '<a class="back" href="' + (syms.length ? R.build(["failures"], { symptom: syms[0].id }) : "#/failures") + '">' + esc(syms.length ? syms[0].label : "All failures") + "</a>" +
      '<header class="ph"><p class="chips">' + ui.kind(f.kind) + ui.layer(f.layer) + ui.scope(f.scope) + "</p><h1>" + esc(f.title) + "</h1></header>" +
      '<p class="lede">' + esc(f.summary) + "</p>" +
      KA.Prop.strip(f) +
      '<div class="tabs" role="tablist" aria-label="Entry parts">' + TABS.map(function (t) {
        return '<button type="button" role="tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
      }).join("") + '<button type="button" role="tab" data-tab="all" class="tab-all">All</button></div>' +
      '<div class="tabpanel" role="tabpanel"></div>' + extras(f));
    showTab(ctx, f, tab);
    replay(ctx);
    KA.setTitle(KA.shortTitle(f.title));
  }

  function replay(ctx) {
    if (ctx.prop) ctx.prop.stop();
    ctx.prop = KA.Prop.play(ctx.map, KA.idx.failure(ctx.failureId));
  }

  function part(f, t) {
    if (t === "symptom") return md.render(f.symptom) + "<h3>What it looks like</h3>" + f.samples.map(function (s) { return md.codeBlock(KA.text(s)); }).join("");
    if (t === "component") return md.render(f.affected) + '<h3>Components involved</h3><p class="chips">' + f.components.map(function (id) { return ui.compChip(id); }).join("") + "</p>";
    if (t === "cause") return md.render(f.rootCause);
    if (t === "investigate") return '<ol class="inv">' + f.investigation.map(function (s) {
      return "<li><h3>" + md.inline(s.title) + "</h3>" + md.codeBlock(KA.text(s.run)) + '<p class="look"><b>Look for</b> ' + md.inline(s.lookFor) + "</p></li>";
    }).join("") + "</ol>";
    if (t === "fix") return md.render(f.resolution);
    if (t === "prevent") {
      var al = KA.idx.alertsFor(f.id);
      return "<ul>" + f.prevention.map(function (p) { return "<li>" + md.inline(p) + "</li>"; }).join("") + "</ul>" +
        (al.length ? "<h3>Alerts that lead here</h3><ul class=\"alerts\">" + al.map(function (a) {
          return '<li><span class="sev sev--' + a.severity + '">' + esc(a.severity) + "</span><code>" + esc(a.alert) + "</code> " + esc(a.summary.replace(/\{\{[^}]*\}\}/g, "…")) + "</li>";
        }).join("") + "</ul>" : "");
    }
    return "";
  }

  function showTab(ctx, f, tab) {
    var valid = tab === "all" || TABS.some(function (t) { return t[0] === tab; });
    if (!valid) tab = "symptom";
    u.$$("[data-tab]", ctx.f.panel).forEach(function (b) {
      var on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    u.$(".tabpanel", ctx.f.panel).innerHTML = tab === "all" ?
      TABS.map(function (t) { return '<section class="part"><h2>' + t[1] + "</h2>" + part(f, t[0]) + "</section>"; }).join("") :
      part(f, tab);
  }

  function extras(f) {
    var out = "";
    if (f.related.length) out += "<h2>Related</h2><p class=\"chips\">" + KA.failChips(f.related) + "</p>";
    var bps = KA.idx.breakpoints(f.id);
    if (bps.length) out += "<h2>Where it breaks a flow</h2><ul class=\"flowlist flowlist--plain\">" + bps.map(function (b) {
      var v = b.flow.map === "eks" ? "eks" : "architecture";
      return '<li><a href="#/' + v + "/flow/" + b.flow.id + "/" + (b.step + 1) + '">' + esc(b.flow.title) + ", step " + (b.step + 1) + ": " + esc(b.flow.steps[b.step].title) + "</a></li>";
    }).join("") + "</ul>";
    var inc = KA.idx.incidentsFor(f.id);
    if (inc.length) out += "<h2>Seen in an incident</h2><ul class=\"flowlist flowlist--plain\">" + inc.map(function (x) {
      return '<li><a href="#/incidents/' + x.id + '">' + esc(x.title) + "</a></li>";
    }).join("") + "</ul>";
    var rbs = KA.idx.runbooksFor(f.id);
    if (rbs.length) out += "<h2>Runbooks</h2><ul class=\"flowlist flowlist--plain\">" + rbs.map(function (r) {
      return '<li><a href="#/operations/runbooks/' + r.id + '">' + esc(r.title) + "</a></li>";
    }).join("") + "</ul>";
    if (f.lab) out += "<h2>Reproduce it locally</h2>" + md.codeBlock("make kind-up\nmake lab LAB=" + f.lab + "\nkubectl get pods -n lab-" + f.lab + " -w\nmake lab-clean LAB=" + f.lab) +
      '<p class="note">The lab file <a href="labs/' + f.lab + '.yaml"><code>labs/' + f.lab + ".yaml</code></a> says what to observe and asks one question before giving the fix.</p>";
    return out;
  }

  KA.views = KA.views || {};
  KA.views.failures = view;
})(window.KA);
