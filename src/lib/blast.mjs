// Blast radius: the same task was given to 3 agents (careful, normal, one that changes too much).
// What they touched is the zone a fix can reasonably reach. The real change is laid over it.
//
// The runs are recorded in data/tieto/<pr>/blast.json by scripts/record-blast.mjs, and for the
// shop sample in data/shop/<pr>/blast.json by scripts/record-shop-blast.mjs.
// This file only does the maths on that record. It never calls a model and never adds a link.
//
// THE TRUST LABEL RULE (keep it this simple):
//   The tab works at file level, so the label does too.
//   Look only at product code: code files that are not unit tests and not docs.
//   Look at each such file the real change touches.
//   1. If one of them was touched by NO agent        -> "Touches code no agent touched"
//   2. Else if one was touched ONLY by the wide agent -> "Touches more than needed"
//   3. Else                                           -> "Inside the expected zone"
//   Docs and unit test files are listed but not scored.
//   One level down (functions) is not scored either; it is added to the line as a note.
import fs from "node:fs";
import path from "node:path";
import { conceptOf } from "./ledger.mjs";
import { loadTietoSlice, memberEnd } from "./graphify-tieto.mjs";
import { blockEnd } from "./graphify.mjs";
import { indexerLabel, isEntire, loadIndex } from "./index-provider.mjs";
import { DATA, ROOT } from "./paths.mjs";

export const AGENTS = ["minimal", "normal", "wide"];
export const RUN_LABEL = { real: "The real change", minimal: "Careful agent", normal: "Normal agent", wide: "Agent that changes too much" };
export const LABELS = {
  outside: "Touches code no agent touched",
  wide: "Touches more than needed",
  inside: "Inside the expected zone",
};

// ---------- reading C# (used by scripts/record-blast.mjs) ----------
const NOT_A_START = /^(if|else|for|foreach|while|switch|return|using|lock|catch|throw|await|yield|do|try|case|var|namespace|class|struct|record|interface|enum|delegate|when|where|fixed|checked|unchecked|goto|base|this)\b/;
const NOT_A_TYPE = new Set(["return", "await", "new", "throw", "yield", "else", "in", "is", "as", "out", "case", "typeof", "nameof", "and", "or", "not"]);
const SIGNATURE = /^((?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial|unsafe|extern|new|readonly|ref|file)\s+)*)((?:[\w.?]+(?:<[^()]*>)?(?:\[,*\])*\??|\([^()]*\))\s+)?([A-Za-z_]\w*)\s*(?:<[^()>]*>)?\s*\(/;

/** The function name if this C# line is a function header, else null. */
function csHeader(line) {
  if (NOT_A_START.test(line)) return null;
  const m = SIGNATURE.exec(line);
  if (!m) return null;
  const [, mods, type, name] = m;
  if (!type && !mods) return null; // a call, not a header
  if (type && NOT_A_TYPE.has(type.trim())) return null;
  return name;
}
// TypeScript (the shop sample): `function` declarations only, exported or not.
const TS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/;

/**
 * The functions (methods and constructors) in a C# file, with their line range.
 * A simple reader of the text, not a compiler: it looks for lines shaped like a function header.
 * Functions inside functions are counted as part of the outer one.
 * `key` is the name, plus "~2", "~3" for the 2nd, 3rd function with the same name in the file.
 * With lang "ts" it reads TypeScript `function` declarations instead, ended by brace matching
 * as the shop's code index does (blockEnd in graphify.mjs).
 */
export function scanFunctions(text, lang = "cs") {
  const lines = text.split("\n");
  const out = [];
  const seen = new Map();
  let until = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 <= until) continue;
    const line = lines[i].trim().replace(/^(\[[^\]]*\]\s*)+/, "");
    if (!line || line.startsWith("//")) continue;
    const name = lang === "ts" ? (TS_FUNCTION.exec(line)?.[1] ?? null) : csHeader(line);
    if (!name) continue;
    const end = lang === "ts" ? blockEnd(lines, i + 1) : memberEnd(lines, i + 1, null);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.push({ key: n > 1 ? `${name}~${n}` : name, name, line: i + 1, endLine: end });
    until = end;
  }
  return out;
}

/** Per changed line of a diff: an added line has its line number in the new file, a removed line its number in the old file. */
export function patchLines(patch) {
  const out = [];
  let n = 0, old = 0, on = false;
  for (const raw of patch.split("\n")) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (head) {
      old = Number(head[1]);
      n = Number(head[2]);
      on = true;
    } else if (!on || raw.startsWith("\\")) continue;
    else if (raw[0] === "+") out.push({ t: "add", at: n++ });
    else if (raw[0] === "-") out.push({ t: "del", old: old++ });
    else {
      n++;
      old++;
    }
  }
  return out;
}

