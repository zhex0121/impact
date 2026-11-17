// Live "review this change" (new work, personal fork). Runs Impact's review pipeline on a change that was
// never recorded: base..head in a local git repo.
//
//   node scripts/review-change.mjs [--repo <path>] [--head <ref>] [--base <ref>]
//                                  [--ai-review] [--no-tests] [--json]
//                                  [--sign-off "<name>" --residual-risk "<text>" [--override --reason "<text>"]]
//
// What runs live: the tests (head, and head's tests against the base code), the Entire Graph code index
// (IMPACT_GRAPH_PROVIDER=entire, including native `entire-graph impact`), buildModel, the rule-based classifier, the claim
// verifier and the sign-off record. The AI review runs only with --ai-review (needs the `claude` CLI); without it
// the model's labelled rule-based fallback is used. There is no author brief for a live change, so no claims are checked.
// Nothing is written to data/: runs, reviews and decisions go to .demo/live/.
//
// The repo must look like the shop sample: TypeScript under src/ and tests/*.test.ts run with `node --test`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const die = (msg) => {
  console.error(`review-change: ${msg}`);
  process.exit(2);
};

const repo = path.resolve(opt("repo", path.join(ROOT, ".demo", "shop-sample")));
if (!fs.existsSync(path.join(repo, ".git"))) die(`${repo} is not a git repository. Pass --repo <path>.`);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let head, base;
try {
  head = git("rev-parse", "--verify", `${opt("head", "HEAD")}^{commit}`);
  const baseRef = opt("base") ?? ["main", "master"].find((r) => { try { git("rev-parse", "--verify", r); return true; } catch { return false; } });
  if (!baseRef) die("no --base given and no main or master branch found.");
  base = git("merge-base", baseRef, head);
} catch (err) {
  die(`could not resolve the commits: ${err.stderr?.toString().trim() || err.message}`);
}
if (base === head) die("base and head are the same commit, so there is no change to review. Pass --base <ref> or check out a branch.");

// The pipeline reads these at import time.
process.env.IMPACT_REPO = repo;
process.env.IMPACT_LIVE_DIR = path.join(ROOT, ".demo", "live");
process.env.IMPACT_GRAPH_PROVIDER ??= "entire";
if (process.env.IMPACT_GRAPH_PROVIDER !== "entire") die("a live change has no saved code index, so it needs IMPACT_GRAPH_PROVIDER=entire (the default here).");

const { buildModel } = await import("../src/lib/model.mjs");
const { runTests, runHeadTestsOnBase } = await import("../src/lib/runner.mjs");
const { snapshot, snapshotBaseWithTestsFrom } = await import("../src/lib/sample.mjs");
const { runLiveReview } = await import("../src/lib/reviewer.mjs");
const { decisionView, recordDecision } = await import("../src/lib/decisions.mjs");
const { issueList } = await import("../src/lib/verdict.mjs");
const { entireGraphVersion } = await import("../src/lib/entire-graph.mjs");

if (!entireGraphVersion()) die("the entire-graph plugin was not found. Install it with: entire plugin install graph");

const short = (s) => s.slice(0, 7);
const meta = (ref, fmt) => git("show", "-s", `--format=${fmt}`, ref);
const subject = meta(head, "%s");
const log = git("log", "--format=%s%n%b", `${base}..${head}`);
const requirement = (/REQ-\d+/.exec(`${opt("head", "")} ${git("rev-parse", "--abbrev-ref", head).replace("HEAD", "")} ${log}`) ?? [null])[0];
const id = `live-${short(head)}`;
const liveDir = process.env.IMPACT_LIVE_DIR;
const decisionsFile = path.join(liveDir, "decisions.json");

