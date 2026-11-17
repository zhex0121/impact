import fs from "node:fs";
import path from "node:path";
import { authorOf, changedFiles as gitChangedFiles, changedLineRanges, readFileAt, unifiedDiff } from "./git.mjs";
import { indexerLabel, isEntire, loadIndex } from "./index-provider.mjs";
import { graphifyGraph, loadBaseLinks } from "./graphify-tieto.mjs";
import { mapTests, TEST_MAPPER_LABEL } from "./testmap.mjs";
import { loadBaseRun, loadRun } from "./runner.mjs";
import { buildLedgerModel, ledgerPrs } from "./ledger.mjs";
import { classifier1, classifier2, loadApprovedPolicy } from "./classifier.mjs";
import { CLAIM_VERIFIER_LABEL, contestClaims, verifyClaims } from "./claims.mjs";
import { buildReviewInput, finalizeReview, loadReview } from "./reviewer.mjs";
import { loadEditCheck } from "./edit-check.mjs";
import { BRIEFS, DATA, REVISIONS_FILE, ROOT } from "./paths.mjs";

const short = (sha) => (sha ?? "").slice(0, 7);
/** Map nodes that stand for code in a file (not the PR, the requirement or an area). */
const CODE_NODE_TYPES = new Set(["function", "test", "file", "testfile"]);
const concepts = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "concepts.json"), "utf8")).groups;

/** All pull requests the map can show: the shop sample, built and analysed here. */
export function loadRevisions() {
  const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
  const shop = revisions.prs.map((p) => ({ ...p, repo: revisions.github.fullName, source: "shop" }));
  return { ...revisions, prs: shop };
}

/**
 * The shop PRs in the order the demo shows them, plainest first: the trap (Order Import untested),
 * a docs change that merges by itself, a clean fix, a judge's attack, an edit no test needs,
 * and a change that loosens its own review rules. Their numbers follow this order (sample/manifest.json).
 */
const SHOWCASE = ["req-17", "docs-example", "req-22", "req-21", "ledger-note", "policy-self-patch"];

/** The pull requests the demo shows: the shop showcase first, then the Tieto example PRs (facts from recorded packs in data/tieto/). */
export function demoRevisions() {
  const revisions = loadRevisions();
  const shop = SHOWCASE.map((id) => revisions.prs.find((p) => p.id === id));
  const tieto = ledgerPrs().map((p) => {
    // Extra commits are made up for the demo, so the map can be stepped from commit to commit.
    const extra = (loadSemantic(p.id)?.commits ?? []).map((c, i) => ({ sha: c.sha, index: i + 2, label: `commit ${i + 2}`, message: c.message, madeUp: true }));
    return { ...p, source: "tieto", commits: [{ sha: p.commits[0].commitSha, index: 1, label: "commit 1", message: p.title }, ...extra] };
  });
  return { ...revisions, prs: [...shop, ...tieto] };
}

