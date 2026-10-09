// Two ways of moving across a map: the flow player (a numbered route, step by step) and the
// propagation animator (a failure travelling from where it starts to where it is noticed).
(function (KA) {
  "use strict";
  var u = KA.u;

  function shortTitle(t) { return t.replace(/\s*\(.*\)\s*$/, ""); }
  function failChips(ids) {
    return (ids || []).map(function (id) {
      var f = KA.idx.failure(id);
      return f ? '<a class="chip chip--fail" href="#/failures/' + id + '">' + u.esc(shortTitle(f.title)) + "</a>" : "";
    }).join(" ");
  }
  KA.failChips = failChips;
  KA.shortTitle = shortTitle;

  // ---------------------------------------------------------------- flow player
  KA.Player = function (map, flow, bar, opts) {
    opts = opts || {};
    var i = -1, timer = null, n = flow.steps.length;
    function draw() {
      map.clear();
      map.dim(true);
      for (var j = 0; j <= i; j++) {
        var s = flow.steps[j], cur = j === i;
        map.addClass(s.from, cur ? "is-active" : "is-trail");
        map.addClass(s.to, cur ? "is-active" : "is-trail");
        map.hop(s.from, s.to, cur ? { cls: "active" } : { cls: "trail", instant: true, arrow: false });
        map.mark(s.to, String(j + 1));
      }
    }
    function render() {
      var s = flow.steps[i];
      var dots = flow.steps.map(function (st, k) {
        return '<button type="button" class="dot' + (k === i ? " is-on" : k < i ? " is-done" : "") + '" data-act="go" data-i="' + k + '" aria-label="Step ' + (k + 1) + ": " + u.esc(st.title) + '"></button>';
      }).join("");
      bar.innerHTML =
        '<div class="player" tabindex="-1">' +
        '<div class="player-ctl">' +
        '<button type="button" class="btn-icon" data-act="prev" aria-label="Previous step"' + (i === 0 ? " disabled" : "") + '>&#8592;</button>' +
        '<button type="button" class="btn-icon btn-play" data-act="play" aria-label="' + (timer ? "Pause" : "Play") + '">' + (timer ? "&#10073;&#10073;" : "&#9654;") + "</button>" +
        '<button type="button" class="btn-icon" data-act="next" aria-label="Next step"' + (i === n - 1 ? " disabled" : "") + '>&#8594;</button>' +
        "</div>" +
        '<div class="player-text"><p class="player-count">' + u.esc(flow.title) + ": step " + (i + 1) + " of " + n + "</p>" +
        "<h3>" + u.esc(s.title) + "</h3><p>" + KA.md.inline(s.note) + "</p>" +
        (s.breaks && s.breaks.length ? '<p class="player-breaks"><span>Can break here</span> ' + failChips(s.breaks) + "</p>" : "") +
        "</div>" +
        '<div class="player-dots">' + dots + "</div></div>";
    }
    function show(k) {
      i = u.clamp(k, 0, n - 1);
      draw();
      render();
      if (opts.onStep) opts.onStep(i);
    }
    function play() {
      if (timer) return;
      if (i >= n - 1) show(0);
      timer = setInterval(function () { if (i >= n - 1) pause(); else show(i + 1); }, opts.interval || 3400);
      render();
    }
    function pause() { if (timer) { clearInterval(timer); timer = null; render(); } }
    function onClick(ev) {
      var b = ev.target.closest("[data-act]");
      if (!b) return;
      var act = b.getAttribute("data-act");
      if (act === "prev") { pause(); show(i - 1); }
      if (act === "next") { pause(); show(i + 1); }
      if (act === "go") { pause(); show(+b.getAttribute("data-i")); }
      if (act === "play") { if (timer) pause(); else play(); }
    }
    function onKey(ev) {
      if (ev.key === "ArrowRight") { pause(); show(i + 1); }
      if (ev.key === "ArrowLeft") { pause(); show(i - 1); }
    }
    bar.addEventListener("click", onClick);
    bar.addEventListener("keydown", onKey);
    show(opts.start || 0);
    if (opts.autoplay) play();
    return {
      show: show, play: play, pause: pause,
      index: function () { return i; },
      destroy: function () { pause(); bar.removeEventListener("click", onClick); bar.removeEventListener("keydown", onKey); bar.innerHTML = ""; },
    };
  };

  // ---------------------------------------------------------------- propagation
  KA.Prop = {
    // Animate a failure: origins pulse red, a red token travels the path, the symptom station is
    // marked where people notice it, and knock-on effects branch off as dashed amber arcs.
    play: function (map, f, o) {
      o = o || {};
      var P = f.propagation, alive = { on: true }, instant = !!o.instant || u.reducedMotion();
      map.clear();
      map.dim(true);
      var chain = P.path.map(function (s) { return s.at; }).concat([P.symptom.at]);
      P.origins.forEach(function (s) {
        map.addClass(s.at, "is-origin");
        map.callout(s.at, P.origins.length > 1 ? "Can start here" : "Starts here", "cause");
      });
      var groups = [P.origins.map(function (s) { return [s.at, chain[0]]; })];
      for (var k = 0; k < chain.length - 1; k++) groups.push([[chain[k], chain[k + 1]]]);
      function arrive(id, last) {
        if (last) { map.addClass(id, "is-symptom"); map.callout(id, "You notice it here", "symptom"); }
        else map.addClass(id, "is-path");
      }
      function run(g) {
        if (!alive.on) return;
        if (g >= groups.length) { branches(); return; }
        var pending = groups[g].length;
        groups[g].forEach(function (h) {
          map.hop(h[0], h[1], {
            cls: "fault", instant: instant, dur: 820,
            done: function () {
              if (!alive.on) return;
              if (--pending === 0) { arrive(h[1], g === groups.length - 1); run(g + 1); }
            },
          });
        });
      }
      function branches() {
        (P.branches || []).forEach(function (b) {
          map.addClass(b.at, "is-branch");
          map.hop(b.from, b.at, { cls: "branch", instant: instant, bend: -1 });
        });
        if (o.onDone) o.onDone();
      }
      run(0);
      return { stop: function () { alive.on = false; } };
    },

    // The same path as a vertical list for the panel. Hovering a stop highlights it on the map.
    strip: function (f) {
      var P = f.propagation, map = KA.data.maps[P.map];
      function stop(cls, s, label) {
        return '<li class="route-stop route-stop--' + cls + '"><button type="button" data-focus="' + s.at + '">' +
          '<span class="rs-dot" aria-hidden="true"></span><span class="rs-text"><span class="rs-name">' +
          u.esc(KA.geom.label(map, s.at)) + (label ? ' <span class="rs-role">' + label + "</span>" : "") +
          '</span><span class="rs-note">' + u.esc(s.note) + "</span></span></button></li>";
      }
      var html = '<ol class="route" aria-label="How this failure travels">';
      if (P.origins.length > 1) html += '<li class="route-group">Starts at one of these</li>';
      P.origins.forEach(function (s) { html += stop("origin", s, P.origins.length > 1 ? "" : "starts here"); });
      P.path.forEach(function (s) { html += stop("path", s, ""); });
      html += stop("symptom", P.symptom, "you notice it here");
      html += "</ol>";
      if (P.branches && P.branches.length) {
        html += '<ul class="route-branches" aria-label="Knock-on effects">' + P.branches.map(function (b) {
          return '<li><button type="button" data-focus="' + b.at + '"><span class="rs-dash" aria-hidden="true"></span><span class="rs-text"><span class="rs-name">' +
            u.esc(KA.geom.label(map, b.at)) + ' <span class="rs-role">knock-on</span></span><span class="rs-note">' + u.esc(b.note) + "</span></span></button></li>";
        }).join("") + "</ul>";
      }
      return html;
    },
  };
})(window.KA);
