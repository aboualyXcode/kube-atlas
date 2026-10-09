#!/usr/bin/env node
// Kube Atlas tooling, no dependencies. It loads exactly the data files index.html loads, in the
// same order, so the browser and these commands can never disagree.
//
//   node scripts/atlas.mjs validate          check every reference, every sample and the map layout
//   node scripts/atlas.mjs docs [--check]    generate docs/ (Markdown with Mermaid diagrams)
//   node scripts/atlas.mjs alerts [--check]  regenerate data/alerts.js from the alert rules
//   node scripts/atlas.mjs build             write dist/kube-atlas.html, one file that works offline
//   kubectl describe pod x | node scripts/atlas.mjs match
//   node scripts/atlas.mjs show <failure-id>
//   node scripts/atlas.mjs list
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

export function scriptList() {
  return [...read("index.html").matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
}

// Data, the core helpers and the map geometry run in Node; the views need a browser.
const NODE_SAFE = /^(data\/.+\.js|assets\/js\/core\/(ns|util|md|catalog|router)\.js|assets\/js\/diagram\/map\.js)$/;
export function load() {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const src of scriptList().filter((s) => NODE_SAFE.test(s))) {
    vm.runInContext(read(src), ctx, { filename: src });
  }
  ctx.KA.buildIndex();
  return ctx.KA;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out.sort();
}

