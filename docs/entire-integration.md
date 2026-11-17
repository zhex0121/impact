# Entire Graph integration (experimental)

Two stages: the **runtime provider** (below) and the earlier **comparison PoC** (rest of this file, kept as evidence).

## Runtime provider

`IMPACT_GRAPH_PROVIDER=entire` (default `graphify`). `src/lib/index-provider.mjs#loadIndex(sha)` is the seam:
`model.mjs` and `blast.mjs` import it instead of `graphify.mjs`. In Entire mode it exports the commit from
`.demo/shop-sample` with `git archive` into a temp dir, runs
`entire-graph snapshot --repo <dir> --format ndjson --profile full --worktree`, adapts the NDJSON and
deletes the temp dir. The index is cached per process only. An unknown provider name, a missing plugin or a
failing snapshot throws; nothing falls back to Graphify.

Changes made so the existing analysis can consume Entire's output (all in the adapter or provider, none in the rules):
- **Call lines.** Entire gives a call-site *range* and the callee name. `line` is set only when exactly one line
  in that range calls the callee (`lineSource` says so); otherwise it is `null` and `lineCandidates` lists the
  lines. On the eight sample commits every call line equals Graphify's.
- **Imports.** `testmap.mjs` needs file -> symbol links for test files. Entire has no named-import edges, so
  file-scope `CALLS` from test files fill `imports`, each marked `via: "entire file-scope call"`. A test that
  only calls code from inside a helper function would not be linked; the review's gaps say so.
- **Test-file helpers.** Functions declared in `tests/` (e.g. `total` at `977be6e`) and their calls are kept in
  `testSymbols` / `testCalls`, out of the map as with Graphify, and listed in the review's gaps.