function loadSemantic(prId) {
  const file = path.join(BRIEFS, "semantic", `${prId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** One Tieto PR in the plain shape the UI needs: no row numbers, no evidence stages. */
function buildTietoModel(pr, sha) {
  const commit = pr.commits.find((c) => c.sha === sha);
  if (!commit) throw new Error(`commit ${sha} is not part of PR ${pr.id}`);
  const recorded = ledgerPrs().find((p) => p.id === pr.id);
  const m = buildLedgerModel(recorded, recorded.commits.at(-1).sha);
  const saved = loadSemantic(pr.id) ?? {};
  // A made-up commit changes the recorded facts through hand-written overrides.
  const o = commit.index > 1 ? (saved.revisions?.[String(commit.index)]?.model ?? {}) : null;
  const failing = (e) => (e === "contradicted" && !o?.fixed ? "contradicted" : null);
  const text = (list) => (list ?? []).map((t) => ({ type: "text", text: t }));
  // The map is drawn from a saved Graphify run on commit 1's code. Without one, the recorded graph is used.
  const gfy = graphifyGraph(m, pr.commits[0].sha);
  const graph = gfy ?? m.graph;
  return {
    source: "tieto",
    pr,
    base: m.base,
    selected: { sha, short: short(sha), isBase: false, index: commit.index, message: commit.message, madeUp: Boolean(commit.madeUp) },
    graph: {
      nodes: graph.nodes.map(({ rowIds, ...n }) => ({ ...n, evidence: failing(n.evidence), sub: n.type === "pr" ? `commit ${short(sha)}` : n.type === "requirement" ? "GitHub issue" : n.sub })),
      edges: graph.edges,
    },
    graphify: gfy?.info ?? null,
    tests: [],
    run: null,
    checks: m.checks.map((c) => ({
      ...c,
      label: "Unit tests",
      name: "dotnet test",
      by: o ? "Made-up result for the demo commit" : "Recorded run on this commit · not CI",
      counts: o?.unitTests ? { passed: o.unitTests, total: o.unitTests, failed: 0 } : c.counts,
    })),
    impact: { ...m.impact, unverified: [] },
    policy: m.policy,
    requirementText: m.requirementText,
    // One entry per path: a file the made-up commit edits again keeps its real diff; its made-up change is in `since`.
    diff: { files: [...m.diff.files, ...(o?.files ?? []).filter((f) => !m.diff.files.some((x) => x.file === f.file)).map((f) => ({ ...f, madeUp: true }))] },
    since: o ? { from: commit.index - 1, items: o.since ?? [], files: o.files ?? [] } : null,
    evidence: o?.fixed ? [] : m.evidence.filter((e) => e.status === "contradicted").map(({ rowIds, ...e }) => ({ ...e, statusLabel: "A targeted unit test fails here", missing: null })),
    brief: null,
    claims: [],
    description: loadDescription(pr, m.brief, commit),
    classifier1: { ...m.classifier1, kind: "deterministic rules", reason: saved.verdict?.classifier1 ?? m.classifier1.reason },
    classifier2: {
      ...m.classifier2,
      kind: "deterministic rules",
      severity: o?.severity ?? m.classifier2.severity,
      route: o?.route ?? m.classifier2.route,
      rule: o?.rule ?? m.classifier2.rule,
      reason: o?.reason ?? saved.verdict?.reason ?? m.classifier2.reason,
      blockers: text(o ? o.blockers : saved.verdict?.blockers),
      notes: (o ? (o.notes ?? []) : (saved.verdict?.notes ?? [])).map((t) => ({ text: t })),
    },
    review: {
      ...m.review,
      summary: o?.reviewSummary ?? saved.reviewSummary ?? "",
      // The recorded review is dense. The demo shows a hand-written plain-words version of each item.
      findings: m.review.findings
        .filter((f) => !(o?.dropFindings ?? []).some((t) => f.title.includes(t)))
        .map((f) => {
          const plain = (saved.plainReview?.findings ?? []).find((x) => f.title.includes(x.match));
          // `fix` is the one-line "what to do about it", shown under the problem in the chat.
          return plain ? { ...f, title: plain.title, detail: plain.detail, fix: plain.fix ?? null } : f;
        }),
      couldNotDecide: m.review.couldNotDecide.map((q, i) => {
        const plain = saved.plainReview?.questions?.[i];
        return plain ? { ...q, question: plain.question, checkThatWouldHelp: plain.help } : q;
      }),
      modeLabel: o ? "Made-up review result for the demo commit" : m.review.modeLabel.replace(" from the Impact Ledger pack", "").replace(/\)\..*$/, ")") + ", rewritten in plain words for the demo",
    },
    reviewInput: null,
    agent: saved.agent ?? null,
  };
}

/** A small glob matcher for the concept patterns ("**", "*"). */
function globToRegex(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${body}$`);
}

/**
 * The whole repository as one map, at three levels, with every commit of every
 * PR laid over it.
 *  - Concepts: the team's named areas, plus the rest of the repo by top folder.
 *    Counts come from a saved snapshot of the whole repo (scripts/snapshot-fullmap.mjs).
 *  - Files and Functions: every file and function that any demo PR edits or reaches.
 *    The rest of the repo is not indexed at these levels.
 */
