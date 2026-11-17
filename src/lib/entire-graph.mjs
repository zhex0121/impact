// ENTIRE GRAPH ADAPTER (new work, personal fork; not part of the Junction team's original code).
//
// Turns the NDJSON written by `entire-graph snapshot --format ndjson --profile full --worktree`
// into the same index shape src/lib/graphify.mjs#loadIndex returns:
//   { files, symbols, calls, imports, unresolved }  (+ extra keys, listed below)
// Nothing here is wired into model.mjs. Field names were checked against real output
// from entire-graph v0.6.0 (schema 1.4); see docs/entire-integration.md.
//
// Rules: never add an edge Entire did not write; keep Entire's own confidence, resolution
// and evidence on every edge; every symbol and edge points at its raw NDJSON line.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENTIRE_GRAPH_COMMAND = "entire-graph snapshot --repo <clean checkout> --format ndjson --profile full --worktree";
// From `entire-graph capabilities --json` (heuristic_relation_types). Kept so callers can flag them.
export const HEURISTIC_RELATIONS = new Set(["HANDLES_ROUTE", "HTTP_CALLS", "EMITS", "LISTENS_ON", "HANDLES_TOOL", "SIMILAR_TO", "TESTS"]);

export function entireGraphBin() {
  const dir = process.env.ENTIRE_PLUGIN_DIR
    ? path.join(process.env.ENTIRE_PLUGIN_DIR, "bin")
    : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "entire", "plugins", "bin");
  const local = path.join(dir, "entire-graph");
  return fs.existsSync(local) ? local : "entire-graph";
}