const commit = { sha: head, message: subject, date: meta(head, "%aI"), index: 1 };
const revisions = {
  repoName: path.basename(repo),
  github: { fullName: `local/${path.basename(repo)}` },
  author: { name: meta(head, "%an"), email: meta(head, "%ae") },
  base: { sha: base, branch: "base", message: meta(base, "%s"), date: meta(base, "%aI") },
  prs: [{ id, number: 0, repo: `local/${path.basename(repo)}`, title: subject, requirement, kind: "live", branch: opt("head", "HEAD"), commits: [commit] }],
};
// No author wrote a brief for this change. Say so, and let nothing in it count as a claim or a rollback plan.
const NONE = "(none: this change was reviewed live from a commit, with no PR brief)";
const brief = {
  pr: id, requirement, author: `${meta(head, "%an")} (from the commit)`, authorKind: "unknown",
  why: log.trim() || NONE, before: NONE, after: NONE, preserve: NONE, approach: NONE, alternatives: null, rollback: null, revisions: {},
};

// ---- Live evidence -----------------------------------------------------------------------------
const step = (text) => process.stderr.write(`${text}\n`);
if (!flag("no-tests")) {
  step(`1/3 Running the tests on ${short(head)} and on its tests against base ${short(base)}`);
  runTests(head, snapshot(head));
  runHeadTestsOnBase(head, base, snapshotBaseWithTestsFrom(base, head));
} else step("1/3 Tests skipped (--no-tests): a run saved in .demo/live for this exact commit is used if there is one, otherwise the review will say the proof is missing");

step("2/3 Building the review (Entire Graph index and native impact, live)");
let model = buildModel(revisions, id, head, { brief });

step(flag("ai-review") ? "3/3 Asking the AI reviewer (claude CLI, fresh process)" : "3/3 AI review not requested (--ai-review): using the labelled rule-based fallback");
if (flag("ai-review")) {
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) die("--ai-review needs the claude CLI, which was not found.");
  try {
    runLiveReview(head, model.reviewInput);
    model = buildModel(revisions, id, head, { brief });
  } catch (err) {
    step(`    AI review FAILED: ${err.message}\n    Continuing with the rule-based fallback.`);
  }
}

// ---- Sign-off (optional) -----------------------------------------------------------------------
let signResult = null;
if (opt("sign-off")) {
  signResult = recordDecision(model, { action: "sign-off", name: opt("sign-off"), residualRisk: opt("residual-risk", ""), override: flag("override"), reason: opt("reason", "") }, decisionsFile);
}
model.decisions = decisionView(model, decisionsFile);

fs.mkdirSync(liveDir, { recursive: true });
const modelFile = path.join(liveDir, `${id}.model.json`);
fs.writeFileSync(modelFile, JSON.stringify(model, null, 1) + "\n");
if (flag("json")) {
  console.log(JSON.stringify(model, null, 1));
  process.exit(signResult && !signResult.ok ? 1 : 0);
}

// ---- Report ------------------------------------------------------------------------------------
const labels = (xs) => xs.map((x) => x.label).join(", ") || "none";
const out = [];
const h = (t) => out.push("", t, "-".repeat(t.length));
const m = model;
out.push(`IMPACT REVIEW  ${subject}`);
out.push(`${path.basename(repo)}  ${short(base)}..${short(head)}  by ${meta(head, "%an")}${requirement ? `  requirement ${requirement}` : "  (no REQ-n found in the branch or commit messages)"}`);
out.push(`Code index: ${m.coverage.indexer}`);

h("Verdict");
const c2 = m.classifier2;
out.push(`${c2.route}. Severity ${c2.severity}. ${c2.reason}`);
for (const b of c2.blockers) out.push(`  BLOCKER: ${b.text}`);

h("Tests (run now, not replayed)");
for (const c of m.checks) out.push(`${c.name}: ${c.status}${c.counts ? ` (${c.counts.passed}/${c.counts.total} pass)` : ""}`);
const proof = m.tests.filter((t) => t.proof);
if (m.baseRun) out.push(`Against the base code: ${m.baseRun.counts.failed} failing, ${m.baseRun.counts.passed} passing. ${proof.filter((t) => t.proof === "changed").length} test(s) fail on the old code and pass on the change, ${proof.filter((t) => t.proof === "held").length} held.`);
for (const t of m.tests.filter((t) => t.status === "failed")) out.push(`  FAILING: ${t.name}`);

