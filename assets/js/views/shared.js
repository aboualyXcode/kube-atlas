// Pieces every view shares: the canvas-and-panel frame, chips, the component inspector, small
// tables and the node capacity calculator.
(function (KA) {
  "use strict";
  var u = KA.u, esc = u.esc, md = KA.md;
  var ui = {};

  ui.frame = function (main, cls) {
    main.innerHTML =
      '<div class="stage ' + (cls || "") + '">' +
      '<section class="canvas" aria-label="Diagram"><div class="canvas-head"></div><div class="canvas-body"></div><div class="canvas-foot"></div></section>' +
      '<aside class="panel" aria-label="Details"><div class="panel-inner"></div></aside></div>';
    return {
      head: u.$(".canvas-head", main), body: u.$(".canvas-body", main), foot: u.$(".canvas-foot", main),
      panel: u.$(".panel-inner", main), scroller: u.$(".panel", main),
    };
  };
  ui.setPanel = function (f, html) { f.panel.innerHTML = html; f.scroller.scrollTop = 0; };

  ui.kind = function (k) { return '<span class="kind kind--' + k + '">' + (k === "cause" ? "Cause" : "Symptom") + "</span>"; };
  ui.layer = function (id) { var l = KA.idx.layer(id); return '<span class="chip chip--layer">' + esc(l ? l.name : id) + "</span>"; };
  ui.scope = function (s) { return '<span class="chip">' + (s === "eks" ? "Amazon EKS" : "Any cluster") + "</span>"; };
  ui.plane = function (p) { return '<span class="plane plane--' + p + '">' + esc(KA.data.planes[p].name) + "</span>"; };
  ui.compChip = function (id, view) {
    var c = KA.data.components[id];
    return c ? '<a class="chip chip--comp plane-dot--' + c.plane + '" href="#/' + (view || ui.viewFor(id)) + "/c/" + id + '">' + esc(c.name) + "</a>" : "";
  };
  ui.viewFor = function (id) {
    return KA.data.maps.cluster.stations.some(function (s) { return s.id === id; }) ? "architecture" : "eks";
  };
  ui.code = function (text) { return text ? md.codeBlock(KA.text(text)) : ""; };
  ui.table = function (cols, rows, cls) {
    return '<div class="table-wrap"><table class="' + (cls || "") + '"><thead><tr>' + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + md.inline(String(c)) + "</td>"; }).join("") + "</tr>"; }).join("") +
      "</tbody></table></div>";
  };
  ui.pipe = function (steps) {
    return '<ol class="pipe">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>";
  };
  ui.legend = function () {
    var P = KA.data.planes;
    return '<ul class="legend" aria-label="Colour key">' + Object.keys(P).map(function (k) {
      return '<li><span class="swatch plane-dot--' + k + '" aria-hidden="true"></span>' + esc(P[k].name) + "</li>";
    }).join("") + "</ul>";
  };

  // ---------------------------------------------------------------- component inspector
  ui.inspector = function (id, mapDef, view) {
    var c = KA.data.components[id];
    if (!c) return "<p>Unknown component.</p>";
    var talks = [];
    mapDef.edges.forEach(function (e) {
      if (e.from === id) talks.push({ dir: "to", other: e.to, label: e.label });
      if (e.to === id) talks.push({ dir: "from", other: e.from, label: e.label });
    });
    var starts = KA.idx.originatingAt(id), touching = KA.idx.touching(id).filter(function (f) { return starts.indexOf(f) < 0; });
    var flows = KA.idx.flowsThrough(id).filter(function (fl) { return fl.map === mapDef.id; });
    var html = '<header class="ph">' + ui.plane(c.plane) + "<h1>" + esc(c.name) + "</h1>" +
      (c.full && c.full !== c.name ? '<p class="ph-full">' + esc(c.full) + "</p>" : "") + "</header>" +
      '<p class="lede">' + esc(c.what) + "</p>" +
      "<h2>How it works inside</h2>" + ui.pipe(c.inside) +
      "<h2>What it does</h2><ul>" + c.does.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>";
    if (talks.length) {
      html += "<h2>Connections on this map</h2><ul class=\"talks\">" + talks.map(function (t) {
        return '<li><button type="button" class="link" data-select="' + t.other + '">' + esc(KA.geom.label(mapDef, t.other)) + "</button>" +
          '<span class="talks-dir">' + (t.dir === "to" ? "it calls" : "calls it") + "</span> " + esc(t.label) + "</li>";
      }).join("") + "</ul>";
    }
    html += "<h2>In production</h2><ul>" + c.production.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" +
      "<h2>On EKS</h2><p>" + esc(c.eks) + "</p>" +
      "<h2>Look at it</h2>" + c.look.map(function (l) { return ui.code(l); }).join("");
    if (starts.length) html += "<h2>Failures that start here</h2><p class=\"chips\">" + KA.failChips(starts.map(function (f) { return f.id; })) + "</p>";
    if (touching.length) html += "<h2>Also involved in</h2><p class=\"chips\">" + KA.failChips(touching.map(function (f) { return f.id; })) + "</p>";
    if (flows.length) html += "<h2>Flows through it</h2><ul class=\"flowlist\">" + flows.map(function (fl) {
      return '<li><a href="#/' + view + "/flow/" + fl.id + '">' + esc(fl.title) + "</a></li>";
    }).join("") + "</ul>";
    if (c.config && c.config.length) html += "<h2>Reference configuration</h2><ul>" + c.config.map(function (p) {
      return '<li><a href="' + esc(p) + '"><code>' + esc(p) + "</code></a></li>";
    }).join("") + "</ul>";
    return html;
  };

  // ---------------------------------------------------------------- capacity calculator
  // Estimates follow the EKS AMI defaults: kube-reserved CPU on a sliding scale, kube-reserved
  // memory of 255 MiB + 11 MiB per pod, a 100 MiB eviction threshold, and max pods from ENIs.
  ui.capacity = function (host, opts) {
    opts = opts || {};
    var types = KA.data.ops.capacity.instances;
    host.innerHTML =
      '<div class="calc' + (opts.compact ? " calc--compact" : "") + '">' +
      '<div class="calc-in">' +
      '<label>Instance type<select data-k="type">' + types.map(function (t, i) {
        return '<option value="' + i + '"' + (t.type === "m6i.large" ? " selected" : "") + ">" + t.type + " (" + t.vcpu + " vCPU, " + t.mem + " GiB" + (t.arch ? ", " + t.arch : "") + ")</option>";
      }).join("") + "</select></label>" +
      '<label class="switch"><input type="checkbox" data-k="pd"> Prefix delegation</label>' +
      '<label>Pod CPU request (millicores)<input type="number" data-k="cpu" min="10" step="50" value="250"></label>' +
      '<label>Pod memory request (MiB)<input type="number" data-k="mem" min="16" step="64" value="512"></label>' +
      '</div><div class="calc-out" aria-live="polite"></div></div>';
    var out = u.$(".calc-out", host);
    function val(k) { return u.$('[data-k="' + k + '"]', host); }
    function bar(name, total, reserved, used, unit) {
      var pr = total ? reserved / total * 100 : 0, pu = total ? used / total * 100 : 0;
      return '<div class="cbar"><div class="cbar-head"><b>' + name + "</b><span>" + Math.round(used) + " of " + Math.round(total - reserved) + " " + unit + " allocatable used</span></div>" +
        '<div class="cbar-track"><span class="cbar-res" style="width:' + pr.toFixed(1) + '%"></span><span class="cbar-use" style="width:' + pu.toFixed(1) + '%"></span></div></div>';
    }
    function calc() {
      var t = types[+val("type").value], pd = val("pd").checked;
      var podCpu = Math.max(1, +val("cpu").value || 1), podMem = Math.max(1, +val("mem").value || 1);
      var maxPods = pd ? Math.min(t.enis * (t.ips - 1) * 16 + 2, t.vcpu < 30 ? 110 : 250) : t.enis * (t.ips - 1) + 2;
      var cores = t.vcpu, resCpu = 60 + (cores >= 2 ? 10 : 0) + (cores >= 3 ? 5 * Math.min(cores - 2, 2) : 0) + (cores > 4 ? 2.5 * (cores - 4) : 0);
      var capCpu = cores * 1000, capMem = t.mem * 1024, resMem = 255 + 11 * maxPods + 100;
      var allocCpu = capCpu - resCpu, allocMem = capMem - resMem;
      var byCpu = Math.floor(allocCpu / podCpu), byMem = Math.floor(allocMem / podMem);
      var fit = Math.max(0, Math.min(byCpu, byMem, maxPods));
      var limit = fit === maxPods ? "pod slots (ENI limit)" : fit === byMem ? "memory" : "CPU";
      var grid = "";
      for (var i = 0; i < maxPods; i++) grid += '<span class="' + (i < fit ? "on" : "") + '"></span>';
      out.innerHTML =
        '<p class="calc-answer"><b>' + fit + "</b> pods of this size fit. The node runs out of <b>" + limit + "</b> first.</p>" +
        bar("CPU", capCpu, resCpu, fit * podCpu, "m") +
        bar("Memory", capMem, resMem, fit * podMem, "MiB") +
        bar("Pod slots", maxPods, 0, fit, "pods") +
        '<div class="podgrid" aria-hidden="true">' + grid + "</div>" +
        '<p class="calc-note">Max pods = ' + (pd ? "ENIs × (IPs per ENI − 1) × 16 + 2, capped at " + (t.vcpu < 30 ? 110 : 250) : "ENIs × (IPs per ENI − 1) + 2") +
        " = " + maxPods + ". Reserved: " + Math.round(resCpu) + "m CPU, " + resMem + " MiB memory. Real capacity is a little below nominal and DaemonSets take a share: <code>kubectl describe node</code> shows the exact Allocatable.</p>";
    }
    host.addEventListener("input", calc);
    host.addEventListener("change", calc);
    calc();
  };

  KA.ui = ui;
})(window.KA);
