# Impact + Entire: technical report

*Personal fork `zhex0121/impact`, branch `research/entire-integration`. Everything outside the files listed under
"What was added" is the Junction 2026 team's original Impact work. Details: [entire-integration.md](entire-integration.md).*

## The original Impact workflow
For each AI-written pull request, Impact builds a review from evidence instead of a diff: a code graph finds the
functions the change edits and the code downstream of them, a test mapper ties tests to that code, recorded test runs
(and the same tests run against the base code) say what is proven, fixed rules set severity and route, an AI review can
only raise concern, and a named person signs off one exact commit. It runs on saved evidence for ten recorded PRs.
Graphify was its code index. This work leaves that workflow, its UI and its saved evidence unchanged.

## What Entire adds (all opt-in; Graphify stays the default)
| Piece | What it does | Where |
|---|---|---|
| Entire Graph provider | `IMPACT_GRAPH_PROVIDER=entire`: runs `entire-graph snapshot` on a clean export of each commit and feeds the existing analysis. No fallback to Graphify if it fails. | `src/lib/index-provider.mjs`, `src/lib/entire-graph.mjs` |
| Native `entire-graph impact` | Asked about every edited function and every edited *type*. Finds functions that use an edited type, which Impact's function-only analysis cannot see, and cross-checks Entire's test files against the test mapper. | `src/lib/native-impact.mjs` |
| Live review | `scripts/review-change.mjs` reviews a commit that was never recorded: runs the tests now, extracts the graph live, builds the review, supports the commit-bound sign-off or override. | `scripts/review-change.mjs` |
| Output-size proxy | Compares the text an agent must read to answer three questions, grep vs Entire Graph, and scores Entire's answers against Impact's ground truth. | `scripts/entire-token-proxy.mjs` |
| Entire Sessions | Entire is enabled for Claude Code in this repo (`.entire/`, `.claude/settings.json`). | see "Sessions" |

## Reproduce
```
npm ci && npm run setup                       # as in the README; builds .demo/shop-sample
node scripts/entire-impact-demo.mjs           # native impact: a function edit, and a type-only edit Impact alone misses
node scripts/entire-token-proxy.mjs --also-self
IMPACT_GRAPH_PROVIDER=entire npm run evals    # the existing evals, run on live Entire output
# live review of a change that was never recorded:
cp -R .demo/shop-sample /tmp/shop-live && cd /tmp/shop-live && git checkout -q -b feature/REQ-30-cap-discount main
perl -0pi -e 's/const discountCents = Math\.floor\(\(subtotalCents \* percent\) \/ 100\);/const discountCents = Math.floor((subtotalCents * Math.min(percent, 50)) \/ 100);/' src/pricing/discount.ts
git -c user.name=Dev -c user.email=dev@example.invalid commit -qam "REQ-30: cap discounts at 50 percent"; cd -
node scripts/review-change.mjs --repo /tmp/shop-live --base main
```
Needs Node 22.6+, the Entire CLI and `entire plugin install graph` (tested: CLI 0.13.4, `entire-graph` v0.6.0).

## Verified results
- **Evals:** `npm run evals` 171/171 in default (Graphify) mode and 171/171 with `IMPACT_GRAPH_PROVIDER=entire`; `npm run brake` 7217/7217 (default mode).
- **Native impact demo:** 7/7 checks. A commit that only edits the type `Cart` gives, with Impact's own logic, no edited and no downstream code; with native `impact`, `cartSubtotal()` and `checkoutTotal()` are flagged and enter the evidence step as unverified.
- **Same analysis on the existing sample:** for the 7 recorded shop PR commits, Entire mode gives the same edited, downstream, route, severity and review as Graphify mode. Entire's added value is the type-edit case, live extraction (no saved export needed), exact call sites and data flows (kept in `impact.native`, not shown in the UI).
- **Live review (REQ-30 cap):** the change is blocked, with all three affected functions unproven. After an added test, 1 test fails on the old code and passes on the change, two functions are proven and `importOrder()` is still open. A sign-off was refused, an override without a reason was refused, an override with a reason was recorded, and a sign-off did not carry over to a new commit.

## Output-size proxy (not measured agent usage)
Bytes of tool output for fixed questions; "~tokens" is bytes/4. No model runs, so this says nothing about real token
use, time or correctness of an agent. The Entire answers were scored against Impact's own components; grep was not.
"grep + open files" assumes the agent opens each matching file in full (an upper bound; reading ranges would be less).

Shop sample (7 files), Entire answers == Impact ground truth on 3/3:

| Question | grep lines | grep + open files | Entire `impact` |
|---|---|---|---|
| Who calls `applyDiscount()`? | 471 B | 2487 B (3 files) | 608 B |
| Who calls `cartSubtotal()`? | 173 B | 727 B (1 file) | 569 B |
| Which test files exercise `applyDiscount()`? | 471 B | 2487 B (3 files) | 608 B |

This repo's own JavaScript (46 files), sizes only, answers not scored:

| Symbol | grep lines | grep + open files | Entire `impact` |
|---|---|---|---|
| `loadIndex` | 974 B | 95233 B (6 files) | 2092 B |
| `buildModel` | 6809 B | 162826 B (10 files) | 1030 B |
| `readFileAt` | 2613 B | 152121 B (10 files) | 1120 B |

Reading: against grep lines alone, Entire's output is *not* smaller on the tiny sample (and larger for `cartSubtotal` and
`loadIndex`); it is smaller once grep's hits must be opened to see which function calls what, and the gap grows with the
code size. Entire's answer also already names the callers, the tests and the call-site lines; grep's lines do not.

## Limitations
- Only the TypeScript shop sample was exercised. C# through Entire is untested; the Tieto C# PRs still use their recorded Roslyn data.
- `scripts/review-change.mjs` needs a repo shaped like the shop sample (TypeScript in `src/`, `tests/*.test.ts` run with `node --test`). `--ai-review` (Claude CLI) was never run. A live change has no author brief, so no claims are verified, and no blast-radius or swarm evidence.
- The trust score and one-sentence verdict are computed in the browser, so the live review prints the rule-based route, blockers and open points. The web UI lists only recorded PRs and does not show `impact.native`.
- The size proxy covers three questions on a 7-file sample plus a size-only run on this repo; it is not a measurement of agent tokens or productivity.
- Entire Brain and Trails were not used.