export const fileKind = (file) =>
  /\.md$|^doc\//i.test(file) ? "doc" : /(^|\/)tests?\/|\.Tests\//i.test(file) ? "test" : /\.(cs|ts)$/i.test(file) ? "code" : "other";

/** One changed file: numbers, patch, and the functions the changed lines sit in. */
export function fileRecord(file, status, patch, headText, baseText) {
  const kind = fileKind(file);
  const lines = patchLines(patch);
  const rec = { file, status, kind, added: lines.filter((l) => l.t === "add").length, removed: lines.filter((l) => l.t === "del").length, patch, functions: [] };
  const lang = /\.cs$/i.test(file) ? "cs" : /\.ts$/i.test(file) ? "ts" : null;
  if (!lang) return rec;
  // An added line belongs to the function it sits in after the change.
  // A removed line belongs to the function it sat in before the change.
  const before = new Map((baseText === null ? [] : scanFunctions(baseText, lang)).map((f) => [f.key, f]));
  const after = headText === null ? [] : scanFunctions(headText, lang);
  const within = (f, n) => Boolean(f) && n >= f.line && n <= f.endLine;
  for (const f of after) {
    const was = before.get(f.key);
    const added = lines.filter((l) => l.t === "add" && within(f, l.at)).length;
    const removed = lines.filter((l) => l.t === "del" && within(was, l.old)).length;
    if (added + removed) rec.functions.push({ key: f.key, name: f.name, line: f.line, endLine: f.endLine, isNew: !was, added, removed });
  }
  // A function that the change deleted whole.
  for (const was of before.values()) {
    if (after.some((f) => f.key === was.key)) continue;
    const removed = lines.filter((l) => l.t === "del" && within(was, l.old)).length;
    if (removed) rec.functions.push({ key: was.key, name: was.name, line: null, endLine: null, isNew: false, deleted: true, added: 0, removed });
  }
  const inside = rec.functions.reduce((s, f) => s + f.added + f.removed, 0);
  rec.linesOutsideFunctions = rec.added + rec.removed - inside;
  return rec;
}

// ---------- the maths ----------
/** Where a PR's recorded runs live: data/shop/<pr> for the shop sample, data/tieto/<pr> for the demo's PRs. */
export const recordDir = (prId) => [path.join(DATA, "shop", prId), path.join(DATA, "tieto", prId)].find((d) => fs.existsSync(d)) ?? path.join(DATA, "tieto", prId);
const isShop = (prId) => recordDir(prId) === path.join(DATA, "shop", prId);
const file = (prId) => path.join(recordDir(prId), "blast.json");
export const hasBlast = (prId) => fs.existsSync(file(prId));

/** Code areas: the demo's declared concepts, or for the shop the team's folder labels (config/concepts.json). */
function conceptsFor(prId) {
  if (!isShop(prId)) return JSON.parse(fs.readFileSync(path.join(DATA, "tieto", "concepts.json"), "utf8")).concepts;
  const groups = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "concepts.json"), "utf8")).groups;
  return Object.entries(groups).map(([folder, name]) => ({ id: folder, name, patterns: [`${folder}/**`] }));
}

/**
 * Unit tests run both ways, recorded by scripts/blast-tests.mjs on a machine with a .NET SDK, or null.
 * `onlyReal` lists the unit tests of the real change that every agent's fix fails: they check
 * something only the real change does, so a named person decides whether it was asked for.
 */
function recordedTests(prId) {
  const testsFile = path.join(recordDir(prId), "blast-tests.json");
  if (!fs.existsSync(testsFile)) return null;
  const rec = JSON.parse(fs.readFileSync(testsFile, "utf8"));
  const onFixes = rec.runs.filter((r) => r.ran && r.tests === "real" && r.on !== "base");
  const onlyReal = onFixes.length ? onFixes[0].failed.filter((f) => onFixes.every((r) => r.failed.some((x) => x.name === f.name))) : [];
  return { recordedAt: rec.recordedAt, sdk: rec.sdk, how: rec.how, runs: rec.runs, onlyReal };
}
const fnId = (f, key) => `${f}#${key}`;
const tail = (f) => f.split("/").pop();