export function buildFullMap(revisions) {
  const snap = JSON.parse(fs.readFileSync(path.join(DATA, "tieto", "fullmap.json"), "utf8"));
  const declared = JSON.parse(fs.readFileSync(path.join(DATA, "tieto", "concepts.json"), "utf8")).concepts;
  const ordered = [...declared]
    .sort((a, b) => Math.max(...b.patterns.map((p) => p.length)) - Math.max(...a.patterns.map((p) => p.length)))
    .map((c) => ({ ...c, regexes: c.patterns.map(globToRegex) }));
  const AREA = { src: "Core library and other packages", sandbox: "Sandbox projects", benchmark: "Benchmarks" };
  const areaOf = (file) => {
    const hit = ordered.find((c) => c.regexes.some((r) => r.test(file)));
    if (hit) return { id: `concept:${hit.id}`, label: hit.name, sub: hit.patterns[0] };
    const top = file.split("/")[0];
    return AREA[top] ? { id: `area:${top}`, label: AREA[top], sub: `${top}/**` } : { id: "area:repo", label: "Repo tooling and config", sub: "everything else" };
  };
  const projectDirs = snap.projects.map((p) => p.id).sort((a, b) => b.length - a.length);
  const projectOf = (file) => projectDirs.find((d) => file.startsWith(d + "/")) ?? null;

  // Concept level: every file in the snapshot belongs to one area.
  const areas = new Map();
  const areaProjects = new Map();
  for (const file of snap.files) {
    const a = areaOf(file);
    const node = areas.get(a.id) ?? areas.set(a.id, { ...a, level: "concept", type: "concept", files: 0 }).get(a.id);
    node.files += 1;
    const proj = projectOf(file);
    if (proj) (areaProjects.get(a.id) ?? areaProjects.set(a.id, new Set()).get(a.id)).add(proj);
  }
  for (const n of areas.values()) n.sub = `${n.files} files · ${n.sub}`;

  // File and function levels: the union of what the demo PRs edit or reach.
  const files = new Map();
  const functions = new Map();
  const calls = new Map();
  const commits = [];
  for (const pr of revisions.prs) {
    for (const c of pr.commits) {
      const m = buildModel(revisions, pr.id, c.sha);
      const changed = (m.since ? m.since.files : m.diff.files).map((f) => f.file);
      const edited = { concept: new Set(changed.map((f) => areaOf(f).id)), file: new Set(), function: new Set() };
      const affected = { concept: new Set(), file: new Set(), function: new Set() };
      // A made-up commit that only touches tests reaches nothing else.
      const reaches = !m.since || changed.some((f) => m.graph.nodes.some((n) => n.type === "file" && n.file === f));
      for (const n of reaches ? m.graph.nodes : []) {
        if (n.type === "file" && n.level === "file") {
          files.set(n.id, { id: n.id, level: "file", type: "file", label: n.label, sub: n.sub, file: n.file });
          if (changed.includes(n.file)) edited.file.add(n.id);
          else if (n.state !== "none") affected.file.add(n.id);
        }
        if (n.type === "function") {
          functions.set(n.id, { id: n.id, level: "function", type: "function", label: n.label, sub: n.sub, file: n.file });
          if (n.state === "edited" && changed.includes(n.file)) edited.function.add(n.id);
          else if (n.state !== "none") affected.function.add(n.id);
          if (n.state !== "none" && !edited.concept.has(areaOf(n.file).id)) affected.concept.add(areaOf(n.file).id);
        }
      }
      for (const e of m.graph.edges) {
        if (e.level !== "function" || e.kind !== "calls") continue;
        const key = `${e.from}>${e.to}`;
        calls.set(key, { from: e.from, to: e.to, resolution: e.resolution === "inferred" && calls.get(key)?.resolution !== "resolved" ? "inferred" : "resolved" });
      }
      const list = (sets) => Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v]]));
      commits.push({ sha: c.sha, short: short(c.sha), pr: pr.id, prNumber: pr.number, title: pr.title, index: c.index, message: c.message, madeUp: Boolean(c.madeUp), fileCount: changed.length, edited: list(edited), affected: list(affected) });
    }
  }

  // Links. Functions: calls. Files and concepts: the same calls, rolled up.
  const edge = (level, from, to, resolution = "resolved") => ({ id: `${from}>${to}`, level, from, to, kind: "calls", resolution });
  // A rolled-up link is "inferred" only when every link under it is.
  const merge = (seen, level, from, to, resolution) => {
    const key = `${from}>${to}`;
    if (from !== to && !(seen.get(key)?.resolution === "resolved")) seen.set(key, edge(level, from, to, resolution));
  };
  const rollUp = (level, keyOf) => {
    const seen = new Map();
    for (const c of calls.values()) {
      const a = functions.get(c.from), b = functions.get(c.to);
      if (!a || !b) continue;
      const from = keyOf(a.file), to = keyOf(b.file);
      merge(seen, level, from, to, c.resolution);
    }
    return seen;
  };
  const conceptEdges = rollUp("concept", (file) => areaOf(file).id);
  // Concept level, whole repo: Graphify's call links at the base commit, rolled up from files to areas.
  const baseLinks = loadBaseLinks();
  for (const l of baseLinks?.fileLinks ?? []) merge(conceptEdges, "concept", areaOf(l.from).id, areaOf(l.to).id, l.extracted ? "resolved" : "inferred");
  // Concept level also gets project dependencies from the snapshot (.csproj references).
  const refs = new Map(snap.projects.map((p) => [p.id, p.references]));
  for (const [from, fromProjects] of areaProjects) {
    for (const [to, toProjects] of areaProjects) {
      // Docs and build files are file types, not code areas: no dependency links for them.
      if (from === to || conceptEdges.has(`${from}>${to}`) || conceptEdges.has(`${to}>${from}`) || [from, to].some((x) => x === "concept:docs" || x === "concept:build-config")) continue;
      if ([...fromProjects].some((p) => (refs.get(p) ?? []).some((r) => toProjects.has(r) && !fromProjects.has(r)))) conceptEdges.set(`${from}>${to}`, edge("concept", from, to));
    }
  }
  const fileEdges = rollUp("file", (file) => `file:${file}`);
  for (const key of [...fileEdges.keys()]) if (!files.has(fileEdges.get(key).from) || !files.has(fileEdges.get(key).to)) fileEdges.delete(key);

  return {
    note: snap.note,
    repo: snap.repo,
    commit: snap.commit,
    takenAt: snap.takenAt,
    totals: snap.totals,
    commits,
    levels: {
      concept: { nodes: [...areas.values()], edges: [...conceptEdges.values()] },
      file: { nodes: [...files.values()], edges: [...fileEdges.values()] },
      function: { nodes: [...functions.values()], edges: [...calls.values()].filter((c) => functions.has(c.from) && functions.has(c.to)).map((c) => edge("function", c.from, c.to, c.resolution)) },
    },
    graphify: baseLinks ? { tool: `Graphify ${baseLinks.graphifyVersion}`, revision: baseLinks.revision, full: baseLinks.full } : null,
  };
}