// ---------------------------------------------------------------- validate
export function validate(KA) {
  const D = KA.data, errs = [], err = (m) => errs.push(m);
  const planes = Object.keys(D.planes), layers = D.layers.map((l) => l.id);
  for (const [id, c] of Object.entries(D.components)) {
    for (const k of ["name", "plane", "what", "does", "inside", "production", "eks", "look"]) {
      if (!c[k] || (Array.isArray(c[k]) && !c[k].length)) err(`component ${id}: missing ${k}`);
    }
    if (!planes.includes(c.plane)) err(`component ${id}: unknown plane ${c.plane}`);
    for (const p of c.config || []) if (!fs.existsSync(path.join(ROOT, p))) err(`component ${id}: ${p} does not exist`);
  }
  const onMap = {};
  for (const [mid, m] of Object.entries(D.maps)) {
    onMap[mid] = new Set();
    for (const s of m.stations) {
      if (!D.components[s.id]) err(`map ${mid}: station ${s.id} is not in components.js`);
      if (onMap[mid].has(s.id)) err(`map ${mid}: station ${s.id} appears twice`);
      onMap[mid].add(s.id);
    }
    for (const e of m.edges) for (const end of [e.from, e.to]) if (!onMap[mid].has(end)) err(`map ${mid}: edge ${e.from} -> ${e.to} uses ${end}, which is not on the map`);
    for (const d of m.districts) if (!planes.includes(d.tone)) err(`map ${mid}: district ${d.id} has unknown tone ${d.tone}`);
    errs.push(...KA.geom.problems(m));
  }
  for (const id of Object.keys(D.components)) if (!Object.values(onMap).some((s) => s.has(id))) err(`component ${id} is on no map`);

  const fids = new Set();
  for (const f of D.failures) {
    if (fids.has(f.id)) err(`failure ${f.id}: duplicate id`);
    fids.add(f.id);
  }
  for (const f of D.failures) {
    for (const k of ["title", "summary", "symptom", "affected", "rootCause", "resolution"]) if (!KA.text(f[k]).trim()) err(`failure ${f.id}: missing ${k}`);
    for (const k of ["investigation", "prevention", "samples", "signals"]) if (!f[k] || !f[k].length) err(`failure ${f.id}: no ${k}`);
    if (!["cause", "symptom"].includes(f.kind)) err(`failure ${f.id}: kind must be cause or symptom`);
    if (!layers.includes(f.layer)) err(`failure ${f.id}: unknown layer ${f.layer}`);
    if (!["any", "eks"].includes(f.scope)) err(`failure ${f.id}: scope must be any or eks`);
    for (const c of f.components) if (!D.components[c]) err(`failure ${f.id}: unknown component ${c}`);
    for (const r of f.related) if (!fids.has(r)) err(`failure ${f.id}: related entry ${r} does not exist`);
    if (f.runbook && !KA.idx.runbook(f.runbook)) err(`failure ${f.id}: runbook ${f.runbook} does not exist`);
    if (f.lab && !fs.existsSync(path.join(ROOT, "labs", f.lab + ".yaml"))) err(`failure ${f.id}: labs/${f.lab}.yaml does not exist`);
    for (const s of f.signals) { try { new RegExp(s[1], "i"); } catch (e) { err(`failure ${f.id}: signal ${s[1]} is not a valid regular expression`); } }
    const P = f.propagation, m = onMap[P.map];
    if (!m) { err(`failure ${f.id}: unknown map ${P.map}`); continue; }
    const chain = [...P.origins.map((o) => o.at), ...P.path.map((s) => s.at), P.symptom.at];
    for (const s of [...chain, ...(P.branches || []).flatMap((b) => [b.from, b.at])]) if (!m.has(s)) err(`failure ${f.id}: ${s} is not on the ${P.map} map`);
    for (const b of P.branches || []) if (!chain.includes(b.from)) err(`failure ${f.id}: a branch starts at ${b.from}, which is not on its path`);
    f.samples.forEach((s, i) => {
      const res = KA.match(KA.text(s), 3);
      if (!res.length || res[0].id !== f.id) err(`failure ${f.id}: sample ${i + 1} matches ${res[0] ? res[0].id : "nothing"} first`);
      else if (res[1] && res[1].score === res[0].score) err(`failure ${f.id}: sample ${i + 1} ties with ${res[1].id}`);
    });
  }
  for (const fl of D.flows) {
    const m = onMap[fl.map];
    if (!m) { err(`flow ${fl.id}: unknown map ${fl.map}`); continue; }
    fl.steps.forEach((s, i) => {
      for (const st of [s.from, s.to]) if (!m.has(st)) err(`flow ${fl.id} step ${i + 1}: ${st} is not on the ${fl.map} map`);
      for (const b of s.breaks || []) if (!fids.has(b)) err(`flow ${fl.id} step ${i + 1}: unknown failure ${b}`);
    });
  }
  const covered = new Set();
  for (const t of D.triage) for (const c of t.causes) { if (!fids.has(c.id)) err(`symptom ${t.id}: unknown failure ${c.id}`); covered.add(c.id); }
  for (const id of fids) if (!covered.has(id)) err(`failure ${id} appears in no symptom fan (data/triage.js)`);
  for (const x of D.incidents) {
    const m = onMap[x.map];
    if (!m) { err(`incident ${x.id}: unknown map ${x.map}`); continue; }
    x.steps.forEach((s, i) => {
      if (!m.has(s.at)) err(`incident ${x.id} hop ${i + 1}: ${s.at} is not on the ${x.map} map`);
      for (const e of s.entries || []) if (!fids.has(e)) err(`incident ${x.id} hop ${i + 1}: unknown failure ${e}`);
    });
    for (const r of x.rootAt) if (!m.has(r)) err(`incident ${x.id}: root cause station ${r} is not on the map`);
    for (const c of x.chain.contributing) if (!x.chain.nodes[c.to]) err(`incident ${x.id}: contributing factor points at a missing link`);
  }
  for (const r of D.runbooks) for (const p of r.phases) for (const it of p.items) for (const t of it.to || []) {
    if (t.startsWith("runbook:") ? !KA.idx.runbook(t.slice(8)) : !fids.has(t)) err(`runbook ${r.id}: unknown target ${t}`);
  }
  for (const a of D.alerts) {
    const [k, id] = a.leadsTo.split(":");
    if (k === "failure" ? !fids.has(id) : !KA.idx.runbook(id)) err(`alert ${a.alert}: leads to unknown ${a.leadsTo}`);
  }
  for (const l of D.eksLayers) {
    for (const s of l.stations) if (!onMap.eks.has(s)) err(`EKS lens ${l.id}: ${s} is not on the EKS map`);
    for (const f of l.flows) if (!KA.idx.flow(f)) err(`EKS lens ${l.id}: unknown flow ${f}`);
  }
  const O = D.ops;
  for (const s of O.upgrade.steps) for (const r of s.risks) if (!fids.has(r)) err(`upgrade step "${s.t}": unknown failure ${r}`);
  for (const [k, s] of Object.entries(O.contract.spots)) for (const p of s.prevents) if (!fids.has(p)) err(`contract ${k}: unknown failure ${p}`);
  for (const [spot] of O.contract.manifest) if (spot && !O.contract.spots[spot]) err(`contract: manifest line points at unknown spot ${spot}`);
  for (const r of O.security.rings) for (const f of r.failures) if (!fids.has(f)) err(`security ring ${r.t}: unknown failure ${f}`);
  for (const d of O.capacity.dimensions) for (const f of d[3]) if (!fids.has(f)) err(`capacity ${d[0]}: unknown failure ${f}`);
  const listed = new Set(scriptList());
  for (const s of listed) if (!fs.existsSync(path.join(ROOT, s))) err(`index.html loads ${s}, which does not exist`);
  for (const f of walk("data")) if (!listed.has(f)) err(`${f} is not loaded by index.html`);
  return errs;
}

