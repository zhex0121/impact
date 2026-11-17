// ENTIRE GRAPH PROOF OF CONCEPT (new work, personal fork).
//   node scripts/entire-graph-poc.mjs [sha]        default: the sample's base commit
// Needs .demo/shop-sample (built by `npm run setup`, or by sample.mjs#buildSampleRepo) and the
// entire-graph plugin. Exports that one commit to a temp dir, runs Entire Graph on it, compares
// with the saved Graphify export for the same commit, and writes
//   data/entire-graph/<sha>.json            the Entire index, with provenance
//   data/entire-graph/<sha>.comparison.json Entire vs Graphify
// Reads and changes nothing else. Output has no timestamps or temp paths, so a rerun is byte-identical.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptSnapshot, compareIndexes, ENTIRE_GRAPH_COMMAND, entireGraphVersion, parseSnapshot, runEntireSnapshot, sha256 } from "../src/lib/entire-graph.mjs";
import { loadIndex } from "../src/lib/graphify.mjs";
import { DATA, SAMPLE_REPO } from "../src/lib/paths.mjs";

const BASE = "2e22bc2b2fe422595d6030cac407032205406315";
const sha = process.argv[2] ?? BASE;
// The same scope Graphify's adapter uses (src/lib/graphify.mjs#isCode), so the comparison is like for like.
const scope = (file) => /^(src|tests)\/.+\.ts$/.test(file ?? "");

if (!fs.existsSync(path.join(SAMPLE_REPO, ".git"))) {
  console.error("No .demo/shop-sample. Build it first: npm run setup (or buildSampleRepo()).");
  process.exit(2);
}
if (!entireGraphVersion()) {
  console.error("entire-graph plugin not found. Install it with `entire plugin install graph`.");
  process.exit(2);
}
const graphifyIdx = loadIndex(sha);
if (!graphifyIdx) {
  console.error(`No saved Graphify export for ${sha} in data/graphify/.`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "impact-entire-"));
try {
  const dir = path.join(work, "src");
  fs.mkdirSync(dir);
  // `git archive` writes the committed tree only: the exact source Graphify was run on.
  const tar = execFileSync("git", ["-C", SAMPLE_REPO, "archive", sha], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  execFileSync("git", ["init", "-q"], { cwd: dir });

  const raw = runEntireSnapshot(dir);
  const { records } = parseSnapshot(raw);
  const index = adaptSnapshot(raw, { scope });
  index.revision = sha;
  // Line 1 is the header, which holds the temp path. Hash everything after it.
  const rawBody = raw.split("\n").slice(1).join("\n");
  const record = {
    revision: sha,
    tool: "entire-graph",
    entireGraphVersion: index.entireGraphVersion,
    schemaVersion: index.schemaVersion,
    command: ENTIRE_GRAPH_COMMAND,
    raw: { records: records.length, sha256_excluding_header_line: sha256(rawBody) },
    index,
  };
  const comparison = { revision: sha, graphify: { tool: "graphify", version: graphifyIdx.graphifyVersion, schema: graphifyIdx.schemaVersion }, entire: { tool: "entire-graph", version: index.entireGraphVersion }, scope: String(scope), ...compareIndexes(index, graphifyIdx) };

  const out = path.join(DATA, "entire-graph");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${sha}.json`), JSON.stringify(record, null, 1) + "\n");
  fs.writeFileSync(path.join(out, `${sha}.comparison.json`), JSON.stringify(comparison, null, 1) + "\n");

  const c = comparison;
  console.log(`Entire Graph ${index.entireGraphVersion} vs Graphify ${graphifyIdx.graphifyVersion} on ${sha.slice(0, 7)}`);
  console.log(`symbols      entire ${c.symbols.entire}  graphify ${c.symbols.graphify}  overlap ${c.symbols.overlap}  only-entire ${c.symbols.onlyEntire.length}  only-graphify ${c.symbols.onlyGraphify.length}  range mismatches ${c.symbols.rangeMismatches.length}`);
  console.log(`calls        entire ${c.calls.entire}  graphify ${c.calls.graphify}  overlap ${c.calls.overlap}  only-entire ${c.calls.onlyEntire.length}  only-graphify ${c.calls.onlyGraphify.length}`);
  console.log(`file imports entire ${c.fileImports.entire}  graphify ${c.fileImports.graphify}  overlap ${c.fileImports.overlap}`);
  console.log(`test links   entire ${c.testLinks.entire}  graphify ${c.testLinks.graphify}  overlap ${c.testLinks.overlap}`);
  console.log(`Entire-only relation types: ${JSON.stringify(index.otherRelations)}`);
  console.log(`Wrote data/entire-graph/${sha}.json and .comparison.json`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