- **Overloads.** Instead of throwing, every symbol that shares an id gets `~L<start line>` and is listed in
  `ambiguous` (and in the review's gaps). Checked on a throwaway TS file with three `f` overloads.
- Review labels (`coverage.indexer`, mapper, gaps, blast tool) name Entire Graph; Graphify-mode text is unchanged.

Verified: all 171 evals, `brake` (7217 checks) and `fastlane` (92 held) pass in both modes; in Entire mode a
wrapper logged the real `entire-graph snapshot` calls. Not verified: C#, repositories other than the shop
sample, and the saved-evidence stages (`setup:fresh`, blast recording) in Entire mode.

## Native `entire-graph impact` (Entire mode)

Evaluated against the installed help and real runs on the shop sample:

| Command | Verdict |
|---|---|
| `impact` | **Used.** One answer per symbol: callers (depth 1-2, exact `call_site.line`, test files included), callees, `type_consumers` (USES_TYPE / PARAM_TYPE / RETURNS_TYPE), `data_flows`, `co_changes`, `siblings`, plus completeness. |
| `neighbors` | Not used. A subset of `impact` (one relation, one direction); using both would duplicate it. |
| `verify` | Not used. It adjudicates a test run against a recorded baseline, but its parsers (pytest, jest, cargo, go, ...) do not include `node --test`, so here it degrades to an exit-code-only verdict, and Impact already has its own recorded before/after runs. |

What Impact gains (`src/lib/native-impact.mjs`, called from `buildModel`, Entire mode only):
- **Edits to types and fields.** `editedSymbolIds` only sees functions, so a diff that only touches an interface
  produced no edited symbols and no downstream. Now every edited type is sent to `impact`; the functions that use it
  join `downstream` (marked "uses the edited type (Entire Graph impact)") and flow into the existing evidence step.
- **Independent test cross-check.** The test files Entire says call the edited code are compared with the tests
  the rule-based test mapper reaches; any difference is listed in the coverage gaps.
- **Data flows and exact call sites** are kept in `impact.native` (a result that flows into a caller's output;
  the call-site line from Entire itself).
- `IMPACT_ENTIRE_IMPACT=off` keeps Entire as the index only, for before/after comparisons. Graphify mode never runs this step.

Run `node scripts/entire-impact-demo.mjs`: scenario A is the real req-17 commit 1 (Entire agrees with Impact's
call walk and test mapper); scenario B is a throwaway commit that only edits `Cart` (before: nothing found;
after: `cartSubtotal()` and `checkoutTotal()` flagged, both unverified). The commit lives on a temporary branch
in the gitignored `.demo/shop-sample` and is deleted afterwards.

Limits: `impact` runs once per edited symbol (one clean export per review, about 0.15 s each, cached per process);
depth is capped at 2 by Entire, and Impact's own walk covers deeper callers; `co_changes` is empty because the
export has no history; a type's *users' callers* come from Impact's call walk, not from Entire; only
TypeScript was tried. The helper functions in test files are not sent to `impact`.

## Comparison PoC (earlier stage)

**Provenance.** Everything in Impact outside the files listed here is the work of the Junction 2026 team
(upstream `h-a-forster/impact`). The files below are new, were added in a personal fork
(`zhex0121/impact`, branch `research/entire-integration`), and are **experimental**. Only `src/lib/index-provider.mjs`
(and the two one-line import swaps in `model.mjs` and `blast.mjs`) connect them to the demo, and only when
`IMPACT_GRAPH_PROVIDER=entire` is set. Nothing reads `data/entire-graph/` at runtime.

| File | Purpose |
|---|---|
| `src/lib/index-provider.mjs` | Provider switch (`IMPACT_GRAPH_PROVIDER`), live extraction |
| `src/lib/entire-graph.mjs` | Adapter: Entire Graph NDJSON -> the index shape of `graphify.mjs#loadIndex`, plus `compareIndexes` |
| `scripts/entire-graph-poc.mjs` | Runs Entire on one commit of the shop sample, compares with the saved Graphify export |
| `data/entire-graph/<sha>.json` | Entire index with provenance (raw line, confidence, resolution, evidence per item) |
| `data/entire-graph/<sha>.comparison.json` | Entire vs Graphify on the same commit |

## Run

```
npm run setup                      # builds .demo/shop-sample (only needed once)
node scripts/entire-graph-poc.mjs  # default: the sample's base commit
```

Needs the `entire-graph` plugin (`entire plugin install graph`; verified with v0.6.0 under
`~/.local/share/entire/plugins/bin`). Entire CLI 0.13.4. `entire-graph doctor --json` reports `no_egress: true`.

The command run (on a clean `git archive` of the commit, in a temp dir):
`entire-graph snapshot --repo <dir> --format ndjson --profile full --worktree`.
`--worktree` is used because it never touches Entire's cache. This installed `snapshot` has no `--cache-dir`.

## Verified record shapes (v0.6.0, schema 1.4)

Records carry `record_type`: header (has `schema_version`, `provider`), `file`, `symbol`, `external`,
`relation`, `summary`.

- **symbol:** `id`, `kind`, `name`, `qualified_name`, `file_path`, `start_line`, `end_line`, `signature`,
  `body_hash`, `language`, `container_id`. Real end lines, so no brace matching is needed.
- **relation:** `from_id`, `to_id`, `type`, `confidence` (number), `reason`, `resolution`, `provenance`
  (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`, the same labels Graphify uses), `evidence[]`, `warning_codes`.
  Relations are **directed** (Graphify's export is not).
- Ids embed a repo key from the directory name (`local/src:...`). The adapter strips it.
- The header holds the absolute `repo_root`. It is never written to `data/`.

## Differences the adapter does not paper over

- `CALLS` evidence gives the **enclosing range** of the call, not the call line. `calls[].line` is `null`.
  Graphify gives a line.
- Entire writes `IMPORTS` file -> file. Graphify writes file -> symbol. The adapter keeps Entire's as
  `fileImports` and leaves `imports` empty rather than converting. The comparison matches them at file level.
- Test files get file -> symbol `CALLS` (kept as `fileCalls`), not symbol -> symbol.
- Fields, sections and config keys are symbols in Entire. They are counted in `otherSymbols`, not put in `symbols`.
- Relation types other than `CALLS` / `IMPORTS` (e.g. `DATA_FLOWS`, `USES_TYPE`, `READS_FIELD`) are only
  counted in `otherRelations`, with a `heuristic` flag for the types the plugin lists as heuristic
  (`HANDLES_ROUTE`, `HTTP_CALLS`, `EMITS`, `LISTENS_ON`, `HANDLES_TOOL`, `SIMILAR_TO`, `TESTS`).
- Duplicate ids (overloads): the PoC run above predates the runtime provider; the adapter now suffixes them
  (`~L<line>`) and lists them in `ambiguous` instead of throwing. The PoC defaults (no `testFile`, no
  `importsFromFileCalls`, `calls[].line` null) are unchanged. The adapter now also emits three keys
  (`testSymbols`, `testCalls`, `ambiguous`), so rerunning the PoC adds them (empty) to the saved files; the files
  under `data/entire-graph/` are the original evidence and were not regenerated.

## Result on `2e22bc2` (shop sample base; Graphify 0.9.108, Entire Graph v0.6.0)

| | Entire | Graphify | Overlap |
|---|---|---|---|
| functions + types | 10 | 10 | 10 |
| symbol -> symbol calls | 4 | 4 | 4 |
| file imports | 5 | 5 | 5 |
| test file -> symbol links | 3 | 3 | 3 |

Start and end lines match for all 10 symbols. Agreement on this very small sample is not evidence about
larger code. The C# path is untested.

## Rollback

Delete the four files above (`git rm` / `rm -r data/entire-graph`). Nothing else references them.
