import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA, DEMO, LIVE_DIR } from "./paths.mjs";

const RUNS = LIVE_DIR ? path.join(LIVE_DIR, "runs") : path.join(DATA, "runs");
export const TEST_COMMAND = 'node --test "tests/**/*.test.ts"';

function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Run the known test command in a folder. Returns outcomes; saves nothing. */
export function runIn(snapshotDir, tag = "run") {
  fs.mkdirSync(DEMO, { recursive: true });
  const junitFile = path.join(DEMO, `junit-${tag}-${process.pid}.xml`);
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${junitFile}`,
      "tests/**/*.test.ts",
    ],
    { cwd: snapshotDir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
  );
  const xml = fs.existsSync(junitFile) ? fs.readFileSync(junitFile, "utf8") : "";
  fs.rmSync(junitFile, { force: true });
  const tests = [];
  const re = /<testcase name="([^"]*)"[^>]*?file="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const name = unescapeXml(m[1]);
    const file = path.relative(snapshotDir, unescapeXml(m[2])).split(path.sep).join("/");
    const body = m[4] ?? "";
    const status = /<failure|<error/.test(body) ? "failed" : /<skipped/.test(body) ? "skipped" : "passed";
    tests.push({ id: `test:${file}#${name}`, file, name, status });
  }
  // Strip machine paths (plain, and as the file URLs in stack traces) and timings so the saved record is stable and shareable.
  const rawOutput = (result.stdout + (result.stderr ? "\n" + result.stderr : ""))
    .split(pathToFileURL(snapshotDir).href).join("<snapshot>")
    .split(snapshotDir).join("<snapshot>")
    .replace(/\(\d+(\.\d+)?ms\)/g, "")
    .replace(/duration_ms [\d.]+/g, "duration_ms -");
  return {
    exitCode: result.status,
    status: result.status === 0 && tests.length > 0 ? "passed" : "failed",
    counts: {
      total: tests.length,
      passed: tests.filter((t) => t.status === "passed").length,
      failed: tests.filter((t) => t.status === "failed").length,
    },
    tests,
    rawOutput,
  };
}

function save(name, record) {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(path.join(RUNS, name), JSON.stringify(record, null, 2) + "\n");
  return record;
}
const load = (name) => {
  const file = path.join(RUNS, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};

/**
 * Run the sample's known test command in a clean snapshot of one commit.
 * The record is tied to that commit SHA. This is a local run, not CI.
 */
export function runTests(sha, snapshotDir) {
  return save(`${sha}.json`, {
    check: "unit-tests",
    kind: "local",
    kindLabel: "Local run by the demo runner (no CI in this demo)",
    revision: sha,
    command: TEST_COMMAND,
    ...runIn(snapshotDir, sha),
    nodeVersion: process.version,
    ranAt: new Date().toISOString(),
  });
}
export const loadRun = (sha) => load(`${sha}.json`);

/**
 * Before/after evidence: run a commit's tests against the BASE code.
 * A test that fails here and passes on the commit shows the change caused the behaviour.
 * A test that passes on both shows the behaviour held. (Idea from the Impact Ledger project.)
 */
export function runHeadTestsOnBase(sha, baseSha, overlayDir) {
  return save(`${sha}.base.json`, {
    check: "unit-tests",
    kind: "local",
    kindLabel: "Local run: this commit's tests against the base code",
    revision: baseSha,
    testsFrom: sha,
    overlay: `tests/ taken from commit ${sha.slice(0, 7)}, everything else from base ${baseSha.slice(0, 7)}`,
    command: TEST_COMMAND,
    ...runIn(overlayDir, `${sha}-base`),
    nodeVersion: process.version,
    ranAt: new Date().toISOString(),
  });
}
export const loadBaseRun = (sha) => load(`${sha}.base.json`);