h("What the change reaches");
out.push(`Edited:     ${labels(m.impact.edited)}`);
out.push(`Downstream: ${labels(m.impact.downstream)}`);
const tested = new Set(m.tests.flatMap((t) => t.reaches));
const affected = m.graph.nodes.filter((n) => n.level === "function" && n.type === "function" && (n.state === "edited" || n.state === "downstream"));
const bare = affected.filter((n) => !tested.has(n.id));
out.push(`Affected functions no test reaches at all: ${bare.map((n) => `${n.label.replace("()", "")}()`).join(", ") || "none (a test reaches every one; the evidence below says which tests cite the requirement)"}`);
for (const t of m.impact.native?.targets ?? []) {
  out.push(`Entire Graph impact on ${t.id.replace(/^(fn|type):/, "")} (${t.kind}):`);
  for (const c of t.callers.filter((c) => c.kind !== "file")) out.push(`  caller ${c.id.replace(/^fn:/, "")}${c.callSite ? ` at line ${c.callSite.line}` : ""} (depth ${c.depth})`);
  for (const c of [...new Map(t.typeConsumers.map((c) => [c.id, c])).values()]) out.push(`  uses the type: ${c.id.replace(/^fn:/, "")}`);
  for (const d of t.dataFlows) out.push(`  data flows into ${d.id.replace(/^fn:/, "")}`);
}
if (m.evidence.length) {
  h(`Evidence for ${m.pr.requirement}`);
  for (const e of m.evidence) out.push(`${e.label}: ${e.statusLabel}${e.missing ? ` (${e.missing})` : ""}`);
}

h("AI review");
out.push(m.review.modeLabel ?? m.review.mode);
for (const f of m.review.findings) out.push(`  [${f.category}] ${f.title}`);
for (const q of m.review.couldNotDecide) out.push(`  could not decide: ${q.question}`);
if (!m.review.findings.length && !m.review.couldNotDecide.length) out.push("  no findings");

h("Open points for the reviewer");
const points = issueList(m);
if (!points.length) out.push("none");
for (const p of points) out.push(`  [${p.level}] ${p.title}${p.fix ? `  -> ${p.fix}` : ""}`);

h("What this review does NOT know");
for (const g of m.coverage.gaps) out.push(`  - ${g}`);
out.push("  - No author brief: no claims were verified and no rollback plan is recorded.");
if (!flag("ai-review")) out.push("  - The AI review was not run; the rule-based fallback has no judgement of the diff.");
out.push("  - There is no blast-radius or swarm evidence for a live change (those replay recorded agent runs).");

h("Sign-off");
if (signResult && !signResult.ok) out.push(`REFUSED: ${signResult.error}`);
else if (m.decisions.signedOff) {
  const d = m.decisions.signOff;
  out.push(`${d.override ? "Merged against the rules" : "Signed off"} by ${d.name} on ${short(d.commit)} at ${d.at}. Residual risk accepted: ${d.residualRisk}`);
  if (d.unchecked.length) out.push(`  Left unchecked: ${d.unchecked.map((u) => u.what).join("; ")}`);
} else {
  out.push(m.decisions.canSignOff ? "Not signed off. Nothing blocks a sign-off:" : "Not signed off. The rules block a sign-off until the proof above exists. To merge anyway, override on purpose:");
  out.push(`  node scripts/review-change.mjs --repo ${path.relative(process.cwd(), repo) || "."} --head ${short(head)} --base ${short(base)} --sign-off "<your name>" --residual-risk "<what you accept>"${m.decisions.canSignOff ? "" : ' --override --reason "<why>"'}`);
}
out.push("", `Full review data: ${path.relative(process.cwd(), modelFile)}`);
console.log(out.join("\n"));
process.exit(signResult && !signResult.ok ? 1 : 0);