// ---------------------------------------------------------------- alerts
export function alertsFromYaml(text) {
  const out = [];
  let group = null, cur = null;
  const unq = (v) => {
    v = v.trim();
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
    return v;
  };
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^\s*-\s+name:\s*(\S+)/))) { group = m[1]; continue; }
    if ((m = line.match(/^\s*-\s+alert:\s*(\S+)/))) { cur = { alert: m[1], group, severity: "", summary: "", for: "0m", leadsTo: "" }; out.push(cur); continue; }
    if (!cur) continue;
    if ((m = line.match(/^\s+for:\s*(\S+)\s*$/))) cur.for = m[1];
    else if ((m = line.match(/^\s+severity:\s*(\S+)/))) cur.severity = m[1];
    else if ((m = line.match(/^\s+summary:\s*(.+)$/))) cur.summary = unq(m[1]);
    else if ((m = line.match(/^\s+runbook_url:\s*(\S+)/))) {
      const t = m[1].match(/\/docs\/(failures|runbooks)\/([a-z0-9-]+)\.md/);
      cur.leadsTo = t ? (t[1] === "failures" ? "failure:" : "runbook:") + t[2] : "";
    }
  }
  return out;
}
export function alertsJs(alerts) {
  return "// Generated from reference/observability/alerts.yaml by `node scripts/atlas.mjs alerts`.\n" +
    "// Do not edit by hand: change the YAML and regenerate (npm test fails when this is stale).\n" +
    'KA.define("alerts", [\n' + alerts.map((a) => "  " + JSON.stringify(a)).join(",\n") + "\n]);\n";
}

