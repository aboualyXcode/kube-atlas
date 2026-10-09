// Kube Atlas namespace. Loaded first, in the browser and by scripts/lib/load.mjs.
// Data files call KA.define(kind, value): arrays are appended, objects are merged.
(function (root) {
  "use strict";
  var KA = (root.KA = root.KA || {});
  KA.version = "1.0.0";
  KA.data = KA.data || {
    layers: [], planes: {}, components: {}, maps: {}, flows: [], failures: [], triage: [],
    incidents: [], runbooks: [], alerts: [], ops: {}, eksLayers: [],
  };
  KA.define = function (kind, value) {
    var slot = KA.data[kind];
    if (Array.isArray(slot)) {
      KA.data[kind] = slot.concat(value);
    } else if (slot && typeof slot === "object") {
      Object.keys(value).forEach(function (k) { slot[k] = value[k]; });
    } else {
      KA.data[kind] = value;
    }
  };
  // Multi-line text is stored as an array of lines so diffs stay readable.
  KA.text = function (v) { return Array.isArray(v) ? v.join("\n") : (v == null ? "" : String(v)); };
})(typeof window !== "undefined" ? window : globalThis);
