// Graph provider selection. Graphify (the Junction team's code index) is the default.
// Entire Graph is opt-in (new work, personal fork):  IMPACT_GRAPH_PROVIDER=entire
//
// loadIndex(sha) returns the same index shape from either provider, so the analysis in model.mjs
// does not know which one it got. Entire mode runs the installed `entire-graph snapshot` on a clean
// export of that commit, every process, nothing read from data/entire-graph/. If Entire fails it throws.
// There is no fallback to Graphify, so the provider named in the output is the one that ran.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptImpact, adaptSnapshot, entireGraphVersion, runEntireImpact, runEntireSnapshot } from "./entire-graph.mjs";
import { loadIndex as loadGraphifyIndex } from "./graphify.mjs";
import { SAMPLE_REPO } from "./paths.mjs";

export const PROVIDERS = ["graphify", "entire"];

export function providerName() {
  const name = (process.env.IMPACT_GRAPH_PROVIDER ?? "graphify").trim().toLowerCase();
  if (!PROVIDERS.includes(name)) throw new Error(`IMPACT_GRAPH_PROVIDER="${name}" is not a provider. Use one of: ${PROVIDERS.join(", ")}.`);
  return name;
}

// Same file scope the Graphify adapter uses (graphify.mjs#isCode): TypeScript under src/ and tests/.
const inScope = (file) => /^(src|tests)\/.+\.ts$/.test(file ?? "");
const isTestFile = (file) => /^tests\//.test(file ?? "");
const cache = new Map(); // per process only; a new process extracts again

function requireEntire() {
  if (!entireGraphVersion()) {
    throw new Error("IMPACT_GRAPH_PROVIDER=entire, but the entire-graph plugin was not found. Install it with: entire plugin install graph");
  }
}

/** Run `fn(dir)` on a clean, committed-tree export of `sha`, then delete the export. */
function withExport(sha, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "impact-entire-"));
  try {
    const dir = path.join(work, "src");
    fs.mkdirSync(dir);
    // The committed tree only, so the graph describes exactly this revision.
    const tar = execFileSync("git", ["-C", SAMPLE_REPO, "archive", sha], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return fn(dir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Run Entire Graph on a clean export of `sha` from the sample repo and adapt the result. */
function loadEntireIndex(sha) {
  if (cache.has(sha)) return cache.get(sha);
  requireEntire();
  try {
    const index = withExport(sha, (dir) =>
      adaptSnapshot(runEntireSnapshot(dir), {
        scope: inScope,
        testFile: isTestFile,
        importsFromFileCalls: true,
        readSource: (file) => {
          try {
            return fs.readFileSync(path.join(dir, file), "utf8");
          } catch {
            return null;
          }
        },
      }),
    );
    index.revision = sha;
    cache.set(sha, index);
    return index;
  } catch (err) {
    throw new Error(`Entire Graph provider failed for ${sha.slice(0, 7)}: ${err.message}`);
  }
}

const impactCache = new Map(); // `${sha}|${symbol id}` -> adapted native impact; per process only

/**
 * Native `entire-graph impact` for each of `symbols` (entries of the index loaded for `sha`).
 * One clean export per call, deleted afterwards. Returns Map(symbol id -> adapted impact).
 * Throws if Entire fails; never answers from Graphify.
 */
export function nativeImpacts(sha, index, symbols) {
  const out = new Map();
  const missing = symbols.filter((s) => !impactCache.has(`${sha}|${s.id}`));
  if (missing.length) {
    requireEntire();
    try {
      withExport(sha, (dir) => {
        for (const s of missing) impactCache.set(`${sha}|${s.id}`, runEntireImpact(dir, s));
      });
    } catch (err) {
      throw new Error(`Entire Graph impact failed for ${sha.slice(0, 7)}: ${err.message}`);
    }
  }
  const byEntireId = new Map([...index.symbols, ...index.testSymbols].map((x) => [x.entireId, x]));
  for (const s of symbols) out.set(s.id, adaptImpact(impactCache.get(`${sha}|${s.id}`), { repoKey: index.repoKey, byEntireId }));
  return out;
}

export function loadIndex(sha) {
  return providerName() === "entire" ? loadEntireIndex(sha) : loadGraphifyIndex(sha);
}

export const isEntire = (index) => index?.tool === "entire-graph";

/** Short name of the tool that built an index, for labels in the review. */
export const indexerLabel = (index) => (isEntire(index) ? `Entire Graph ${index.entireGraphVersion}` : `Graphify ${index.graphifyVersion}`);
