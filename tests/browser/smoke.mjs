// Renders every view in a real browser and fails on any page or console error.
// Needs Playwright:  npm install --no-save playwright && npx playwright install chromium
// Run:               npm run test:browser   (SCREENSHOTS=dir saves screenshots; REDUCED_MOTION=1 shows end states)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// A local install (npm install --no-save playwright) or, failing that, a global one.
let chromium;
try { ({ chromium } = await import("playwright")); } catch (e) { ({ chromium } = createRequire(import.meta.url)("playwright")); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = pathToFileURL(path.join(ROOT, "index.html")).href;
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// [route, screenshot name or null]
const ROUTES = [
  ["#/", "home"],
  ["#/architecture", null],
  ["#/architecture/c/kube-apiserver", "component"],
  ["#/architecture/flow/apply-to-running/5", "flow"],
  ["#/eks", "eks"],
  ["#/eks?layer=networking", "eks-lens"],
  ["#/eks/c/pod-identity-agent", null],
  ["#/eks/flow/eks-pvc-to-ebs/3", null],
  ["#/failures", null],
  ["#/failures?symptom=crashloop", "symptoms"],
  ["#/failures?mode=origins&map=eks&at=iam", "origins"],
  ["#/failures?mode=list", null],
  ["#/failures/pod-ip-exhaustion", "failure"],
  ["#/failures/oomkilled?tab=investigate", null],
  ["#/incidents", null],
  ["#/incidents/subnet-ran-out/4", "incident"],
  ["#/incidents/deploys-stopped/7", "incident-root-cause"],
  ["#/operations/observe?layer=pods", null],
  ["#/operations/respond?step=2", "respond"],
  ["#/operations/runbooks/pod-ip-exhaustion?item=0:0", "runbook"],
  ["#/operations/upgrade?step=5", null],
  ["#/operations/capacity", "capacity"],
  ["#/operations/contract?spot=shutdown", null],
  ["#/operations/security?ring=4", null],
];

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: process.env.REDUCED_MOTION ? "reduce" : "no-preference" });
// Web fonts are optional; answer them locally so the test never depends on the network.
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
page.on("pageerror", (e) => problems.push(`page error at ${page.url().split("#")[1]}: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console error at ${page.url().split("#")[1]}: ${m.text()}`); });

async function visit(route, wait) {
  await page.evaluate((h) => { location.hash = h; }, route);
  await page.waitForTimeout(wait);
  if (await page.$(".crash")) problems.push(`view failed to draw: ${route}`);
  const n = await page.$$eval("main *", (els) => els.length);
  if (n < 12) problems.push(`nothing rendered: ${route}`);
}

await page.goto(BASE + "#/");
for (const [route, shot] of ROUTES) {
  await visit(route, shot ? 2600 : 300);
  if (SHOTS && shot) await page.screenshot({ path: path.join(SHOTS, shot + ".png") });
}
const ids = await page.evaluate(() => window.KA.data.failures.map((f) => f.id));
for (const id of ids) await visit("#/failures/" + id + "?tab=all", 80);

// The paste matcher ranks the cause first.
await visit("#/failures", 200);
await page.fill("#paste", "Warning  FailedCreatePodSandBox  kubelet  Failed to create pod sandbox: plugin type=\"aws-cni\" failed (add): add cmd: failed to assign an IP address to container");
await page.waitForTimeout(400);
const top = await page.$eval(".results li a", (a) => a.getAttribute("href")).catch(() => null);
if (top !== "#/failures/pod-ip-exhaustion") problems.push(`paste matcher: expected pod-ip-exhaustion first, got ${top}`);

// Find works from the keyboard.
await page.keyboard.press("Escape");
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press("/");
await page.keyboard.type("kubelet");
await page.waitForTimeout(100);
if (!(await page.$$eval("#finder-list a", (a) => a.length))) problems.push("Find returned nothing for 'kubelet'");
await page.keyboard.press("Escape");
if (await page.$eval("#finder", (d) => d.open)) problems.push("Escape did not close Find");

// Dark theme and a phone-sized screen.
await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
await visit("#/failures/dns-timeouts", 2600);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "dark.png") });
await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
await page.setViewportSize({ width: 390, height: 844 });
await visit("#/failures/alb-targets-unhealthy", 1800);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "mobile.png"), fullPage: false });

await browser.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: ${ROUTES.length + ids.length + 2} routes rendered in Chromium without errors`);
