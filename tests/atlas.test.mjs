// Unit tests. They run against exactly the data the browser loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, load, validate, generateDocs, alertsFromYaml, alertsJs, buildSingleFile, scriptList } from "../scripts/atlas.mjs";

const KA = load();
const D = KA.data;

test("every reference, sample and map layout is valid", () => {
  assert.deepEqual(validate(KA), []);
});

test("no station overlaps another and no connection runs through a station", () => {
  for (const m of Object.values(D.maps)) assert.deepEqual([...KA.geom.problems(m)], [], m.id);
});

test("every failure has six substantial parts and a propagation path", () => {
  for (const f of D.failures) {
    for (const k of ["symptom", "affected", "rootCause", "resolution"]) assert.ok(KA.text(f[k]).length > 80, `${f.id}: ${k} is too short`);
    assert.ok(f.investigation.length >= 2, `${f.id}: needs at least two investigation steps`);
    assert.ok(f.prevention.length >= 2, `${f.id}: needs at least two prevention items`);
    assert.ok(f.propagation.origins.length >= 1, `${f.id}: needs an origin`);
  }
});

test("every layer has failures, and every failure is reachable from a symptom", () => {
  for (const l of D.layers) assert.ok(D.failures.some((f) => f.layer === l.id), `layer ${l.id} is empty`);
  for (const f of D.failures) assert.ok(KA.idx.symptomsFor(f.id).length, `${f.id} is in no symptom fan`);
});

test("pasted output ranks the cause above the symptom it produces", () => {
  const res = KA.match("Last State:  Terminated\n  Reason:  OOMKilled\n  Exit Code:  137\nWarning  BackOff  kubelet  Back-off restarting failed container api");
  assert.equal(res[0].id, "oomkilled");
  assert.ok(res.some((r) => r.id === "crashloopbackoff"), "the symptom should still be listed");
});

test("generated docs are current", () => {
  for (const [rel, content] of generateDocs(KA)) {
    assert.equal(fs.readFileSync(path.join(ROOT, rel), "utf8"), content, `${rel} is stale: run npm run docs`);
  }
});

test("data/alerts.js matches the alert rules, and every alert leads to a page", () => {
  const yaml = fs.readFileSync(path.join(ROOT, "reference/observability/alerts.yaml"), "utf8");
  assert.equal(fs.readFileSync(path.join(ROOT, "data/alerts.js"), "utf8"), alertsJs(alertsFromYaml(yaml)), "run npm run alerts");
  for (const a of D.alerts) {
    const [kind, id] = a.leadsTo.split(":");
    assert.ok(fs.existsSync(path.join(ROOT, "docs", kind === "failure" ? "failures" : "runbooks", id + ".md")), a.alert);
  }
});

test("the Markdown renderer escapes HTML and refuses script links", () => {
  const out = KA.md.render("<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](#/failures/oomkilled) `<b>`");
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("javascript:"));
  assert.ok(out.includes('href="#/failures/oomkilled"'));
  assert.ok(out.includes("&lt;b&gt;"));
});

test("routes round-trip", () => {
  const r = KA.route.parse("#/failures/oomkilled?tab=fix");
  assert.equal(r.view, "failures");
  assert.deepEqual([...r.parts], ["oomkilled"]);
  assert.deepEqual({ ...r.query }, { tab: "fix" });
  assert.equal(KA.route.build(["eks", "flow", "eks-pvc-to-ebs", 3], { layer: "storage" }), "#/eks/flow/eks-pvc-to-ebs/3?layer=storage");
});

test("the single-file build inlines every script and the stylesheet", () => {
  const html = buildSingleFile();
  assert.ok(!/<script src=/.test(html));
  assert.ok(!html.includes('href="assets/atlas.css"'));
  assert.equal((html.match(/<script>/g) || []).length, scriptList().length);
});