function loadPlanted(prId, sha) {
  const file = path.join(DATA, "planted", `${prId}.json`);
  if (!fs.existsSync(file)) return null;
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const here = all.commits.find((c) => c.sha === sha);
  return here ? { kind: "planted-faults", ranAt: all.ranAt, ...here } : null;
}
/**
 * The two PR descriptions the UI can switch between: the one the author wrote,
 * and a semantic one written by an AI (saved in briefs/semantic/<pr-id>.json).
 */
function loadDescription(pr, brief, commit) {
  const saved = loadSemantic(pr.id);
  const ai = commit ? saved?.revisions?.[String(commit.index)] : null;
  return {
    author: saved?.author ?? { by: brief?.author ?? "Author", text: [brief?.why, brief?.approach].filter(Boolean).join("\n\n") || commit?.message || "" },
    ai: ai ? { generatedBy: saved.generatedBy, ...ai } : null,
  };
}
/** A rollback is recorded only when the brief says how, in words. A blank or "none" is not a rollback. */
const hasRollback = (text) => typeof text === "string" && text.trim().length > 0 && !/^((none|nothing|nil|null|n\/?a|no|false|todo|tbd)[.!]*|no rollback\b.*|not possible\b.*|[-\u2013\u2014.?]+)$/i.test(text.trim());

