// NATIVE ENTIRE GRAPH IMPACT (new work, personal fork; Entire mode only).
//
// Impact's own analysis (model.mjs) finds edited *functions* and walks call edges upward. It cannot see an
// edit to a type or its fields, and it only knows tests through the rule-based test mapper. In Entire mode this
// module asks Entire's own `entire-graph impact` about every edited function and every edited type, and
//   1. adds the functions that use an edited type (USES_TYPE / PARAM_TYPE / RETURNS_TYPE) and anything Entire
//      lists as a caller that Impact's call walk did not reach, to `downstream`, each marked with where it came from;
//   2. reports the data flows Entire sees out of each edited symbol (a result that reaches a caller's output);
//   3. cross-checks the test files Entire says call the edited code against the tests the test mapper found.
// Entire's answers are kept as returned (relation, depth, call site). Nothing is guessed; whatever is partial is listed.
import { ENTIRE_IMPACT_COMMAND } from "./entire-graph.mjs";
import { indexerLabel, nativeImpacts } from "./index-provider.mjs";

/** IMPACT_ENTIRE_IMPACT=off keeps Entire as the index only and runs Impact's own analysis alone. */
export const nativeImpactEnabled = () => (process.env.IMPACT_ENTIRE_IMPACT ?? "on").toLowerCase() !== "off";

const overlaps = (ranges, start, end) => (ranges ?? []).some(([a, b]) => a <= end && b >= start);
const isTest = (file) => /^tests\//.test(file ?? "");

/** Types (interfaces, classes...) whose body a diff touches. Impact's editedSymbolIds only looks at functions. */
export function editedTypes(index, baseIndex, ranges) {
  const out = new Map();
  for (const s of index.symbols) if (s.kind === "type" && overlaps(ranges[s.file]?.added, s.line, s.endLine)) out.set(s.id, s);
  for (const s of baseIndex.symbols) {
    const now = index.symbols.find((x) => x.id === s.id);
    if (s.kind === "type" && now && overlaps(ranges[s.file]?.removed, s.line, s.endLine)) out.set(s.id, now);
  }
  return [...out.values()];
}

/**
 * @returns { extraDownstream: [{id, via, from}], info } or null when nothing was edited.
 *   extraDownstream: function ids to add to `downstream` (not edited, not already downstream).
 */
export function nativeImpactAnalysis({ sha, index, baseIndex, edited, ranges, downstream, tests }) {
  const bySymbol = new Map(index.symbols.map((s) => [s.id, s]));
  const targets = [...edited.map((id) => bySymbol.get(id)).filter(Boolean), ...editedTypes(index, baseIndex, ranges)];
  if (!targets.length) return null;
  const answers = nativeImpacts(sha, index, targets);

  const known = new Set([...edited, ...downstream]);
  const extra = new Map(); // id -> { id, via, from }
  const perTarget = [];
  for (const t of targets) {
    const a = answers.get(t.id);
    const fnIds = (entries) => entries.filter((e) => e.id && bySymbol.get(e.id)?.kind === "function").map((e) => e.id);
    const callerFns = [...new Set(fnIds(a.callers))];
    const consumerFns = [...new Set(fnIds(a.typeConsumers))];
    for (const [ids, via] of [[consumerFns, "uses the edited type (Entire Graph impact)"], [callerFns, "caller (Entire Graph impact)"]]) {
      for (const id of ids) if (!known.has(id) && !extra.has(id)) extra.set(id, { id, via, from: t.id });
    }
    const nativeTestFiles = [...new Set(a.callers.filter((e) => e.kind === "file" && isTest(e.file)).map((e) => e.file))].sort();
    // Tests the test mapper ties to this target or to anything Entire says it affects.
    const affected = new Set([t.id, ...callerFns, ...consumerFns]);
    const mappedTestFiles = [...new Set(tests.filter((x) => x.reaches.some((r) => affected.has(r))).map((x) => x.file))].sort();
    perTarget.push({
      id: t.id,
      kind: t.kind,
      file: t.file,
      line: t.line,
      callers: a.callers.map((e) => ({ id: e.id, kind: e.kind, depth: e.depth, via: e.via ?? null, callSite: e.callSite ?? null })),
      typeConsumers: a.typeConsumers.map((e) => ({ id: e.id, relation: e.relation })),
      dataFlows: a.dataFlows.map((e) => ({ id: e.id, relation: e.relation, direction: e.direction })),
      testFiles: { entire: nativeTestFiles, testMapper: mappedTestFiles, entireOnly: nativeTestFiles.filter((f) => !mappedTestFiles.includes(f)) },
      totals: a.totals,
      completeness: a.completeness,
      warnings: a.warnings,
      unmappedEndpoints: [...a.callers, ...a.typeConsumers, ...a.dataFlows].filter((e) => e.unmapped).map((e) => e.entireId),
    });
  }
  const incomplete = perTarget.filter((p) => p.completeness && p.completeness !== "ok").map((p) => `${p.id}: Entire reports completeness "${p.completeness}"`);
  return {
    extraDownstream: [...extra.values()],
    info: {
      tool: indexerLabel(index),
      command: ENTIRE_IMPACT_COMMAND,
      targets: perTarget,
      addedDownstream: [...extra.values()],
      incomplete,
    },
  };
}
