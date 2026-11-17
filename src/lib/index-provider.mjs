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
import { adaptSnapshot, entireGraphVersion, runEntireSnapshot } from "./entire-graph.mjs";
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

/** Run Entire Graph on a clean export of `sha` from the sample repo and adapt the result. */
function loadEntireIndex(sha) {
  if (cache.has(sha)) return cache.get(sha);
  if (!entireGraphVersion()) {
    throw new Error("IMPACT_GRAPH_PROVIDER=entire, but the entire-graph plugin was not found. Install it with: entire plugin install graph");
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "impact-entire-"));
  try {
    const dir = path.join(work, "src");
    fs.mkdirSync(dir);
    // The committed tree only, so the graph describes exactly this revision.
    const tar = execFileSync("git", ["-C", SAMPLE_REPO, "archive", sha], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const raw = runEntireSnapshot(dir);
    const index = adaptSnapshot(raw, {
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
    });
    index.revision = sha;
    cache.set(sha, index);
    return index;
  } catch (err) {
    throw new Error(`Entire Graph provider failed for ${sha.slice(0, 7)}: ${err.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

export function loadIndex(sha) {
  return providerName() === "entire" ? loadEntireIndex(sha) : loadGraphifyIndex(sha);
}

export const isEntire = (index) => index?.tool === "entire-graph";

/** Short name of the tool that built an index, for labels in the review. */
export const indexerLabel = (index) => (isEntire(index) ? `Entire Graph ${index.entireGraphVersion}` : `Graphify ${index.graphifyVersion}`);