export function loadBrief(prId) {
  const file = path.join(BRIEFS, `${prId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** The coding agent's saved answers for the chat, for the one commit they were written for (shop sample). */
function loadChat(prId, sha) {
  const file = path.join(BRIEFS, "chat", `${prId}.json`);
  if (!fs.existsSync(file)) return null;
  const chat = JSON.parse(fs.readFileSync(file, "utf8"));
  return chat.commit === sha ? chat : null;
}

/** The app's saved answers about itself, offered in the chat on every PR. */
export function loadAbout() {
  return JSON.parse(fs.readFileSync(path.join(BRIEFS, "chat", "about.json"), "utf8")).chat;
}

/** Concept mapper (rule-based): folder group, with a behaviour label when the team config has one. */
function conceptOf(file) {
  const match = Object.keys(concepts)
    .filter((prefix) => file === prefix || file.startsWith(prefix + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { id: `concept:${match}`, label: concepts[match], labelled: true, folder: match };
  const folder = file.includes("/") ? file.split("/").slice(0, -1).join("/") : "(repo root)";
  return { id: `concept:${folder}`, label: `Folder: ${folder}`, labelled: false, folder };
}

const overlaps = (ranges, start, end) => (ranges ?? []).some(([a, b]) => a <= end && b >= start);

function editedSymbolIds(index, baseIndex, ranges) {
  const ids = new Set();
  for (const s of index.symbols) if (s.kind === "function" && overlaps(ranges[s.file]?.added, s.line, s.endLine)) ids.add(s.id);
  for (const s of baseIndex.symbols) {
    if (s.kind === "function" && overlaps(ranges[s.file]?.removed, s.line, s.endLine) && index.symbols.some((x) => x.id === s.id)) ids.add(s.id);
  }
  return [...ids];
}

function downstreamOf(index, edited) {
  const callersOf = new Map();
  for (const c of index.calls) {
    if (!callersOf.has(c.to)) callersOf.set(c.to, []);
    callersOf.get(c.to).push(c.from);
  }
  const seen = new Set(edited);
  const out = [];
  const queue = [...edited];
  while (queue.length) {
    for (const caller of callersOf.get(queue.shift()) ?? []) {
      if (seen.has(caller)) continue;
      seen.add(caller);
      out.push(caller);
      queue.push(caller);
    }
  }
  return out;
}

function edgeKeys(index, tests) {
  const keys = new Set();
  for (const c of index.calls) keys.add(`calls|${c.from}|${c.to}`);
  for (const t of tests) for (const d of t.directCalls) keys.add(`tests|${t.id}|${d.to}`);
  return keys;
}

/** What the Entire Graph provider set aside or could not pin down. Listed, never dropped silently. */
function entireGaps(index) {
  const nullLines = index.calls.filter((c) => c.line === null).length;
  return [
    index.testSymbols.length ? `${index.testSymbols.length} function(s) declared inside test files and ${index.testCalls.length} call(s) from them were kept out of the map: ${index.testSymbols.map((s) => s.id.replace(/^fn:/, "")).join(", ")}.` : null,
    nullLines ? `${nullLines} of ${index.calls.length} call links have no exact call line (Entire gives a range; the line is set only when one line in it names the callee).` : null,
    index.ambiguous.length ? `${index.ambiguous.length} symbols share a name with another and carry a line suffix: ${index.ambiguous.map((a) => a.id).join(", ")}.` : null,
    "Imports are not read as named imports. Entire's file-scope calls from test files stand in for them.",
  ].filter(Boolean);
}

/**
 * Build everything the app shows for one PR at one selected revision.
 * Graph, diff, evidence, claims, route and sign-off state all come from this
 * one call, so they always match the selection.
 *
 * `opts` lets evals replay altered evidence: { run, brief, reviewRecord, decisions, policy }.
 */
export function buildModel(revisions, prId, sha, opts = {}) {
  const pr = revisions.prs.find((p) => p.id === prId);
  if (!pr) throw new Error(`unknown PR: ${prId}`);
  if (pr.source === "tieto") return buildTietoModel(pr, sha);
  const baseSha = revisions.base.sha;
  const commit = pr.commits.find((c) => c.sha === sha);
  const isBase = sha === baseSha;
  if (!isBase && !commit) throw new Error(`commit ${sha} is not part of PR ${prId}`);

  const index = loadIndex(sha);
  const baseIndex = isBase ? index : loadIndex(baseSha);
  if (!index || !baseIndex) throw new Error(`no code index saved for ${sha}. Run: npm run setup`);
  const tests = mapTests(sha, index);
  const baseTests = isBase ? tests : mapTests(baseSha, baseIndex);
  const policy = opts.policy ?? loadApprovedPolicy(baseSha);
  const brief = opts.brief ?? loadBrief(prId);
  const briefRev = (!isBase && brief?.revisions?.[String(commit.index)]) || { claims: [], openGaps: [], checksRun: [] };
  const fnLabel = (id) => (id.startsWith("test:") ? `"${id.split("#")[1]}"` : `${id.split("#")[1]}()`);

  // ---- Diff -------------------------------------------------------------
  const changed = isBase ? [] : gitChangedFiles(baseSha, sha);
  const ranges = isBase ? {} : changedLineRanges(baseSha, sha);
  const diffFiles = changed.map((f) => ({ ...f, patch: unifiedDiff(baseSha, sha, f.file) }));
  const edited = isBase ? [] : editedSymbolIds(index, baseIndex, ranges);
  const downstream = downstreamOf(index, edited);
  const symbolById = new Map(index.symbols.map((s) => [s.id, s]));

  // ---- Checks (joined by commit SHA, never by "latest") -----------------
  const run = opts.run !== undefined ? opts.run : loadRun(sha);
  const runCounts = run && run.revision === sha;
  const checks = policy.required_checks.map((name) => {
    if (!run || run.check !== name) return { name, required: true, status: "missing", resultRevision: null };
    if (run.status === "pending") return { name, required: true, status: "pending", resultRevision: run.revision };
    if (run.revision !== sha) return { name, required: true, status: "stale", resultRevision: run.revision, kind: run.kind, kindLabel: run.kindLabel };
    return { name, required: true, status: run.status, resultRevision: run.revision, kind: run.kind, kindLabel: run.kindLabel, command: run.command, counts: run.counts };
  });
  const testStatus = (testId) => (runCounts ? (run.tests.find((t) => t.id === testId)?.status ?? "not in run") : "no result for this commit");
  // Before/after: the same test run against the base code. Fails before + passes after = the change caused it.
  const baseRun = isBase ? null : loadBaseRun(sha);
  const proofOf = (testId) => {
    const before = baseRun?.tests.find((t) => t.id === testId)?.status;
    const after = testStatus(testId);
    if (!before || after !== "passed") return null;
    return before === "failed" ? "changed" : before === "passed" ? "held" : null;
  };

  // ---- Evidence per affected function -----------------------------------
  const requirement = pr.requirement;
  const needsEvidence = !isBase && requirement && policy.evidence?.require_requirement_test_per_affected_workflow;
  const affectedIds = [...edited, ...downstream];
  const evidence = !needsEvidence
    ? []
    : affectedIds.map((nodeId) => {
        const sym = symbolById.get(nodeId);
        const supportingTests = [];
        const rejected = [];
        for (const t of tests) {
          if (!t.reaches.includes(nodeId)) continue;
          const status = testStatus(t.id);
          if (!t.requirementIds.includes(requirement)) rejected.push({ testId: t.id, reason: `Reaches ${sym.name}() but does not cite ${requirement}. It checks something else.` });
          else if (!run) rejected.push({ testId: t.id, reason: "No result recorded for this commit." });
          else if (run.revision !== sha) rejected.push({ testId: t.id, reason: `The result on file is for commit ${short(run.revision)}, not this commit.` });
          else if (status !== "passed") rejected.push({ testId: t.id, reason: `Result on this commit: ${status}.` });
          else supportingTests.push(t.id);
        }
        const supported = supportingTests.length > 0;
        return {
          nodeId,
          label: `${sym.name}()`,
          file: sym.file,
          line: sym.line,
          concept: conceptOf(sym.file).label,
          role: edited.includes(nodeId) ? "edited" : "downstream",
          status: supported ? "supported" : "unverified",
          statusLabel: supported ? `Supported for the tested case` : "Unverified",
          supportingTests,
          rejected,
          missing: supported ? null : `No test that cites ${requirement} and reaches ${sym.name}() has passed on commit ${short(sha)}.`,
          suggestedCheck: supported ? null : `Add a ${requirement} test that calls ${sym.name}() for the requirement's case, and run it on this commit.`,
        };
      });
  const evidenceByNode = new Map(evidence.map((e) => [e.nodeId, e]));

  // ---- Shared graph: concepts -> files -> functions ----------------------
  const baseKeys = edgeKeys(baseIndex, baseTests);
  const currentKeys = edgeKeys(index, tests);
  const baseNodeIds = new Set([...baseIndex.symbols.map((s) => s.id), ...baseTests.map((t) => t.id)]);
  const nodes = [];
  const edges = [];
  const stateOf = (id) => (edited.includes(id) ? "edited" : downstream.includes(id) ? "downstream" : "none");

  for (const s of index.symbols.filter((x) => x.kind === "function")) {
    nodes.push({
      id: s.id, level: "function", type: "function", label: `${s.name}()`, sub: `${s.file}:${s.line}`,
      file: s.file, line: s.line, endLine: s.endLine, parent: `file:${s.file}`, concept: conceptOf(s.file).id,
      state: stateOf(s.id), evidence: evidenceByNode.get(s.id)?.status ?? null,
      change: !isBase && !baseNodeIds.has(s.id) ? "added" : null,
    });
  }
  for (const t of tests) {
    nodes.push({
      id: t.id, level: "function", type: "test", label: t.name, sub: `${t.file}:${t.line}`,
      file: t.file, line: t.line, endLine: t.endLine, parent: `file:${t.file}`, concept: conceptOf(t.file).id,
      state: "none", testStatus: testStatus(t.id), requirementIds: t.requirementIds,
      change: !isBase && !baseNodeIds.has(t.id) ? "added" : null,
    });
  }
  for (const c of index.calls) {
    edges.push({
      id: `calls|${c.from}|${c.to}`, level: "function", from: c.from, to: c.to, kind: "calls", confidence: c.confidence,
      resolution: c.confidence === "EXTRACTED" ? "resolved" : "inferred", anchor: { file: c.file, line: c.line },
      change: !isBase && !baseKeys.has(`calls|${c.from}|${c.to}`) ? "added" : null,
    });
  }
  for (const t of tests) {
    for (const d of t.directCalls) {
      edges.push({
        id: `tests|${t.id}|${d.to}`, level: "function", from: t.id, to: d.to, kind: "tests", confidence: d.confidence,
        resolution: "resolved", mapper: "rule-based test mapper", anchor: { file: d.file, line: d.line },
        change: !isBase && !baseKeys.has(`tests|${t.id}|${d.to}`) ? "added" : null,
      });
    }
  }
  const removedLinks = isBase ? [] : [...baseKeys].filter((k) => !currentKeys.has(k)).map((k) => {
    const [kind, from, to] = k.split("|");
    return { kind, from, to, text: `${fnLabel(from)} no longer ${kind === "calls" ? "calls" : "tests"} ${fnLabel(to)}` };
  });

  // Files. Changed files with no indexed symbols (docs, config) still get a node.
  const fileSet = new Set([...index.files, ...changed.map((f) => f.file).filter((f) => readFileAt(sha, f) !== null)]);
  const changedSet = new Set(changed.map((f) => f.file));
  const fnNodes = nodes.filter((n) => n.level === "function");
  const rollState = (members, selfEdited) => (selfEdited || members.some((m) => m.state === "edited") ? "edited" : members.some((m) => m.state === "downstream") ? "downstream" : "none");
  const rollEvidence = (members) => (members.some((m) => m.evidence === "unverified") ? "unverified" : members.some((m) => m.evidence === "supported") ? "supported" : null);
  const countsOf = (members) => ({
    edited: members.filter((m) => m.state === "edited").length,
    downstream: members.filter((m) => m.state === "downstream").length,
    unverified: members.filter((m) => m.evidence === "unverified").length,
  });
  for (const file of [...fileSet].sort()) {
    const members = fnNodes.filter((n) => n.file === file);
    const isTestFile = /^tests\//.test(file);
    nodes.push({
      id: `file:${file}`, level: "file", type: isTestFile ? "testfile" : "file", label: file.split("/").pop(), sub: file,
      file, line: 1, parent: conceptOf(file).id, concept: conceptOf(file).id, members: members.map((m) => m.id),
      state: isTestFile ? "none" : rollState(members, changedSet.has(file)), evidence: rollEvidence(members), counts: countsOf(members),
      fileChanged: changedSet.has(file), indexed: index.files.includes(file),
    });
    // Unindexed changed files also appear at function level, so the edit is never hidden.
    if (!index.files.includes(file)) {
      nodes.push({ id: `file:${file}`, level: "function", type: "file", label: file.split("/").pop(), sub: `${file} (no symbols indexed)`, file, line: 1, concept: conceptOf(file).id, state: "edited", evidence: null, fileChanged: true, indexed: false });
    }
  }
  const fileNodes = nodes.filter((n) => n.level === "file");
  const conceptIds = [...new Set(fileNodes.map((n) => n.concept))];
  for (const cid of conceptIds) {
    const files = fileNodes.filter((n) => n.concept === cid);
    const members = fnNodes.filter((n) => n.concept === cid);
    const info = conceptOf(files[0].file);
    nodes.push({
      id: cid, level: "concept", type: "concept", label: info.label, sub: info.labelled ? info.folder : "unlabelled folder group",
      labelled: info.labelled, members: files.map((f) => f.id),
      state: rollState(members, files.some((f) => f.fileChanged && f.type !== "testfile")), evidence: rollEvidence(members), counts: countsOf(members),
    });
  }
  // Roll function-level links up to files and concepts.
  const rollup = (level, keyOf) => {
    const grouped = new Map();
    for (const e of edges.filter((x) => x.level === "function")) {
      const a = keyOf(e.from);
      const b = keyOf(e.to);
      if (!a || !b || a === b) continue;
      const id = `${e.kind}|${a}|${b}`;
      if (!grouped.has(id)) grouped.set(id, { id, level, from: a, to: b, kind: e.kind, confidence: e.confidence, resolution: e.resolution, anchor: e.anchor, count: 0, underlying: [], change: e.change });
      const g = grouped.get(id);
      g.count++;
      g.underlying.push(e.id);
      if (!e.change) g.change = null;
      if (e.confidence !== "EXTRACTED") { g.confidence = e.confidence; g.resolution = "inferred"; }
    }
    edges.push(...grouped.values());
  };
  const fnById = new Map(fnNodes.map((n) => [n.id, n]));
  rollup("file", (id) => fnById.get(id)?.parent);
  rollup("concept", (id) => fnById.get(id)?.concept);

  // PR and requirement nodes, linked to edits and to possibly affected callers.
  if (!isBase) {
    for (const level of ["function", "file", "concept"]) {
      const levelNodes = nodes.filter((n) => n.level === level);
      nodes.push({ id: `pr:${pr.id}`, level, type: "pr", label: `PR: ${pr.title}`, sub: `commit ${commit.index} of ${pr.commits.length} · ${short(sha)}`, state: "none" });
      if (requirement) {
        nodes.push({ id: `req:${requirement}`, level, type: "requirement", label: requirement, sub: `requirements/${requirement}.md`, file: `requirements/${requirement}.md`, line: 1, state: "none" });
        edges.push({ id: `implements|${level}`, level, from: `req:${requirement}`, to: `pr:${pr.id}`, kind: "implements", confidence: "author claim", resolution: "claimed" });
      }
      for (const n of levelNodes) {
        if (n.type === "test" || n.type === "testfile") continue;
        if (n.state === "edited") edges.push({ id: `edits|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "edits", confidence: "git diff", resolution: "resolved" });
        if (n.state === "downstream") edges.push({ id: `may-affect|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "may-affect", confidence: "via call links", resolution: "inferred" });
      }
    }
  }

  // ---- Impact summary ----------------------------------------------------
  const workflows = nodes
    .filter((n) => n.level === "concept" && n.type === "concept" && (n.counts.edited || n.counts.downstream || n.state === "edited"))
    .map((n) => ({ id: n.id, label: n.label, ...n.counts, state: n.state }));
  const inferredCalls = index.calls.filter((c) => c.confidence !== "EXTRACTED").length;
  const unresolvedTargets = [...new Set(index.unresolved.map((u) => u.target))];
  const coverage = {
    indexer: isEntire(index)
      ? `${indexerLabel(index)} (schema ${index.schemaVersion}, profile ${index.profile}), no model. Extracted live for commit ${short(sha)}.`
      : `Graphify ${index.graphifyVersion} (schema ${index.schemaVersion}), code-only, no model. Export saved for commit ${short(sha)}.`,
    language: "TypeScript only. Function-level links.",
    counts: `${index.symbols.filter((s) => s.kind === "function").length} functions, ${index.calls.length} call links (${index.calls.length - inferredCalls} resolved, ${inferredCalls} inferred), ${tests.length} tests.`,
    mappers: ["Concept mapper: rule-based folder groups, labels from config/concepts.json", `Dependency mapper: ${isEntire(index) ? "Entire Graph call links, and file-scope calls standing in for imports" : "Graphify call and import links"}`, TEST_MAPPER_LABEL],
    gaps: [
      unresolvedTargets.length ? `Unresolved boundaries (not analysed): ${unresolvedTargets.map((t) => t.replace(/^ref_/, "").replace(/_/g, ":")).join(", ")}` : null,
      "Dynamic calls, callbacks and consumers outside this repo are not indexed.",
      isEntire(index) ? "Function end lines come from the indexer (Entire Graph)." : "Function end lines come from brace matching, not from the indexer.",
      ...(isEntire(index) ? entireGaps(index) : []),
      ...changed.filter((f) => !index.files.includes(f.file)).map((f) => `${f.file}: changed, but no symbols indexed (file-level only).`),
    ].filter(Boolean),
  };
  const impact = {
    edited: edited.map((id) => ({ id, label: fnLabel(id) })),
    downstream: downstream.map((id) => ({ id, label: fnLabel(id) })),
    unverified: evidence.filter((e) => e.status === "unverified").map((e) => ({ id: e.nodeId, label: e.label })),
    workflows,
    removedLinks,
    newLinks: edges.filter((e) => e.level === "function" && e.change === "added").map((e) => ({ id: e.id, text: `${fnLabel(e.from)} ${e.kind === "calls" ? "calls" : "tests"} ${fnLabel(e.to)}` })),
  };

  // ---- Base view stops here ---------------------------------------------
  const common = {
    source: "shop",
    pr: { id: pr.id, number: pr.number, repo: pr.repo, title: pr.title, requirement, kind: pr.kind, branch: pr.branch, commits: pr.commits, source: "shop" },
    base: revisions.base,
    selected: { sha, short: short(sha), isBase, index: commit?.index ?? 0, message: isBase ? revisions.base.message : commit.message },
    graph: { nodes, edges },
    tests: tests.map((t) => ({ ...t, status: testStatus(t.id), proof: proofOf(t.id), statusOnBase: baseRun?.tests.find((x) => x.id === t.id)?.status ?? null })),
    baseRun: baseRun ? { revision: baseRun.revision, overlay: baseRun.overlay, counts: baseRun.counts, kindLabel: baseRun.kindLabel } : null,
    trackRecord: isBase ? null : loadPlanted(pr.id, sha),
    run: run ? { ...run, countsForSelection: runCounts } : null,
    checks,
    coverage,
    impact,
    policy: { source: `Approved policy from base commit ${short(baseSha)}`, revision: baseSha, changedInThisPr: changed.some((f) => f.file === policy.file), rules: policy },
    requirementText: requirement ? readFileAt(sha, `requirements/${requirement}.md`) : null,
    baselineNote: brief?.before ? `Author's description of the baseline: ${brief.before}` : null,
  };
  if (isBase) {
    return { ...common, diff: { files: [] }, evidence: [], brief: null, claims: [], classifier1: null, review: null, classifier2: null, labels: {} };
  }

  // ---- Claims, classifiers, review --------------------------------------
  const ctx = {
    sha, baseSha, pr, index, tests, run, checks, evidence, evidenceByNode, editedIds: edited, changedFiles: changed, labelOf: fnLabel, proofOf,
    brief, briefRev, requirementText: common.requirementText, diffText: unifiedDiff(baseSha, sha),
    affected: affectedIds.map((id) => ({ ...symbolById.get(id), label: fnLabel(id), role: edited.includes(id) ? "edited" : "downstream" })),
  };

  const sharedEdits = edited
    .map((id) => {
      const own = conceptOf(symbolById.get(id).file).label;
      const callerConcepts = [...new Set(index.calls.filter((c) => c.to === id).map((c) => conceptOf(symbolById.get(c.from).file).label))].filter((c) => c !== own);
      return { id, label: fnLabel(id), callerConcepts };
    })
    .filter((s) => s.callerConcepts.length > 0);
  const c1 = classifier1(policy, {
    changedFiles: changed,
    editedCount: edited.length,
    downstreamCount: downstream.length,
    sharedEdits,
    workflowsReached: workflows.map((w) => w.label),
    rollbackRecorded: hasRollback(brief?.rollback),
  });

  const reviewInput = buildReviewInput(ctx);
  const reviewRecord = opts.reviewRecord !== undefined ? opts.reviewRecord : loadReview(sha);
  const review = finalizeReview(reviewRecord, ctx, reviewInput);
  // Code nodes say whether the reviewer read their file. With no matching record, none are marked.
  if (review.sawFiles) {
    const saw = new Set(review.sawFiles);
    for (const n of nodes) if (n.file && CODE_NODE_TYPES.has(n.type)) n.givenToReviewer = saw.has(n.file);
  }
  const disputes = review.findings.map((f) => ({ ...f, id: f.id ?? f.title, spans: f.citations.filter((c) => c.valid) }));
  const claims = contestClaims(verifyClaims(briefRev.claims, ctx), disputes);
  // Every commit up to the selected one counts: one untrusted commit keeps the whole change out of the fast lane.
  const authors = pr.commits.filter((c) => c.index <= commit.index).map((c) => authorOf(c.sha));
  // Everything the author wrote that the reviewer reads: the title, the brief and its claims.
  const briefText = ["author", "why", "before", "after", "preserve", "approach", "alternatives", "rollback"].map((key) => brief?.[key]);
  const description = [pr.title, ...briefText, ...(briefRev.openGaps ?? []), ...(briefRev.claims ?? []).map((c) => c.text)].filter((t) => typeof t === "string").join("\n");
  const c2 = classifier2(policy, { initial: c1, checks, evidence, review, changedFiles: changed, authors, description });

  return {
    ...common,
    diff: { files: diffFiles },
    evidence,
    brief: brief ? { ...brief, revisions: undefined, checksRun: briefRev.checksRun, openGaps: briefRev.openGaps } : null,
    description: loadDescription(pr, brief, commit),
    claims,
    classifier1: c1,
    review,
    reviewInput,
    classifier2: c2,
    labels: { claimVerifier: CLAIM_VERIFIER_LABEL },
    agent: loadChat(prId, sha),
    editCheck: loadEditCheck(prId, sha),
  };
}
