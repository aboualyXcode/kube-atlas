// The shell: picks the view for the current route, keeps the navigation and theme in step,
// handles copy buttons, and runs the Find palette (press / or Ctrl+K).
(function (KA) {
  "use strict";
  var u = KA.u, esc = u.esc, R = KA.route;
  var current = null, ctx = null;
  var main = u.$("#main");

  KA.setTitle = function (t) { document.title = t ? t + " | Kube Atlas" : "Kube Atlas: Kubernetes and EKS as a map you can click"; };

  function render() {
    var route = R.current();
    var name = KA.views[route.view] ? route.view : "home";
    u.$$("[data-nav]").forEach(function (a) {
      var on = a.getAttribute("data-nav") === name;
      a.classList.toggle("is-on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    try {
      if (current === name && ctx) {
        KA.views[name].update(ctx, route);
      } else {
        if (current && ctx && KA.views[current].unmount) KA.views[current].unmount(ctx);
        current = name;
        ctx = KA.views[name].mount(main, route);
        main.focus({ preventScroll: true });
      }
    } catch (err) {
      main.innerHTML = '<div class="crash"><h1>This view failed to draw</h1><p>' + esc(err.message) + '</p><p><a href="#/">Back to the map</a></p></div>';
      current = null;
      ctx = null;
      if (window.console) console.error(err);
    }
  }

  // ---------------------------------------------------------------- theme
  var THEMES = ["auto", "light", "dark"];
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    var b = u.$("[data-action=theme]");
    if (b) { b.setAttribute("aria-label", "Theme: " + t + ". Switch theme"); b.setAttribute("data-mode", t); u.$(".theme-name", b).textContent = t === "auto" ? "Auto" : t === "light" ? "Light" : "Dark"; }
  }

  // ---------------------------------------------------------------- find palette
  var index = null;
  function buildIndex() {
    var D = KA.data, out = [];
    Object.keys(D.components).forEach(function (id) {
      var c = D.components[id];
      out.push({ type: "Component", title: c.name, text: [c.name, c.full, c.what].join(" "), href: "#/" + KA.ui.viewFor(id) + "/c/" + id });
    });
    D.failures.forEach(function (f) { out.push({ type: f.kind === "cause" ? "Cause" : "Symptom", title: KA.shortTitle(f.title), text: [f.title, f.id, f.summary].join(" "), href: "#/failures/" + f.id }); });
    D.flows.forEach(function (f) { out.push({ type: "Flow", title: f.title, text: f.title + " " + f.summary, href: "#/" + (f.map === "eks" ? "eks" : "architecture") + "/flow/" + f.id }); });
    D.triage.forEach(function (s) { out.push({ type: "What you see", title: s.label, text: s.label + " " + s.see, href: "#/failures?symptom=" + s.id }); });
    D.incidents.forEach(function (x) { out.push({ type: "Incident", title: x.title, text: x.title + " " + x.summary, href: "#/incidents/" + x.id }); });
    D.runbooks.forEach(function (r) { out.push({ type: "Runbook", title: r.title, text: r.title + " " + r.trigger, href: "#/operations/runbooks/" + r.id }); });
    D.eksLayers.forEach(function (l) { out.push({ type: "EKS lens", title: l.name, text: l.name + " " + l.summary, href: "#/eks?layer=" + l.id }); });
    [["observe", "Observe: signals and alerting"], ["respond", "Respond: investigation loop"], ["upgrade", "Upgrade sequence"], ["capacity", "Capacity calculator"], ["contract", "Workload contract"], ["security", "Security layers"]].forEach(function (s) {
      out.push({ type: "Operations", title: s[1], text: s[1], href: "#/operations/" + s[0] });
    });
    return out;
  }
  var dlg = u.$("#finder"), input = u.$("#finder-q"), list = u.$("#finder-list"), sel = 0, hits = [];
  function search(q) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    hits = !words.length ? index.slice(0, 0) : index.filter(function (it) {
      var hay = (it.title + " " + it.text).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    }).sort(function (a, b) {
      var w = words[0], at = a.title.toLowerCase().indexOf(w), bt = b.title.toLowerCase().indexOf(w);
      return (at < 0 ? 99 : at) - (bt < 0 ? 99 : bt);
    }).slice(0, 12);
    sel = 0;
    list.innerHTML = hits.length ? hits.map(function (h, i) {
      return '<li><a href="' + h.href + '" class="' + (i === sel ? "is-on" : "") + '" data-i="' + i + '"><span class="fi-type">' + esc(h.type) + "</span>" + esc(h.title) + "</a></li>";
    }).join("") : (words.length ? '<li class="fi-empty">Nothing matches. Try a status such as Pending, a component such as kubelet, or an error message.</li>' : '<li class="fi-empty">Search components, failures, flows, incidents and runbooks.</li>');
  }
  function openFind() {
    if (!index) index = buildIndex();
    input.value = "";
    search("");
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    input.focus();
  }
  function closeFind() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }
  input.addEventListener("input", function () { search(input.value); });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeFind(); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!hits.length) return;
      sel = (sel + (ev.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      u.$$("a", list).forEach(function (a, i) { a.classList.toggle("is-on", i === sel); if (i === sel) a.scrollIntoView({ block: "nearest" }); });
    }
    if (ev.key === "Enter" && hits[sel]) { ev.preventDefault(); closeFind(); location.hash = hits[sel].href.slice(1); }
  });
  list.addEventListener("click", function (ev) { if (ev.target.closest("a")) closeFind(); });
  dlg.addEventListener("click", function (ev) { if (ev.target === dlg) closeFind(); });

  // ---------------------------------------------------------------- global events
  document.addEventListener("click", function (ev) {
    var c = ev.target.closest && ev.target.closest("[data-copy]");
    if (c) {
      var pre = c.parentNode.querySelector("pre");
      u.copy(pre ? pre.textContent : "", c);
    }
    var a = ev.target.closest && ev.target.closest("[data-action]");
    if (a && a.getAttribute("data-action") === "find") openFind();
    if (a && a.getAttribute("data-action") === "theme") {
      var next = THEMES[(THEMES.indexOf(u.store.get("theme", "auto")) + 1) % THEMES.length];
      u.store.set("theme", next);
      applyTheme(next);
    }
  });
  document.addEventListener("keydown", function (ev) {
    var tag = (ev.target.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || tag === "select" || ev.target.isContentEditable;
    if ((ev.key === "/" && !typing) || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k")) { ev.preventDefault(); openFind(); }
  });
  window.addEventListener("hashchange", render);

  KA.buildIndex();
  applyTheme(u.store.get("theme", "auto"));
  render();
})(window.KA);
