// Hash routes, so the atlas works from file:// and every view, selection and step can be linked
// from an incident channel: #/failures/oomkilled, #/eks/flow/pvc-to-ebs/3, #/incidents/subnet-ran-out/2
(function (KA) {
  "use strict";
  function parse(hash) {
    var h = (hash || "").replace(/^#\/?/, "");
    var q = {};
    var qi = h.indexOf("?");
    if (qi >= 0) {
      h.slice(qi + 1).split("&").forEach(function (kv) {
        if (!kv) return;
        var p = kv.split("=");
        q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || "").replace(/\+/g, " "));
      });
      h = h.slice(0, qi);
    }
    var parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    return { view: parts[0] || "home", parts: parts.slice(1), query: q };
  }
  function build(parts, query) {
    var path = "#/" + parts.filter(function (p) { return p !== undefined && p !== null && p !== ""; })
      .map(encodeURIComponent).join("/");
    var qs = Object.keys(query || {}).filter(function (k) { return query[k] !== undefined && query[k] !== null && query[k] !== ""; })
      .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); }).join("&");
    return qs ? path + "?" + qs : path;
  }
  // replace=true swaps the address without adding history (used while stepping through flows).
  // location.replace fires hashchange asynchronously, so a view never re-enters itself mid-update.
  function go(href, replace) {
    if (replace) location.replace(href);
    else location.hash = href.replace(/^#/, "");
  }
  KA.route = { parse: parse, build: build, go: go, current: function () { return parse(location.hash); } };
})(window.KA);
