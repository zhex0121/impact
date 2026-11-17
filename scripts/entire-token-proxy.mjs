// Output-size proxy: how much text must an agent take in to answer a code question, with Entire Graph vs with grep.
//   node scripts/entire-token-proxy.mjs [--also-self]
// Needs .demo/shop-sample (npm run setup) and the entire-graph plugin.
//
// WHAT THIS IS: bytes of tool output for three fixed questions on the shop sample at its base commit. "~tokens" is
// bytes/4, a rough rule of thumb. It is NOT measured agent token use, time, cost or productivity: no model runs here.
// Correctness: the Entire answer's set is compared with what Impact's own components say (evals/expected.json and the saved
// Graphify index + test mapper). The grep side is not scored: grep returns lines, and an agent must still work out
// which function each line is in, so its size is a floor for the context it needs.
// --also-self repeats the size measurement (no scoring) on this repo's own JavaScript, a larger codebase.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entireGraphBin, entireGraphVersion } from "../src/lib/entire-graph.mjs";
import { loadIndex } from "../src/lib/graphify.mjs";
import { loadRevisions } from "../src/lib/model.mjs";
import { SAMPLE_REPO } from "../src/lib/paths.mjs";
import { mapTests } from "../src/lib/testmap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!entireGraphVersion()) {
  console.error("entire-graph plugin not found (entire plugin install graph).");
  process.exit(2);
}
if (!fs.existsSync(path.join(SAMPLE_REPO, ".git"))) {
  console.error("No .demo/shop-sample. Run: npm run setup");
  process.exit(2);
}

const exportTree = (repo, rev, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-x", "-C", dir], { input: execFileSync("git", ["-C", repo, "archive", rev], { maxBuffer: 512 * 1024 * 1024 }) });
  execFileSync("git", ["init", "-q"], { cwd: dir });
};
const walk = (dir, roots) => {
  const out = [];
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) rec(r);
      else if (/\.(ts|mjs|js|jsx)$/.test(e.name) && !/bundle|vendor/.test(r)) out.push(r);
    }
  };
  for (const root of roots) if (fs.existsSync(path.join(dir, root))) rec(root);
  return out.sort();
};
/** grep -rnw <symbol>: the matching lines, and the size of the files an agent would then open to see the context. */
const grep = (dir, roots, sym) => {
  const re = new RegExp(`\\b${sym.replace(/[$]/g, "\\$")}\\b`);
  let lines = 0, bytes = 0;
  const files = [];
  for (const f of walk(dir, roots)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const hits = text.split("\n").map((l, i) => (re.test(l) ? `${f}:${i + 1}:${l}\n` : null)).filter(Boolean);
    if (hits.length) {
      lines += hits.length;
      bytes += hits.reduce((n, h) => n + Buffer.byteLength(h), 0);
      files.push({ f, size: Buffer.byteLength(text) });
    }
  }
  return { hitLines: lines, grepBytes: bytes, files: files.length, grepPlusFilesBytes: bytes + files.reduce((n, x) => n + x.size, 0) };
};
const impact = (dir, sym, format) => {
  const r = spawnSync(entireGraphBin(), ["impact", "--symbol", sym, "--repo", dir, "--format", format], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`entire-graph impact ${sym} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
};
const tok = (b) => Math.round(b / 4);
const same = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

const work = fs.mkdtempSync(path.join(os.tmpdir(), "impact-proxy-"));
try {
  // ---- The shop sample: sizes and correctness ----------------------------------------------------
  const base = loadRevisions().base.sha;
  const dir = path.join(work, "shop");
  exportTree(SAMPLE_REPO, base, dir);
  const index = loadIndex(base); // Impact's saved Graphify index at this commit
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "expected.json"), "utf8")).walkthrough.base;
  const callersOf = (name) => index.calls.filter((c) => c.to.endsWith(`#${name}`)).map((c) => c.from.split("#")[1]);
  const testFilesOf = (name) => mapTests(base, index).filter((t) => t.reaches.some((id) => id.endsWith(`#${name}`))).map((t) => t.file);
  const questions = [
    { q: "Who calls applyDiscount()?", sym: "applyDiscount", truth: expected.callersOfApplyDiscount.map((id) => id.split("#")[1]), truthFrom: "evals/expected.json", pick: (j) => j.callers.entries.filter((e) => e.depth === 1 && e.endpoint.kind === "function").map((e) => e.endpoint.name) },
    { q: "Who calls cartSubtotal()?", sym: "cartSubtotal", truth: callersOf("cartSubtotal"), truthFrom: "saved Graphify index", pick: (j) => j.callers.entries.filter((e) => e.depth === 1 && e.endpoint.kind === "function").map((e) => e.endpoint.name) },
    { q: "Which test files exercise applyDiscount()?", sym: "applyDiscount", truth: testFilesOf("applyDiscount"), truthFrom: "Impact test mapper", pick: (j) => j.callers.entries.filter((e) => e.endpoint.kind === "file" && /^tests\//.test(e.endpoint.file_path)).map((e) => e.endpoint.file_path) },
  ];
  console.log(`Shop sample at ${base.slice(0, 7)} (7 TypeScript files). ~tokens = bytes/4, a rough proxy, not measured agent use.\n`);
  console.log("| Question | grep lines | grep + open matching files | Entire `impact` (text) | Entire answer == Impact ground truth |");
  console.log("|---|---|---|---|---|");
  let allOk = true;
  for (const k of questions) {
    const g = grep(dir, ["src", "tests"], k.sym);
    const text = impact(dir, k.sym, "text");
    const ours = k.pick(JSON.parse(impact(dir, k.sym, "json")));
    const ok = same(ours, k.truth);
    allOk &&= ok;
    console.log(`| ${k.q} | ${g.grepBytes} B (~${tok(g.grepBytes)}) | ${g.grepPlusFilesBytes} B (~${tok(g.grepPlusFilesBytes)}, ${g.files} files) | ${Buffer.byteLength(text)} B (~${tok(Buffer.byteLength(text))}) | ${ok ? "yes" : "NO"}: [${[...new Set(ours)].sort().join(", ")}] vs ${k.truthFrom} |`);
  }
  console.log(allOk ? "\nAll three Entire answers match Impact's ground truth." : "\nMISMATCH: at least one Entire answer differs from Impact's ground truth.");

  // ---- Optional: this repo's own JavaScript, sizes only ------------------------------------------
  if (process.argv.includes("--also-self")) {
    const self = path.join(work, "self");
    exportTree(ROOT, "HEAD", self);
    const n = walk(self, ["src", "scripts", "evals"]).length;
    console.log(`\nThis repo's own JavaScript at HEAD (${n} files under src/, scripts/, evals/). Sizes only, answers not scored.\n`);
    console.log("| Symbol | grep lines | grep + open matching files | Entire `impact` (text) |");
    console.log("|---|---|---|---|");
    for (const sym of ["loadIndex", "buildModel", "readFileAt"]) {
      const g = grep(self, ["src", "scripts", "evals"], sym);
      const text = impact(self, sym, "text");
      console.log(`| ${sym} | ${g.grepBytes} B (~${tok(g.grepBytes)}) | ${g.grepPlusFilesBytes} B (~${tok(g.grepPlusFilesBytes)}, ${g.files} files) | ${Buffer.byteLength(text)} B (~${tok(Buffer.byteLength(text))}) |`);
    }
  }
  process.exitCode = allOk ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