export function entireGraphVersion() {
  const r = spawnSync(entireGraphBin(), ["version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Run the snapshot on a clean directory. Returns the raw NDJSON text. Writes nothing to disk. */
export function runEntireSnapshot(dir) {
  const r = spawnSync(entireGraphBin(), ["snapshot", "--repo", dir, "--format", "ndjson", "--profile", "full", "--worktree"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`entire-graph snapshot failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** Parse NDJSON into records, remembering each record's 1-based line in the raw output. */
export function parseSnapshot(raw) {
  const records = [];
  raw.split("\n").forEach((text, i) => {
    if (text.trim()) records.push({ ...JSON.parse(text), _line: i + 1 });
  });
  const header = records.find((r) => r.schema_version && r.provider);
  const summary = records.find((r) => r.record_type === "summary");
  if (!header || !summary) throw new Error("snapshot is missing its header or summary record");
  return { header, summary, records };
}

const FN_KINDS = new Set(["function", "method", "constructor"]);
const TYPE_KINDS = new Set(["class", "interface", "struct", "enum", "type", "type_alias", "record"]);

/**
 * @param raw   raw NDJSON text from runEntireSnapshot
 * @param opts  all optional:
 *   scope(file)          restrict symbols and edges to files; default keeps all
 *   testFile(file)       symbols and calls inside these files go to testSymbols / testCalls instead of
 *                        symbols / calls (the Impact map treats test files separately); nothing is dropped
 *   readSource(file)     source text of a file in the snapshot. Used only to turn Entire's call-site range
 *                        into an exact line when exactly one line of the range names the callee
 *   importsFromFileCalls fill `imports` (file -> symbol) from file-scope CALLS, each marked
 *                        via:"entire file-scope call". Entire has no named-import edges, so this is the
 *                        closest relation it writes; it is NOT an import statement
 * @returns the index (see top of file). Extra keys beyond graphify's:
 *   fileImports   file -> file IMPORTS (Entire has no file -> symbol import edges)
 *   fileCalls     CALLS whose source is a file node (test files calling code); not symbol -> symbol
 *   externals     imports Entire could not resolve into the repo
 *   otherSymbols  symbols that are not functions or types (fields, sections, config keys), counts only per kind
 *   otherRelations every other relation type, with counts and heuristic flag
 *   provenance    raw file hash plus per-record raw line numbers sit on each item as `raw`
 */
export function adaptSnapshot(raw, opts = {}) {
  const inScope = opts.scope ?? (() => true);
  const { header, summary, records } = parseSnapshot(raw);
  // Entire ids start with a repo key derived from the directory name. Strip it so ids are location independent.
  const prefix = `${header.repo_key}:`;
  const strip = (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);

  const files = new Map();
  const bySymbolEntireId = new Map();
  const symbols = [];
  const otherSymbolKinds = {};
  const seen = new Set();

  for (const r of records) {
    if (r.record_type === "file") {
      files.set(r.id, { file: r.path, language: r.language, blob: r.blob, raw: { line: r._line } });
    }
  }
  const idOf = (r) => `${FN_KINDS.has(r.kind) ? "fn" : TYPE_KINDS.has(r.kind) ? "type" : r.kind}:${r.file_path}#${r.qualified_name}`;
  const wanted = records.filter((r) => r.record_type === "symbol" && inScope(r.file_path));
  const idCount = new Map();
  for (const r of wanted) idCount.set(idOf(r), (idCount.get(idOf(r)) ?? 0) + 1);
  const ambiguous = [];
  const testSymbols = [];
  for (const r of wanted) {
    const isFn = FN_KINDS.has(r.kind);
    const isType = TYPE_KINDS.has(r.kind);
    // Overloads or same-name symbols would share one Impact id. Every one of them gets the id plus its
    // start line, so none is dropped or merged, and the clash is listed in `ambiguous`.
    const clash = idCount.get(idOf(r)) > 1;
    const id = clash ? `${idOf(r)}~L${r.start_line}` : idOf(r);
    if (seen.has(id)) throw new Error(`duplicate Impact id ${id} even with the line suffix; refusing to merge`);
    seen.add(id);
    const sym = {
      id,
      kind: isFn ? "function" : isType ? "type" : r.kind,
      name: r.qualified_name,
      file: r.file_path,
      line: r.start_line,
      endLine: r.end_line, // from Entire, not brace matching
      signature: r.signature,
      language: r.language,
      entireId: strip(r.id),
      raw: { line: r._line },
    };
    if (clash) ambiguous.push({ id, name: r.qualified_name, file: r.file_path, line: r.start_line, entireId: sym.entireId, raw: sym.raw });
    bySymbolEntireId.set(r.id, sym);
    if (isFn || isType) (opts.testFile?.(sym.file) ? testSymbols : symbols).push(sym);
    else otherSymbolKinds[r.kind] = (otherSymbolKinds[r.kind] ?? 0) + 1;
  }

  const calls = [];
  const testCalls = [];
  const fileCalls = [];
  const sourceCache = new Map();
  const sourceLines = (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, opts.readSource?.(file)?.split("\n") ?? null);
    return sourceCache.get(file);
  };
  // Entire gives the enclosing range of a call and the callee name, not the call line. The line is set only when
  // exactly one line in that range calls the name; otherwise it stays null and the candidates are listed.
  const callLine = (file, ev, calleeName) => {
    const lines = sourceLines(file);
    if (!lines || !ev?.start_line || !calleeName) return { line: null };
    const simple = calleeName.split(".").pop();
    const re = new RegExp(`\\b${simple.replace(/[$]/g, "\\$")}\\s*\\(`);
    const hits = [];
    for (let n = ev.start_line; n <= ev.end_line; n++) if (re.test(lines[n - 1] ?? "")) hits.push(n);
    return hits.length === 1 ? { line: hits[0], lineSource: "entire call-site range + the one line in it that calls the callee" } : { line: null, lineCandidates: hits };
  };
  const fileImports = [];
  const externals = [];
  const otherRelations = {};
  const ext = new Map(records.filter((r) => r.record_type === "external").map((r) => [r.id, r]));

  const edgeMeta = (r) => ({
    confidence: r.provenance, // EXTRACTED | INFERRED | AMBIGUOUS, same labels Graphify uses
    score: r.confidence,
    resolution: r.resolution,
    reason: r.reason,
    evidence: r.evidence ?? [],
    warnings: r.warning_codes ?? [],
    raw: { line: r._line },
  });

  for (const r of records) {
    if (r.record_type !== "relation") continue;
    const from = bySymbolEntireId.get(r.from_id);
    const to = bySymbolEntireId.get(r.to_id);
    const fromFile = files.get(r.from_id);
    const toFile = files.get(r.to_id);
    if (r.type === "CALLS" && from && to && (from.kind === "function" || from.kind === "type") && (to.kind === "function" || to.kind === "type")) {
      // Directed by Entire. The evidence range is the enclosing range, not the exact call line (see callLine).
      const ev = (r.evidence ?? []).find((e) => e.kind === "call_site");
      const edge = { from: from.id, to: to.id, file: from.file, ...callLine(from.file, ev, ev?.detail ?? to.name), ...edgeMeta(r) };
      (opts.testFile?.(from.file) ? testCalls : calls).push(edge);
    } else if (r.type === "CALLS" && fromFile && to) {
      if (inScope(fromFile.file)) fileCalls.push({ fromFile: fromFile.file, to: to.id, line: null, ...edgeMeta(r) });
    } else if (r.type === "IMPORTS" && fromFile) {
      if (!inScope(fromFile.file)) continue;
      if (toFile) fileImports.push({ fromFile: fromFile.file, toFile: toFile.file, ...edgeMeta(r) });
      else externals.push({ file: fromFile.file, target: ext.get(r.to_id)?.value ?? strip(r.to_id), external: ext.get(r.to_id)?.external ?? null, ...edgeMeta(r) });
    } else {
      const o = (otherRelations[r.type] ??= { count: 0, heuristic: HEURISTIC_RELATIONS.has(r.type) });
      o.count++;
    }
  }

  const key = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    revision: null, // set by the caller, who knows the commit
    tool: "entire-graph",
    entireGraphVersion: header.provider_version,
    schemaVersion: header.schema_version,
    profile: header.profile,
    snapshotCompleteness: summary.stats?.completeness_level ?? null,
    files: [...files.values()].map((f) => f.file).filter(inScope).sort(),
    symbols: symbols.sort((a, b) => key(a.id, b.id)),
    calls: calls.sort((a, b) => key(`${a.from}>${a.to}`, `${b.from}>${b.to}`)),
    // Graphify's `imports` are file -> symbol import statements. Entire writes file -> file imports (fileImports).
    // Empty unless the caller opts in to the file-scope CALLS stand-in, which is labelled on every item.
    imports: opts.importsFromFileCalls
      ? fileCalls.map((c) => ({ fromFile: c.fromFile, to: c.to, line: null, via: "entire file-scope call", confidence: c.confidence, score: c.score, resolution: c.resolution, raw: c.raw })).sort((a, b) => key(`${a.fromFile}>${a.to}`, `${b.fromFile}>${b.to}`))
      : [],
    unresolved: externals.map((e) => ({ file: e.file, line: null, target: e.target })).sort((a, b) => key(`${a.file}>${a.target}`, `${b.file}>${b.target}`)),
    testSymbols: testSymbols.sort((a, b) => key(a.id, b.id)),
    testCalls: testCalls.sort((a, b) => key(`${a.from}>${a.to}`, `${b.from}>${b.to}`)),
    ambiguous,
    fileImports: fileImports.sort((a, b) => key(`${a.fromFile}>${a.toFile}`, `${b.fromFile}>${b.toFile}`)),
    fileCalls: fileCalls.sort((a, b) => key(`${a.fromFile}>${a.to}`, `${b.fromFile}>${b.to}`)),
    externals: externals.sort((a, b) => key(`${a.file}>${a.target}`, `${b.file}>${b.target}`)),
    otherSymbols: Object.fromEntries(Object.entries(otherSymbolKinds).sort()),
    otherRelations: Object.fromEntries(Object.entries(otherRelations).sort()),
  };
}

/** Compare two indexes built from the same commit. Pure function; no I/O. */
export function compareIndexes(entire, graphify) {
  const set = (xs) => new Set(xs);
  const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();
  const eSyms = new Map(entire.symbols.map((s) => [s.id, s]));
  const gSyms = new Map(graphify.symbols.map((s) => [s.id, s]));
  const both = [...eSyms.keys()].filter((k) => gSyms.has(k)).sort();
  const callKey = (c) => `${c.from} -> ${c.to}`;
  const eCalls = set(entire.calls.map(callKey));
  const gCalls = set(graphify.calls.map(callKey));
  // Graphify's imports are file -> symbol; Entire's are file -> file. Compare at file level only.
  const gFileImports = set(graphify.imports.map((i) => `${i.fromFile} -> ${i.to.slice(i.to.indexOf(":") + 1).split("#")[0]}`));
  const eFileImports = set(entire.fileImports.map((i) => `${i.fromFile} -> ${i.toFile}`));
  // Test files: Graphify records symbol imports, Entire records file -> symbol CALLS. Compare those pairs.
  const gTestLinks = set(graphify.imports.filter((i) => i.fromFile.startsWith("tests/")).map((i) => `${i.fromFile} -> ${i.to}`));
  const eTestLinks = set(entire.fileCalls.map((c) => `${c.fromFile} -> ${c.to}`));
  const lineMismatch = both
    .filter((id) => eSyms.get(id).line !== gSyms.get(id).line || eSyms.get(id).endLine !== gSyms.get(id).endLine)
    .map((id) => ({ id, entire: [eSyms.get(id).line, eSyms.get(id).endLine], graphify: [gSyms.get(id).line, gSyms.get(id).endLine] }));
  return {
    symbols: {
      entire: eSyms.size,
      graphify: gSyms.size,
      overlap: both.length,
      onlyEntire: diff(set(eSyms.keys()), set(gSyms.keys())),
      onlyGraphify: diff(set(gSyms.keys()), set(eSyms.keys())),
      rangeMismatches: lineMismatch,
    },
    calls: { entire: eCalls.size, graphify: gCalls.size, overlap: [...eCalls].filter((c) => gCalls.has(c)).length, onlyEntire: diff(eCalls, gCalls), onlyGraphify: diff(gCalls, eCalls) },
    fileImports: { entire: eFileImports.size, graphify: gFileImports.size, overlap: [...eFileImports].filter((c) => gFileImports.has(c)).length, onlyEntire: diff(eFileImports, gFileImports), onlyGraphify: diff(gFileImports, eFileImports) },
    testLinks: { entire: eTestLinks.size, graphify: gTestLinks.size, overlap: [...eTestLinks].filter((c) => gTestLinks.has(c)).length, onlyEntire: diff(eTestLinks, gTestLinks), onlyGraphify: diff(gTestLinks, eTestLinks) },
    files: { onlyEntire: diff(set(entire.files), set(graphify.files)), onlyGraphify: diff(set(graphify.files), set(entire.files)) },
  };
}