/** Who calls what, from the two recorded graphs (for the shop: its saved code index). Keys are "file#functionKey". */
function callGraph(prId, headSha, baseSha) {
  const callers = new Map(); // callee id -> Map(caller id -> { file, name, sources:Set })
  const known = new Set(); // functions the graphs can speak about
  const add = (to, from, source) => {
    if (to === from) return;
    const m = callers.get(to) ?? callers.set(to, new Map()).get(to);
    const c = m.get(from) ?? m.set(from, { id: from, file: from.split("#")[0], name: from.split("#")[1].split("~")[0], sources: new Set() }).get(from);
    c.sources.add(source);
  };
  if (isShop(prId)) {
    // The shop's own code index at the base commit (the code every agent started from). Its IDs are "fn:file#name".
    const index = loadIndex(baseSha);
    if (!index) return { callers, known, tool: null };
    const tool = indexerLabel(index);
    const id = (symbolId) => symbolId.replace(/^fn:/, "");
    for (const s of index.symbols) if (s.kind === "function") known.add(id(s.id));
    for (const c of index.calls) add(id(c.to), id(c.from), isEntire(index) ? `${tool}, extracted live for the shop's base commit` : `${tool}, the shop's saved code index`);
    return { callers, known, tool };
  }
  // 1. The saved Graphify run. It holds every function in the files the real change edits, and every caller one step out.
  const slice = loadTietoSlice(headSha);
  const tool = slice ? `Graphify ${slice.graphifyVersion}` : null;
  if (slice) {
    const seed = new Set(slice.slice.seedFiles);
    const ids = new Map();
    const count = new Map();
    const fns = slice.graph.nodes
      .filter((n) => n.source_file && n.file_type === "code" && /\(\)$/.test(n.label ?? ""))
      .map((n) => ({ n, line: Number(String(n.source_location ?? "L0").slice(1)) }))
      .sort((a, b) => a.n.source_file.localeCompare(b.n.source_file) || a.line - b.line);
    for (const f of fns) {
      const name = f.n.label.replace(/\(\)$/, "").split(".").pop();
      const k = `${f.n.source_file}#${name}`;
      const nth = (count.get(k) ?? 0) + 1;
      count.set(k, nth);
      f.id = nth > 1 ? `${k}~${nth}` : k;
      f.end = slice.adapter.endLines[f.n.id] ?? f.line;
      ids.set(f.n.id, f);
      if (seed.has(f.n.source_file)) known.add(f.id);
    }
    for (const e of slice.graph.links) {
      if (e.relation !== "calls") continue;
      let a = ids.get(e.source), b = ids.get(e.target);
      if (!a || !b || a === b) continue;
      // The export has no direction. The line of the call says who the caller is.
      const site = Number(String(e.source_location ?? "L0").slice(1));
      const holds = (f) => f.n.source_file === e.source_file && site >= f.line && site <= f.end;
      if (!holds(a) && holds(b)) [a, b] = [b, a];
      add(b.id, a.id, tool);
    }
  }
  // 2. The recorded compiler data for this PR (pack.json): calls only, between the functions it lists.
  const packFile = path.join(DATA, "tieto", prId, "pack.json");
  if (fs.existsSync(packFile)) {
    const map = JSON.parse(fs.readFileSync(packFile, "utf8")).map;
    const byFile = new Map();
    for (const n of map.nodes.filter((x) => x.id.startsWith("M:"))) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
    const idOf = new Map();
    for (const [f, nodes] of byFile) {
      // Same naming as scanFunctions. The pack only lists some functions, so "~2" cannot be worked out: match by name.
      for (const n of nodes) idOf.set(n.id, fnId(f, n.label));
    }
    for (const e of map.edges.filter((x) => x.kind === "calls")) {
      const from = idOf.get(e.from), to = idOf.get(e.to);
      if (from && to) add(to, from, "recorded compiler data (Roslyn)");
    }
    for (const id of idOf.values()) known.add(id);
  }
  return { callers, known, tool };
}

function summarise(run) {
  const files = run.files ?? [];
  const fns = files.flatMap((f) => (f.functions ?? []).map((x) => ({ ...x, file: f.file, kind: f.kind, id: fnId(f.file, x.key) })));
  return {
    files,
    fns,
    codeFns: fns.filter((x) => x.kind === "code"),
    testFns: fns.filter((x) => x.kind === "test"),
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
  };
}

