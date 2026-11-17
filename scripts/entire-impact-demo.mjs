// Entire native-impact demo and check (new work, personal fork). Needs .demo/shop-sample and the entire-graph plugin.
//   node scripts/entire-impact-demo.mjs
// Scenario A: the real req-17 commit 1 (a function edit). Entire's own `impact` must agree with Impact's call walk and its test mapper.
// Scenario B: a throwaway commit that only changes the type `Cart` (no function edited). Impact's own logic finds
// nothing; the native `entire-graph impact` step must find the functions that use the type.
// The throwaway commit lives on a temporary branch in the gitignored .demo/shop-sample and is deleted afterwards.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SAMPLE_REPO } from "../src/lib/paths.mjs";

process.env.IMPACT_GRAPH_PROVIDER = "entire";
const { buildModel, loadBrief, loadRevisions } = await import("../src/lib/model.mjs");
const git = (...a) => execFileSync("git", ["-C", SAMPLE_REPO, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const rev = loadRevisions();
const req17 = rev.prs.find((p) => p.id === "req-17");
const labels = (xs) => xs.map((x) => x.label);
const failures = [];
const expect = (name, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures.push(name);
};

console.log("A. req-17 commit 1 (edits applyDiscount)");
const sha1 = req17.commits[0].sha;
const a = buildModel(rev, "req-17", sha1);
const na = a.impact.native?.targets[0];
console.log(`  Impact downstream: ${labels(a.impact.downstream).join(", ")}`);
console.log(`  Entire impact callers: ${na.callers.map((c) => `${c.id}${c.callSite ? `@${c.callSite.line}` : ` (via ${c.via})`}`).join(", ")}`);
console.log(`  Entire data flows out: ${na.dataFlows.map((d) => d.id).join(", ")}`);
expect("native impact ran (provider is Entire)", /^Entire Graph/.test(a.coverage.indexer) && a.impact.native?.tool?.startsWith("Entire Graph"));
expect("Entire's callers include everything Impact's downstream has", a.impact.downstream.every((d) => na.callers.some((c) => c.id === d.id)));
expect("test files Entire sees == test files the test mapper reaches", na.testFiles.entireOnly.length === 0 && na.testFiles.entire.length > 0);

console.log("B. a commit that only edits the type Cart");
const branch = "scenario/entire-impact-demo";
let sha2;
try {
  git("checkout", "-q", "-b", branch, rev.base.sha);
  const file = path.join(SAMPLE_REPO, "src/checkout/checkout.ts");
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("  discountPercent: number;")) throw new Error("sample changed; scenario B needs Cart.discountPercent");
  fs.writeFileSync(file, text.replace("  discountPercent: number;", "  discountPercent: number | undefined;"));
  git("-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "commit", "-q", "-am", "Scenario: Cart.discountPercent may be undefined");
  sha2 = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  const pr = { ...req17, id: "scenario-cart-type", commits: [{ sha: sha2, index: 1, message: "Scenario", date: "2026-11-17T09:00:00Z" }] };
  const scenario = { ...rev, prs: [...rev.prs, pr] };
  const opts = { brief: loadBrief("req-17") }; // borrowed agent notes: only the impact analysis matters here
  process.env.IMPACT_ENTIRE_IMPACT = "off";
  const before = buildModel(scenario, pr.id, sha2, opts);
  delete process.env.IMPACT_ENTIRE_IMPACT;
  const after = buildModel(scenario, pr.id, sha2, opts);
  console.log(`  before (Impact's own logic): edited [${labels(before.impact.edited)}] downstream [${labels(before.impact.downstream)}] unverified [${labels(before.impact.unverified)}]`);
  console.log(`  after  (native Entire impact): edited [${labels(after.impact.edited)}] downstream [${labels(after.impact.downstream)}] unverified [${labels(after.impact.unverified)}]`);
  for (const t of after.impact.native.targets) console.log(`  Entire impact on ${t.id}: type consumers ${[...new Set(t.typeConsumers.map((c) => c.id.split("#")[1]))].join(", ")}; test mapper reaches ${t.testFiles.testMapper.join(", ")}`);
  expect("before: Impact finds no downstream for a type-only edit", before.impact.downstream.length === 0 && !before.impact.native);
  expect("after: Entire finds the functions that use Cart", ["cartSubtotal()", "checkoutTotal()"].every((l) => labels(after.impact.downstream).includes(l)));
  expect("after: they carry Entire provenance", after.impact.native.addedDownstream.every((x) => /Entire Graph impact/.test(x.via)));
  expect("after: they flow into the existing evidence step", ["cartSubtotal()", "checkoutTotal()"].every((l) => labels(after.impact.unverified).includes(l)));
} finally {
  try {
    git("checkout", "-q", "main");
  } catch {}
  try {
    git("branch", "-D", branch);
  } catch {}
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll native-impact checks passed.");
process.exit(failures.length ? 1 : 0);
