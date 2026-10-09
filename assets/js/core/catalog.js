// Indexes over KA.data, built once after all data files have loaded, plus the matcher that
// turns pasted kubectl/AWS output into ranked catalog entries. Pure functions: also used by Node.
(function (KA) {
  "use strict";
  var D = KA.data;

  function stationsOf(prop) {
    var ids = [];
    prop.origins.forEach(function (s) { ids.push(s.at); });
    prop.path.forEach(function (s) { ids.push(s.at); });
    ids.push(prop.symptom.at);
    (prop.branches || []).forEach(function (b) { ids.push(b.at); });
    return ids.filter(function (x, i) { return ids.indexOf(x) === i; });
  }

  function build() {
    var failures = {}, layers = {}, flows = {}, incidents = {}, runbooks = {};
    D.failures.forEach(function (f) { failures[f.id] = f; });
    D.layers.forEach(function (l) { layers[l.id] = l; });
    D.flows.forEach(function (f) { flows[f.id] = f; });
    D.incidents.forEach(function (x) { incidents[x.id] = x; });
    D.runbooks.forEach(function (r) { runbooks[r.id] = r; });

    var idx = {
      component: function (id) { return D.components[id]; },
      failure: function (id) { return failures[id]; },
      layer: function (id) { return layers[id]; },
      flow: function (id) { return flows[id]; },
      incident: function (id) { return incidents[id]; },
      runbook: function (id) { return runbooks[id]; },
      map: function (id) { return D.maps[id]; },
      stationsOf: stationsOf,
    };

    idx.flowsFor = function (mapId) { return D.flows.filter(function (f) { return f.map === mapId; }); };

    // Failures whose propagation starts at a component (where to look first).
    idx.originatingAt = function (cid, mapId) {
      return D.failures.filter(function (f) {
        return (!mapId || f.propagation.map === mapId) &&
          f.propagation.origins.some(function (o) { return o.at === cid; });
      });
    };
    // Failures that pass through or are reported by a component.
    idx.touching = function (cid) {
      return D.failures.filter(function (f) {
        return stationsOf(f.propagation).indexOf(cid) >= 0 || f.components.indexOf(cid) >= 0;
      });
    };
    idx.symptomsFor = function (fid) {
      return D.triage.filter(function (s) { return s.causes.some(function (c) { return c.id === fid; }); });
    };
    idx.alertsFor = function (fid) {
      return D.alerts.filter(function (a) { return a.leadsTo === "failure:" + fid; });
    };
    idx.runbooksFor = function (fid) {
      var f = failures[fid];
      return D.runbooks.filter(function (r) {
        if (f && f.runbook === r.id) return true;
        return r.phases.some(function (p) { return p.items.some(function (it) { return (it.to || []).indexOf(fid) >= 0; }); });
      });
    };
    idx.incidentsFor = function (fid) {
      return D.incidents.filter(function (x) {
        return x.steps.some(function (s) { return (s.entries || []).indexOf(fid) >= 0; });
      });
    };
    // Flow steps that list a failure in "where it breaks".
    idx.breakpoints = function (fid) {
      var out = [];
      D.flows.forEach(function (fl) {
        fl.steps.forEach(function (s, i) { if ((s.breaks || []).indexOf(fid) >= 0) out.push({ flow: fl, step: i }); });
      });
      return out;
    };
    idx.flowsThrough = function (cid) {
      return D.flows.filter(function (fl) {
        return fl.steps.some(function (s) { return s.from === cid || [].concat(s.to).indexOf(cid) >= 0; });
      });
    };
    KA.idx = idx;
    return idx;
  }

  // ---- matcher: each signal that matches adds its weight once; rank by score, then id ----
  var cache = {};
  function re(p) { return cache[p] || (cache[p] = new RegExp(p, "i")); }
  function score(entry, text) {
    var total = 0, hits = [];
    entry.signals.forEach(function (s) { if (re(s[1]).test(text)) { total += s[0]; hits.push(s[1]); } });
    return { id: entry.id, score: total, signals: hits };
  }
  function match(text, limit) {
    return D.failures.map(function (e) { return score(e, text); })
      .filter(function (m) { return m.score > 0; })
      .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); })
      .slice(0, limit || 6);
  }

  KA.buildIndex = build;
  KA.match = match;
  KA.score = score;
})((typeof window !== "undefined" ? window : globalThis).KA);