// ---------------------------------------------------------------- docs
const mm = (s) => String(s).replace(/"/g, "#quot;").replace(/</g, "#60;").replace(/>/g, "#62;");
function docLinks(text, from) {
  return KA_text(text)
    .replace(/\]\(#\/failures\/([a-z0-9-]+)\)/g, (m, id) => "](" + (from === "failures" ? "" : "../failures/") + id + ".md)")
    .replace(/\]\(#\/operations\/runbooks\/([a-z0-9-]+)\)/g, (m, id) => "](" + (from === "runbooks" ? "" : "../runbooks/") + id + ".md)")
    .replace(/\]\((#\/[^)]*)\)/g, (m, r) => "](../../index.html" + r + ")");
}
let KA_text = (v) => (Array.isArray(v) ? v.join("\n") : v == null ? "" : String(v));
const fence = (code, lang = "sh") => "```" + lang + "\n" + KA_text(code) + "\n```";
const indent = (s, n) => s.split("\n").map((l) => (l ? " ".repeat(n) + l : l)).join("\n");
const HEADER = (src) => `<!-- Generated from ${src} by \`node scripts/atlas.mjs docs\`. Edit the data, then regenerate. -->\n\n`;

function propagationMermaid(KA, f) {
  const P = f.propagation, map = KA.data.maps[P.map], lab = (id) => KA.geom.label(map, id);
  const lines = ["flowchart LR"], ids = [];
  P.origins.forEach((o, i) => { lines.push(`  o${i}["${mm(lab(o.at))}<br/>${mm(o.note)}"]:::origin`); ids.push(["o" + i, o.at]); });
  P.path.forEach((s, i) => { lines.push(`  p${i}["${mm(lab(s.at))}<br/>${mm(s.note)}"]:::path`); ids.push(["p" + i, s.at]); });
  lines.push(`  s["${mm(lab(P.symptom.at))}<br/>${mm(P.symptom.note)}"]:::symptom`);
  ids.push(["s", P.symptom.at]);
  const first = P.path.length ? "p0" : "s";
  P.origins.forEach((o, i) => lines.push(`  o${i} --> ${first}`));
  P.path.forEach((s, i) => lines.push(`  p${i} --> ${i + 1 < P.path.length ? "p" + (i + 1) : "s"}`));
  (P.branches || []).forEach((b, i) => {
    const from = ids.filter((x) => x[1] === b.from).pop();
    lines.push(`  b${i}["${mm(lab(b.at))}<br/>${mm(b.note)}"]:::branch`);
    lines.push(`  ${from[0]} -.->|knock-on| b${i}`);
  });
  lines.push("  classDef origin fill:#fde3e6,stroke:#d7263d,stroke-width:2px,color:#17212c");
  lines.push("  classDef path fill:#fff1dc,stroke:#cf7c00,color:#17212c");
  lines.push("  classDef symptom fill:#e9eef3,stroke:#17212c,stroke-width:2px,color:#17212c");
  lines.push("  classDef branch fill:#ffffff,stroke:#cf7c00,stroke-dasharray:4 3,color:#17212c");
  return fence(lines.join("\n"), "mermaid");
}

function layerFile(f) { return `data/failures/${f.layer}.js`; }

export function generateDocs(KA) {
  const D = KA.data, files = new Map(), short = (t) => t.replace(/\s*\(.*\)\s*$/, "");
  KA_text = KA.text;
  for (const f of D.failures) {
    const L = KA.idx.layer(f.layer), alerts = KA.idx.alertsFor(f.id), rb = KA.idx.runbooksFor(f.id);
    let s = HEADER(layerFile(f)) + `# ${f.title}\n\n${f.summary}\n\n` +
      "| Kind | Layer | Scope | Interactive |\n|---|---|---|---|\n" +
      `| ${f.kind === "cause" ? "Cause" : "Symptom"} | ${L.name} | ${f.scope === "eks" ? "Amazon EKS" : "Any Kubernetes cluster"} | [Open in the atlas](../../index.html#/failures/${f.id}) |\n\n` +
      "## How it propagates\n\n" + propagationMermaid(KA, f) + "\n\n" +
      "## Symptom\n\n" + docLinks(f.symptom, "failures") + "\n\n" +
      "## Affected component\n\n" + docLinks(f.affected, "failures") + "\n\n" +
      "## Root cause\n\n" + docLinks(f.rootCause, "failures") + "\n\n" +
      "## Investigation\n\n" + f.investigation.map((st, i) => `${i + 1}. **${docLinks(st.title, "failures")}**\n\n${indent(fence(st.run), 3)}\n\n   Look for: ${docLinks(st.lookFor, "failures")}`).join("\n\n") + "\n\n" +
      "## Resolution\n\n" + docLinks(f.resolution, "failures") + "\n\n" +
      "## Prevention\n\n" + f.prevention.map((p) => "- " + docLinks(p, "failures")).join("\n") + "\n";
    if (alerts.length) s += "\nAlerts that lead here: " + alerts.map((a) => `\`${a.alert}\` (${a.severity})`).join(", ") + ".\n";
    if (f.related.length) s += "\n## Related\n\n" + f.related.map((r) => `- [${short(KA.idx.failure(r).title)}](${r}.md)`).join("\n") + "\n";
    if (rb.length) s += "\n## Runbooks\n\n" + rb.map((r) => `- [${r.title}](../runbooks/${r.id}.md)`).join("\n") + "\n";
    if (f.lab) s += `\n## Reproduce it locally\n\n${fence(`make kind-up\nmake lab LAB=${f.lab}\nmake lab-clean LAB=${f.lab}`)}\n\nThe lab is [labs/${f.lab}.yaml](../../labs/${f.lab}.yaml).\n`;
    files.set(`docs/failures/${f.id}.md`, s);
  }
  let idx = HEADER("data/failures/") + "# Failure catalog\n\n" +
    `${D.failures.length} failures across ${D.layers.length} layers. Each has a symptom, the affected component, the root cause, an investigation, a resolution and prevention, and a diagram of how it propagates. The [interactive atlas](../../index.html#/failures) animates each one on the map.\n\n` +
    "A **symptom** tells you where to look (`Pending`, `CrashLoopBackOff`, a 503). A **cause** names the mechanism (`OOMKilled`, `Insufficient cpu`, `x509`).\n";
  for (const L of D.layers) {
    idx += `\n## ${L.name}\n\n${L.hint}.\n\n| Failure | Kind | Scope | Starts at |\n|---|---|---|---|\n`;
    for (const f of D.failures.filter((x) => x.layer === L.id)) {
      const map = D.maps[f.propagation.map];
      idx += `| [${short(f.title)}](${f.id}.md) | ${f.kind} | ${f.scope === "eks" ? "EKS" : "any"} | ${f.propagation.origins.map((o) => KA.geom.label(map, o.at)).join(", ")} |\n`;
    }
  }
  files.set("docs/failures/README.md", idx);

  for (const r of D.runbooks) {
    let s = HEADER("data/runbooks.js") + `# Runbook: ${r.title}\n\n**Trigger:** ${docLinks(r.trigger, "runbooks")}\n\n` + (r.impact ? `**Impact:** ${docLinks(r.impact, "runbooks")}\n\n` : "") +
      `[Open as a flowchart](../../index.html#/operations/runbooks/${r.id})\n`;
    for (const p of r.phases) {
      s += `\n## ${p.title}${p.hint ? ` (${p.hint})` : ""}\n\n`;
      let table = [];
      const flush = () => { if (table.length) { s += "| If you see | Then |\n|---|---|\n" + table.join("\n") + "\n\n"; table = []; } };
      for (const it of p.items) {
        if (it.when) { table.push(`| ${docLinks(it.when, "runbooks")} | ${docLinks(it.then, "runbooks")} |`); continue; }
        flush();
        if (it.title || it.text) s += (it.title ? `**${it.title}.** ` : "") + docLinks(it.text || "", "runbooks") + "\n\n";
        if (it.run) s += fence(it.run) + "\n\n";
      }
      flush();
    }
    files.set(`docs/runbooks/${r.id}.md`, s.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  }
  files.set("docs/runbooks/README.md", HEADER("data/runbooks.js") + "# Runbooks\n\nWhat to do when an alert fires. The atlas draws each one as a flowchart.\n\n" +
    D.runbooks.map((r) => `- [${r.title}](${r.id}.md): ${docLinks(r.trigger, "runbooks")}`).join("\n") + "\n");

  let inc = HEADER("data/incidents.js") + "# Incidents\n\nEach investigation starts from what someone noticed and follows dependencies, one hop at a time, until it reaches the change that caused it. [Replay them on the map](../index.html#/incidents).\n";
  for (const x of D.incidents) {
    const map = D.maps[x.map];
    inc += `\n## ${x.title}\n\n${x.sev}, ${x.when}. ${x.summary}\n\n`;
    x.steps.forEach((st, i) => {
      inc += `### Hop ${i + 1}: ${st.title} (${KA.geom.label(map, st.at)})\n\n${fence(st.run)}\n\n${fence(st.output, "text")}\n\n${st.finding}\n\n`;
    });
    const C = x.chain, lines = ["flowchart TB"];
    C.nodes.forEach((n, i) => lines.push(`  c${i}["${mm(n.t)}"]${n.kind === "change" ? ":::change" : n.kind === "symptom" ? ":::symptom" : ""}`));
    C.nodes.slice(1).forEach((n, i) => lines.push(`  c${i} --> c${i + 1}`));
    C.contributing.forEach((c, i) => lines.push(`  g${i}["Contributing: ${mm(c.t)}"]:::contrib -.-> c${c.to}`));
    lines.push("  classDef change fill:#fde3e6,stroke:#d7263d,color:#17212c", "  classDef symptom fill:#e9eef3,stroke:#17212c,color:#17212c", "  classDef contrib fill:#ffffff,stroke:#cf7c00,stroke-dasharray:4 3,color:#17212c");
    inc += `**Root cause.** ${x.rootCause}\n\n${fence(lines.join("\n"), "mermaid")}\n\n` + x.fixes.map((f) => `- **${f.kind}:** ${f.text}`).join("\n") + "\n";
  }
  files.set("docs/incidents.md", inc.replace(/\.\.\/index\.html/, "../index.html"));
  return files;
}

// ---------------------------------------------------------------- single file
export function buildSingleFile() {
  let html = read("index.html");
  html = html.replace('<link rel="stylesheet" href="assets/atlas.css">', () => "<style>\n" + read("assets/atlas.css") + "\n</style>");
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => "<script>\n" + read(src).replace(/<\/script/gi, "<\\/script") + "\n</script>");
  return html;
}

// ---------------------------------------------------------------- CLI
function chainText(KA, f) {
  const P = f.propagation, map = KA.data.maps[P.map], lab = (id) => KA.geom.label(map, id);
  return "starts at " + P.origins.map((o) => lab(o.at)).join(" or ") + " -> " + P.path.map((s) => lab(s.at)).concat(["you notice it at " + lab(P.symptom.at)]).join(" -> ");
}

function writeOrCheck(files, check) {
  const stale = [];
  for (const [rel, content] of files) {
    const abs = path.join(ROOT, rel), cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (cur !== content) {
      stale.push(rel);
      if (!check) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
    }
  }
  return stale;
}

async function main(argv) {
  const [cmd, arg] = argv;
  const check = argv.includes("--check");
  if (cmd === "validate") {
    const errs = validate(load());
    if (errs.length) { console.error(errs.map((e) => "  " + e).join("\n")); console.error(`\n${errs.length} problem(s).`); process.exit(1); }
    const D = load().data;
    console.log(`ok: ${Object.keys(D.components).length} components, ${D.failures.length} failures, ${D.flows.length} flows, ${D.triage.length} symptom fans, ${D.incidents.length} incidents, ${D.runbooks.length} runbooks, ${D.alerts.length} alerts`);
  } else if (cmd === "docs") {
    const stale = writeOrCheck(generateDocs(load()), check);
    if (check && stale.length) { console.error("Generated docs are stale; run `node scripts/atlas.mjs docs`:\n  " + stale.join("\n  ")); process.exit(1); }
    console.log(check ? "ok: docs are current" : `wrote ${stale.length} file(s) in docs/`);
  } else if (cmd === "alerts") {
    const stale = writeOrCheck(new Map([["data/alerts.js", alertsJs(alertsFromYaml(read("reference/observability/alerts.yaml")))]]), check);
    if (check && stale.length) { console.error("data/alerts.js is stale; run `node scripts/atlas.mjs alerts`"); process.exit(1); }
    console.log(check ? "ok: data/alerts.js is current" : stale.length ? "wrote data/alerts.js" : "data/alerts.js unchanged");
  } else if (cmd === "build") {
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    const html = buildSingleFile();
    fs.writeFileSync(path.join(ROOT, "dist/kube-atlas.html"), html);
    console.log(`wrote dist/kube-atlas.html (${Math.round(html.length / 1024)} KB)`);
  } else if (cmd === "match") {
    const text = arg && arg !== "--check" ? argv.slice(1).join(" ") : fs.readFileSync(0, "utf8");
    const KA = load(), res = KA.match(text, 5);
    if (!res.length) { console.log("No catalog entry matched. Paste more context, such as the Events section of kubectl describe."); process.exit(2); }
    res.forEach((m, i) => {
      const f = KA.idx.failure(m.id);
      console.log(`${i + 1}. ${f.title}  [${f.id}]  ${f.kind}, score ${m.score}\n   ${chainText(KA, f)}\n   open: index.html#/failures/${f.id}`);
    });
    if (res.length > 1 && KA.idx.failure(res[0].id).kind === "cause") console.log("\nThe best match names a cause; lower matches are the symptoms it produces.");
  } else if (cmd === "show") {
    const KA = load(), f = KA.idx.failure(arg);
    if (!f) { console.error(`No failure with id ${arg}. Try: node scripts/atlas.mjs list`); process.exit(2); }
    console.log(`${f.title}  (${f.kind}, ${KA.idx.layer(f.layer).name})\n\n${f.summary}\n\n${chainText(KA, f)}\n\nInvestigate:`);
    f.investigation.forEach((s, i) => console.log(`\n${i + 1}. ${s.title}\n${KA.text(s.run).split("\n").map((l) => "   " + l).join("\n")}\n   Look for: ${s.lookFor}`));
  } else if (cmd === "list") {
    const KA = load();
    for (const L of KA.data.layers) {
      console.log(`\n${L.name}`);
      for (const f of KA.data.failures.filter((x) => x.layer === L.id)) console.log(`  ${f.id.padEnd(34)} ${f.kind.padEnd(8)} ${f.title}`);
    }
  } else {
    console.log("usage: node scripts/atlas.mjs <validate | docs [--check] | alerts [--check] | build | match [text] | show <id> | list>");
    process.exit(cmd ? 2 : 0);
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) main(process.argv.slice(2));
