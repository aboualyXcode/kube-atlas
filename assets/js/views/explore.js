// The map explorer behind three views: home, Architecture (cluster map) and EKS (VPC map).
// Routes: #/architecture, #/architecture/c/<component>, #/architecture/flow/<flow>/<step>,
//         #/eks?layer=<lens> (and the same /c/ and /flow/ forms).
(function (KA) {
  "use strict";
  var u = KA.u, ui = KA.ui, esc = u.esc, R = KA.route;
  var LENS_LAYERS = {
    networking: ["networking", "dns"], identity: ["identity"], "load-balancing": ["load-balancing"],
    storage: ["storage"], autoscaling: ["autoscaling", "scheduling"], security: ["identity", "control-plane"],
  };

  function lensById(id) { return KA.data.eksLayers.filter(function (l) { return l.id === id; })[0]; }
  function query(ctx) { return ctx.lens ? { layer: ctx.lens } : {}; }
  function flowItem(fl, view, q) {
    return '<li><a href="' + R.build([view, "flow", fl.id], q) + '"><b>' + esc(fl.title) + "</b><span>" + esc(fl.summary) + "</span><small>" + u.plural(fl.steps.length, "step") + "</small></a></li>";
  }
  function back(href, label) { return '<a class="back" href="' + href + '">' + esc(label) + "</a>"; }

  function prodLayout() {
    var s = '<svg class="inset" viewBox="0 0 440 300" role="img" aria-label="Production layout: three Availability Zones, each with public, node, pod and data subnets">';
    s += '<rect class="in-vpc" x="6" y="44" width="428" height="250" rx="14"/><text class="in-t" x="18" y="64">Your VPC: 10.20.0.0/16 for nodes, 100.64.0.0/16 for pods</text>';
    s += '<rect class="in-cp" x="6" y="4" width="200" height="30" rx="8"/><text class="in-t" x="16" y="24">EKS control plane (AWS account)</text>';
    s += '<rect class="in-alb" x="230" y="4" width="204" height="30" rx="8"/><text class="in-t" x="240" y="24">ALB across all three AZs</text>';
    ["a", "b", "c"].forEach(function (az, i) {
      var x = 18 + i * 140;
      s += '<rect class="in-az" x="' + x + '" y="74" width="128" height="210" rx="10"/><text class="in-t in-b" x="' + (x + 10) + '" y="92">AZ ' + az + "</text>";
      [["Public: ALB, NAT", "in-pub"], ["Nodes, EKS ENIs", "in-node"], ["Pods (prefixes)", "in-pod"], ["Data: EBS, EFS, RDS", "in-data"]].forEach(function (row, r) {
        var y = 102 + r * 45;
        s += '<rect class="' + row[1] + '" x="' + (x + 8) + '" y="' + y + '" width="112" height="36" rx="7"/><text class="in-t" x="' + (x + 16) + '" y="' + (y + 23) + '">' + row[0] + "</text>";
      });
      s += '<path class="in-link" d="M' + (105) + ' 34 L' + (x + 64) + ' 147"/>';
    });
    return s + "</svg>";
  }

  function explorer(cfg) {
    var view = {};
    view.mount = function (main, route) {
      var f = ui.frame(main, "stage--" + cfg.view);
      var mapDef = KA.data.maps[cfg.map];
      var ctx = { f: f, mapDef: mapDef, linkView: cfg.view === "home" ? "architecture" : cfg.view };
      ctx.map = KA.Map(f.body, mapDef, {
        onSelect: function (id) { R.go(R.build([ctx.linkView, "c", id], query(ctx))); },
        onBackground: function () { if (ctx.selected) R.go(R.build([ctx.linkView], query(ctx))); },
      });
      u.on(f.panel, "click", "[data-select]", function (ev, el) { R.go(R.build([ctx.linkView, "c", el.getAttribute("data-select")], query(ctx))); });
      u.on(f.panel, "click", "[data-step]", function (ev, el) { if (ctx.player) { ctx.player.pause(); ctx.player.show(+el.getAttribute("data-step")); } });
      u.on(f.panel, "pointerover", "[data-select]", function (ev, el) { ctx.map.focus(el.getAttribute("data-select")); });
      u.on(f.panel, "pointerout", "[data-select]", function () { ctx.map.focus(null); });
      view.update(ctx, route);
      return ctx;
    };

    view.update = function (ctx, route) {
      var p = route.parts;
      ctx.lens = cfg.view === "eks" && route.query.layer && lensById(route.query.layer) ? route.query.layer : null;
      head(ctx);
      if (p[0] === "flow" && ctx.player && ctx.flowId === p[1]) {
        var want = Math.max(0, (+p[2] || 1) - 1);
        if (ctx.player.index() !== want) ctx.player.show(want);
        return;
      }
      stop(ctx);
      if (p[0] === "c" && ctx.map.has(p[1])) return component(ctx, p[1]);
      var fl = p[0] === "flow" && KA.idx.flow(p[1]);
      if (fl && fl.map === cfg.map) return flow(ctx, fl, Math.max(0, (+p[2] || 1) - 1));
      if (cfg.view === "home") return home(ctx);
      if (ctx.lens) return lens(ctx);
      return cfg.view === "eks" ? eksOverview(ctx) : archOverview(ctx);
    };

    view.unmount = function (ctx) { stop(ctx); ctx.map.destroy(); };

    function stop(ctx) {
      if (ctx.player) { ctx.player.destroy(); ctx.player = null; }
      ctx.flowId = null;
      ctx.selected = null;
      ctx.map.clear();
      ctx.f.foot.innerHTML = "";
      ctx.f.foot.hidden = true;
      if (ctx.lens) ctx.map.lens(lensById(ctx.lens).stations);
    }

    function head(ctx) {
      var h = "";
      if (cfg.view === "eks") {
        h += '<div class="seg" role="group" aria-label="Lens"><a href="#/eks" class="' + (!ctx.lens ? "is-on" : "") + '">Everything</a>' +
          KA.data.eksLayers.map(function (l) { return '<a href="#/eks?layer=' + l.id + '" class="' + (ctx.lens === l.id ? "is-on" : "") + '">' + esc(l.name) + "</a>"; }).join("") + "</div>";
      }
      ctx.f.head.innerHTML = h + ui.legend();
    }

    function component(ctx, id) {
      ctx.selected = id;
      ctx.map.select(id);
      var to = cfg.view === "eks" && ctx.lens ? "#/eks?layer=" + ctx.lens : "#/" + ctx.linkView;
      ui.setPanel(ctx.f, back(to, ctx.lens ? lensById(ctx.lens).name : "Overview") + ui.inspector(id, ctx.mapDef, ctx.linkView));
      KA.setTitle(KA.data.components[id].name);
    }

    function flow(ctx, fl, start) {
      ctx.flowId = fl.id;
      var breaks = u.uniq([].concat.apply([], fl.steps.map(function (s) { return s.breaks || []; })));
      ui.setPanel(ctx.f, back("#/" + ctx.linkView + (ctx.lens ? "?layer=" + ctx.lens : ""), ctx.lens ? lensById(ctx.lens).name : "Overview") +
        '<header class="ph"><p class="eyebrowless">Flow</p><h1>' + esc(fl.title) + "</h1></header>" +
        '<p class="lede">' + esc(fl.summary) + "</p>" +
        '<ol class="steps">' + fl.steps.map(function (s, k) {
          return '<li><button type="button" data-step="' + k + '"><span class="steps-n">' + (k + 1) + "</span>" + esc(s.title) + "</button></li>";
        }).join("") + "</ol>" +
        (breaks.length ? "<h2>Where this flow can break</h2><p class=\"chips\">" + KA.failChips(breaks) + "</p>" : ""));
      ctx.f.foot.hidden = false;
      ctx.player = KA.Player(ctx.map, fl, ctx.f.foot, {
        start: start,
        onStep: function (i) {
          u.$$("[data-step]", ctx.f.panel).forEach(function (b) { b.classList.toggle("is-on", +b.getAttribute("data-step") === i); });
          R.go(R.build([ctx.linkView, "flow", fl.id, i + 1], query(ctx)), true);
        },
      });
      KA.setTitle(fl.title);
    }

    function home(ctx) {
      var D = KA.data;
      var picks = ["pending", "container-creating", "crashloop", "image-pull", "not-ready", "lb-5xx", "slow", "access-denied", "nodes", "api-errors"];
      ui.setPanel(ctx.f,
        '<header class="ph ph--home"><h1>Kubernetes and EKS, drawn as a map you can click</h1></header>' +
        '<p class="lede">Every component, what it does, how it connects to the others, and how a failure in one shows up somewhere else. The map is playing the life of a pod. Click any station to open it.</p>' +
        "<h2>What are you seeing?</h2><p class=\"chips chips--big\">" + picks.map(function (id) {
          var s = D.triage.filter(function (t) { return t.id === id; })[0];
          return s ? '<a class="chip chip--sym" href="#/failures?symptom=' + id + '">' + esc(s.label) + "</a>" : "";
        }).join("") + "</p>" +
        '<p><a class="cta" href="#/failures?mode=paste">Paste what the cluster printed</a></p>' +
        '<h2>Where to go</h2><ul class="doors">' +
        '<li><a href="#/architecture"><b>Architecture</b><span>' + Object.keys(D.components).length + " components, how each works inside, and " + KA.idx.flowsFor("cluster").length + " animated flows.</span></a></li>" +
        '<li><a href="#/eks"><b>EKS</b><span>Your VPC, IAM, load balancers, storage and autoscaling, one lens at a time.</span></a></li>' +
        '<li><a href="#/failures"><b>Failures</b><span>' + D.failures.length + " failures, each animated from where it starts to where you notice it.</span></a></li>" +
        '<li><a href="#/incidents"><b>Incidents</b><span>' + D.incidents.length + " production investigations, replayed hop by hop.</span></a></li>" +
        '<li><a href="#/operations"><b>Operations</b><span>Signals, incident response, runbooks, upgrades, capacity and security.</span></a></li></ul>');
      ctx.f.foot.hidden = false;
      ctx.player = KA.Player(ctx.map, KA.idx.flow("apply-to-running"), ctx.f.foot, { autoplay: !u.reducedMotion(), interval: 3000 });
      KA.setTitle("");
    }

    function archOverview(ctx) {
      var D = KA.data, stations = ctx.mapDef.stations.map(function (s) { return s.id; });
      ui.setPanel(ctx.f,
        '<header class="ph"><h1>How a cluster fits together</h1></header>' +
        '<p class="lede">The control plane decides what should run where; the kubelet on each node makes it happen. Every component talks through the API server, and only the API server talks to etcd.</p>' +
        '<h2>Play a flow</h2><ul class="flowlist">' + KA.idx.flowsFor("cluster").map(function (fl) { return flowItem(fl, "architecture", {}); }).join("") + "</ul>" +
        "<h2>Components</h2>" + Object.keys(D.planes).map(function (p) {
          var ids = stations.filter(function (id) { return D.components[id].plane === p; });
          return ids.length ? "<h3>" + esc(D.planes[p].name) + '</h3><p class="chips">' + ids.map(function (id) {
            return '<button type="button" class="chip chip--comp plane-dot--' + p + '" data-select="' + id + '">' + esc(KA.geom.label(ctx.mapDef, id)) + "</button>";
          }).join("") + "</p>" : "";
        }).join(""));
      KA.setTitle("Architecture");
    }

    function eksOverview(ctx) {
      ui.setPanel(ctx.f,
        '<header class="ph"><h1>Kubernetes on AWS</h1></header>' +
        '<p class="lede">EKS runs the control plane in an AWS account. Everything else on this map lives in yours: the VPC, the nodes, the add-ons and the IAM roles that connect them. Pick a lens to see one concern at a time.</p>' +
        '<h2>Lenses</h2><ul class="flowlist">' + KA.data.eksLayers.map(function (l) {
          return '<li><a href="#/eks?layer=' + l.id + '"><b>' + esc(l.name) + "</b><span>" + esc(l.summary) + "</span></a></li>";
        }).join("") + "</ul>" +
        "<h2>Who runs what</h2>" + ui.table(["AWS runs", "You run"], [
          ["API server, etcd, scheduler and controllers across three AZs", "The VPC, subnets, routes and security groups"],
          ["The cluster endpoint and its certificates", "IAM roles for nodes, controllers and pods"],
          ["Managed add-on versions, when you choose them", "Nodes, unless you use EKS Auto Mode or Fargate"],
          ["Control plane scaling and patching", "Add-on configuration, workloads and upgrades"],
        ]) +
        "<h2>A production layout</h2>" + prodLayout() +
        '<p class="note">Three AZs, a NAT gateway per AZ, pods in a large secondary CIDR, and the control plane reaching your nodes through ENIs it places in your subnets.</p>' +
        '<h2>Flows</h2><ul class="flowlist">' + KA.idx.flowsFor("eks").map(function (fl) { return flowItem(fl, "eks", {}); }).join("") + "</ul>");
      KA.setTitle("EKS");
    }

    function lens(ctx) {
      var l = lensById(ctx.lens);
      var fails = KA.data.failures.filter(function (f) { return LENS_LAYERS[l.id].indexOf(f.layer) >= 0; }).map(function (f) { return f.id; });
      ui.setPanel(ctx.f, back("#/eks", "EKS overview") +
        '<header class="ph"><p class="eyebrowless">Lens</p><h1>' + esc(l.name) + "</h1></header>" +
        '<p class="lede">' + esc(l.summary) + "</p>" +
        (l.flows.length ? '<h2>Flows</h2><ul class="flowlist">' + l.flows.map(function (id) { return flowItem(KA.idx.flow(id), "eks", { layer: l.id }); }).join("") + "</ul>" : "") +
        "<h2>" + esc(l.decide.title) + "</h2>" + ui.table(l.decide.cols, l.decide.rows) +
        (l.widget ? '<h2>How many pods fit on a node</h2><div class="calc-host"></div>' : "") +
        '<h2>Components in this lens</h2><p class="chips">' + l.stations.map(function (id) {
          var c = KA.data.components[id];
          return '<button type="button" class="chip chip--comp plane-dot--' + c.plane + '" data-select="' + id + '">' + esc(KA.geom.label(ctx.mapDef, id)) + "</button>";
        }).join("") + "</p>" +
        "<h2>Failures in this area</h2><p class=\"chips\">" + KA.failChips(fails) + "</p>");
      if (l.widget) ui.capacity(u.$(".calc-host", ctx.f.panel), { compact: true });
      KA.setTitle("EKS " + l.name.toLowerCase());
    }
    return view;
  }

  KA.views = KA.views || {};
  KA.views.home = explorer({ view: "home", map: "cluster" });
  KA.views.architecture = explorer({ view: "architecture", map: "cluster" });
  KA.views.eks = explorer({ view: "eks", map: "eks" });
})(window.KA);