/** Everything the "Blast radius" tab shows for one PR, or { recorded: false }. */
export function buildBlast(prId) {
  if (!hasBlast(prId)) return { pr: prId, recorded: false, message: "Blast radius was not run for this pull request, so there is nothing to compare it with." };
  const rec = JSON.parse(fs.readFileSync(file(prId), "utf8"));
  const concepts = conceptsFor(prId);
  const graph = callGraph(prId, rec.real.head, rec.base);
  const order = ["real", ...AGENTS];
  const runs = { real: rec.real, ...Object.fromEntries(rec.runs.map((r) => [r.id, r])) };
  const sum = Object.fromEntries(order.map((id) => [id, summarise(runs[id])]));
  const conceptName = (f) => conceptOf(f, concepts).label;

  // ---- per run: size and reach ----
  const cols = {};
  for (const id of order) {
    const s = sum[id];
    const edited = new Set(s.codeFns.map((x) => x.id));
    const old = s.codeFns.filter((x) => !x.isNew);
    const callers = new Map();
    const unknown = [];
    for (const f of old) {
      if (!graph.known.has(f.id)) {
        unknown.push({ id: f.id, name: f.name, file: f.file });
        continue;
      }
      for (const c of graph.callers.get(f.id)?.values() ?? []) {
        if (edited.has(c.id)) continue;
        const row = callers.get(c.id) ?? callers.set(c.id, { id: c.id, name: c.name, file: c.file, calls: [], sources: new Set() }).get(c.id);
        row.calls.push(f.name);
        for (const src of c.sources) row.sources.add(src);
      }
    }
    const reach = [...callers.values()].map((c) => ({ ...c, sources: [...c.sources] })).sort((a, b) => a.name.localeCompare(b.name));
    cols[id] = {
      id,
      label: RUN_LABEL[id],
      ok: id === "real" ? true : runs[id].exitCode === 0,
      noChange: s.files.length === 0,
      files: s.files.length,
      added: s.added,
      removed: s.removed,
      functions: s.codeFns.length,
      newFunctions: s.codeFns.filter((x) => x.isNew).length,
      testFunctions: s.testFns.length,
      reach: { callers: reach, known: old.length - unknown.length, of: old.length, unknown },
      conceptsEdited: [...new Set(s.files.map((f) => conceptName(f.file)))],
      conceptsReached: [...new Set(reach.map((c) => conceptName(c.file)))].filter((c) => !s.files.some((f) => conceptName(f.file) === c)),
    };
  }

  // ---- overlap with the real change ----
  const realFiles = new Set(sum.real.files.map((f) => f.file));
  const realFns = new Set(sum.real.codeFns.filter((x) => !x.isNew).map((x) => x.id));
  const touchedBy = (thing, isFile) => AGENTS.filter((a) => (isFile ? sum[a].files.some((f) => f.file === thing) : sum[a].codeFns.some((x) => x.id === thing)));
  const nameOf = (thing) => (thing.includes("#") ? `${thing.split("#")[1].split("~")[0]}()` : tail(thing));
  for (const a of AGENTS) {
    cols[a].sharedFiles = sum[a].files.filter((f) => realFiles.has(f.file)).map((f) => f.file);
    cols[a].sharedFunctions = sum[a].codeFns.filter((x) => realFns.has(x.id)).map((x) => x.id);
  }
  const things = (id) => [...sum[id].files.map((f) => ({ id: f.file, kind: f.kind, isFile: true })), ...sum[id].codeFns.filter((x) => !x.isNew).map((x) => ({ id: x.id, kind: "code", isFile: false }))];
  const realOnly = things("real").filter((t) => touchedBy(t.id, t.isFile).length === 0).map((t) => ({ ...t, label: nameOf(t.id) }));
  const ran = AGENTS.filter((a) => !cols[a].noChange);
  const allAgents = ran.length
    ? things(ran[0]).filter((t) => ran.every((a) => things(a).some((x) => x.id === t.id)))
    : [];
  const agentsNotReal = allAgents.filter((t) => !(t.isFile ? realFiles.has(t.id) : realFns.has(t.id))).map((t) => ({ ...t, label: nameOf(t.id) }));

  // ---- the trust label (rule at the top of this file) ----
  const scored = things("real").filter((t) => t.kind === "code" && t.isFile);
  const outside = scored.filter((t) => touchedBy(t.id, true).length === 0);
  const wideOnly = scored.filter((t) => touchedBy(t.id, true).join() === "wide");
  const names = (list) => list.map((t) => nameOf(t.id)).join(", ");
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const docs = realOnly.filter((t) => t.kind === "doc").length, tests = realOnly.filter((t) => t.kind === "test").length;
  const fnsOutside = realOnly.filter((t) => !t.isFile);
  const extra =
    (docs + tests ? ` Not scored: ${[docs ? count(docs, "doc") : "", tests ? count(tests, "unit test file") : ""].filter(Boolean).join(" and ")} that no agent touched.` : "") +
    (fnsOutside.length ? ` One level down, it edits ${count(fnsOutside.length, "function")} that no agent edited: ${names(fnsOutside)}.` : "");
  const what = `The real change touches ${count(scored.length, "product code file")}`;
  let label;
  if (!ran.length) label = { key: "none", text: "No label", tone: "plain", how: "No agent made a change, so there is no zone to compare with." };
  else if (outside.length) label = { key: "outside", text: LABELS.outside, tone: "bad", how: `${what}. No agent touched: ${names(outside)}.${extra}` };
  else if (wideOnly.length) label = { key: "wide", text: LABELS.wide, tone: "warn", how: `${what}. Only the agent that changes too much also touched: ${names(wideOnly)}.${extra}` };
  else if (!scored.length) label = { key: "inside", text: LABELS.inside, tone: "ok", how: `The real change touches no product code files, only docs or unit tests, so none of it can sit outside the agents' zone.${extra}` };
  else label = { key: "inside", text: LABELS.inside, tone: "ok", how: `${what}. The careful agent or the normal agent touched ${scored.length === 1 ? "it" : "all of them"} too.${extra}` };

  // ---- the boxes for the picture ----
  const zoneOf = (by) => (by.minimal ? "tight" : by.normal ? "normal" : by.wide ? "wide" : "outside");
  const box = (level, id, label, sub, kind, by, more = {}) => ({ id: `blast:${level}:${id}`, level, key: id, label, sub, kind, by, zone: zoneOf(by), agents: AGENTS.filter((a) => by[a]).length, ...more });
  const items = [];
  const allFiles = [...new Set(order.flatMap((id) => sum[id].files.map((f) => f.file)))];
  for (const f of allFiles) {
    const by = Object.fromEntries(order.map((id) => [id, sum[id].files.some((x) => x.file === f)]));
    items.push(box("file", f, tail(f), f, fileKind(f), by));
  }
  const allFns = new Map();
  for (const id of order) for (const x of sum[id].fns) {
    // A new function belongs to the run that wrote it. Two runs can pick the same name by chance; they are still two functions.
    const key = x.isNew ? `${x.id}@${id}` : x.id;
    const row = allFns.get(key) ?? allFns.set(key, { fn: x, by: {} }).get(key);
    row.by[id] = true;
  }
  for (const [key, { fn, by }] of allFns) {
    const full = Object.fromEntries(order.map((id) => [id, Boolean(by[id])]));
    items.push(box("function", key, `${fn.name}()`, tail(fn.file), fn.kind, full, { file: fn.file, fnKey: fn.key, isNew: Boolean(fn.isNew) }));
  }
  const allConcepts = [...new Set(allFiles.map(conceptName))];
  for (const c of allConcepts) {
    const by = Object.fromEntries(order.map((id) => [id, sum[id].files.some((x) => conceptName(x.file) === c)]));
    const files = allFiles.filter((f) => conceptName(f) === c);
    items.push(box("concept", c, c, `${files.length} file${files.length === 1 ? "" : "s"} touched`, files.every((f) => fileKind(f) === "doc") ? "doc" : files.every((f) => fileKind(f) === "test") ? "test" : "code", by, { files }));
  }

  return {
    pr: prId,
    recorded: true,
    recordedAt: rec.recordedAt,
    model: rec.model,
    base: rec.base,
    how: rec.how,
    notBuilt: rec.notBuilt,
    tests: recordedTests(prId),
    given: rec.given,
    graphTool: graph.tool,
    order,
    columns: order.map((id) => cols[id]),
    overlap: { realFiles: realFiles.size, realFunctions: realFns.size, realOnly, agentsNotReal, agentsCompared: ran },
    label,
    items,
    runs: order.map((id) => ({
      id,
      label: RUN_LABEL[id],
      prompt: runs[id].prompt ?? null,
      instruction: runs[id].instruction ?? null,
      reply: runs[id].reply ?? null,
      startedAt: runs[id].startedAt ?? null,
      endedAt: runs[id].endedAt ?? null,
      exitCode: runs[id].exitCode ?? null,
      toolCalls: runs[id].toolCalls ?? null,
      files: runs[id].files,
    })),
  };
}
