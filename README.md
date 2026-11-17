# Impact

**Trust you can check: every AI-written pull request comes with evidence, and a person makes the call.**

[![Watch the pitch video](docs/img/video-thumb.png)](https://youtu.be/MBcNNyQR_Mg)

[Live demo](https://impact--map.modal.run) · [Pitch video](https://youtu.be/MBcNNyQR_Mg) · [Pitch deck (PDF)](docs/pitch-deck.pdf) · [Explainer (PDF)](docs/explainer.pdf)

Built for Junction 2026, Tieto challenge *Earned Trust in AI Code*.

## How it earns trust

A normal pull request shows the lines that changed. Impact shows the evidence a reviewer needs to
trust them, and says plainly what is not proven.

- **One sentence and a Trust score.** Can this merge, and if not, why: "Cannot merge yet: Order
  Import has no test for the REQ-17 case. Trust 0/100." The score comes from fixed rules, never from
  the AI, and missing proof always means 0.
- **Impact Map and Reach.** Which code the change reaches beyond the diff, and which of it no test
  covers. Nothing outside the diff is hidden.
- **Blast radius and Monte Carlo swarm.** Other AI agents get the same task blind. A change that
  reaches further than they did, or that they would not make, gets a question.
- **Too much, too little.** Each edit is taken out again to see whether any test notices. Edits
  nobody needs, and old code the change left behind, get a question.
- **Ask the agent why.** Answers come from the coding agent's own notes, saved with the pull request.
- **A person signs one exact commit.** A new commit needs a new sign-off.

It runs on two sets of pull requests: six in a small TypeScript shop sample built by this project,
and four real AI-written pull requests from Tieto's C# sample repository (MessagePack-CSharp).

![The review: a verdict, then what each tool found](docs/img/review.png)

![Impact Map: the edited function, the code around it, and which caller has no test](docs/img/impact-map.png)

![Reach: the code that uses the edit, in rings by how many calls away, untested in amber](docs/img/reach.png)

![Blast radius: the real change laid over where three agents worked](docs/img/blast-radius.png)

## Why you can trust the reviewer itself

- **Rules decide.** Severity and route (merge, human review, or wait for checks) come from fixed
  rules and the team's policy file, read from the base commit. A pull request cannot change the
  rules it is judged by.
- **The AI can only send a change to a person.** The AI reviewer's findings can raise severity or
  keep a change away from auto-merge. They can never lower either. `npm run brake` feeds every kind
  of reviewer answer (silent, wrong, broken, made up, for another change) into every demo commit to
  check this.
- **Attacks become tests.** Every way we found to sneak a change onto the auto-merge route is a
  permanent test, from a docs edit that code reads its prices from
  ([docs/negative-price-attack.md](docs/negative-price-attack.md)) to instructions to the AI hidden
  in a comment ([docs/hidden-instructions.md](docs/hidden-instructions.md)).
- **A person signs one exact commit.** A sign-off names the person and the commit, and is never
  edited. `npm run gate` passes only when the latest commit is signed off. Nothing is merged for real.
- **It shows its blind spots.** What the AI reviewer saw is listed, and code it never saw is faded
  on the map. A claim a passing test backs is marked "Contested" if the AI disputes it.
- **The team stays in control.** The automatic lane can be limited to trusted authors, and after a
  bad change gets through, that area pauses until its owner lifts it.
- **We test the tools too.** Bugs planted into the shop sample are caught by the tests or flagged by
  the edit check, none silently. Rerun on the same change, the AI reviewer chose the same route
  every time.
- **A person can merge anyway, on the record.** When proof is missing, they tick "I know this is not
  proven", give a reason and sign. It is shown everywhere as a merge against the rules (the gate says
  MERGE ALLOWED BY OVERRIDE), the trust score does not move, and no rule or AI path can make one.

## Run it

Needs Node 22.6 or newer and Git. No model access or API key needed.

```
npm ci
npm run setup
npm start
```

Then open <http://localhost:4317>. `npm run setup` rebuilds the sample Git repository and reuses the
saved evidence in `data/` (test runs, code index, AI reviews, agent runs).

To record fresh evidence instead: `npm run setup:fresh` re-runs the tests, Graphify and the edit check
on every commit (needs Graphify: `uv tool install graphifyy==0.9.108 --python 3.12`), and `npm run review:live`
re-runs the AI review (needs the `claude` CLI, signed in).

### Entire Graph provider (experimental, opt-in)

*Added in a personal fork, not part of the Junction team's original work.* Graphify stays the default.
Set `IMPACT_GRAPH_PROVIDER=entire` and Impact runs the installed [Entire](https://entire.io) Graph plugin
on a clean export of each commit it reviews, then feeds the result to the same analysis. Nothing is read
from `data/entire-graph/`, and if Entire fails the run fails (no fallback to Graphify).

Needs: the Entire CLI and its graph plugin (`entire plugin install graph`; tested with CLI 0.13.4 and
`entire-graph` v0.6.0), plus the normal setup above. Example:

```
IMPACT_GRAPH_PROVIDER=entire npm run gate -- req-17     # any command that builds a review: start, evals, gate
```

The review's coverage section then names "Entire Graph", with its gaps. It supports the TypeScript shop
sample, and on all eight sample commits it gives the same symbols, line ranges and call links as Graphify.
In Entire mode Impact also asks Entire's native `entire graph impact` about every edited function *and type*, so
an edit to an interface flags the functions that use it (`node scripts/entire-impact-demo.mjs` shows it;
`IMPACT_ENTIRE_IMPACT=off` turns it off). C# is not supported through this provider (the Tieto PRs still use their recorded Roslyn data). Details and
limits: [docs/entire-integration.md](docs/entire-integration.md).

### Hosted demo

`deploy/modal_app.py` hosts the app on [Modal](https://modal.com) (`modal deploy deploy/modal_app.py`).
It serves the saved evidence and never calls a model. In public demo mode (`PUBLIC_DEMO=1`) visitors
can click through everything; a sign-off is checked by the server as usual but kept in the visitor's
own browser, and each address gets 600 requests a minute.

## A first timed pilot

Four people from our team, not blind, each reviewed the REQ-17 trap (every test passes, Order Import
has no test) and the clean docs change: one in a plain diff, the other in Impact, swapped between
people. Times are from page load to decision; confidence is 1 to 5.

| | Plain diff | Impact |
|---|---|---|
| Trap approved | **2 of 2** (confidence 4 and 5, 91 s and 12 s) | **0 of 2** (one "need more evidence", one "request changes", 63 s and 37 s) |
| Order Import named | 2 of 2 | 2 of 2 |
| Clean change approved | 2 of 2 (118 s and 40 s) | 2 of 2 (47 s and 20 s) |

Both people who saw the trap as a plain diff named Order Import and approved anyway, with high
confidence: they saw the risk and trusted the passing tests. In Impact, "Cannot merge yet: Order
Import has no test" stopped both. Impact did not slow the clean change down. This is a pilot (n = 4,
team members who know the project), not a measured result.

## Tests

```
node evals/run.mjs          # review evals
node evals/fast-lane.mjs    # attempts to reach auto-merge that must be held
npm run -s brake            # AI reviewer answers that must never lighten the route
node evals/edit-check.mjs   # the "too much, too little" check on known cases
```

At the time of writing: 171 of 171 evals pass, 92 of 92 attempts are held, 5 of 5 override checks
pass, 7,217 of 7,217 brake checks pass, and all 24 edit-check cases come out as expected.

## How it's built

- [src/server.mjs](src/server.mjs): a small Node server with no framework. [src/public/](src/public/)
  is the web app (plain JavaScript; the map graph is a prebuilt React Flow bundle from
  [src/graph/main.jsx](src/graph/main.jsx)).
- [src/lib/model.mjs](src/lib/model.mjs) builds one review from the diff, the code index
  (Graphify for TypeScript, Roslyn for C#), recorded test runs on base and head, and the AI review.
- [src/lib/classifier.mjs](src/lib/classifier.mjs) and [src/lib/claims.mjs](src/lib/claims.mjs):
  the fixed rules for severity, route and claims. [src/lib/verdict.mjs](src/lib/verdict.mjs): the
  one-sentence verdict.
- [src/lib/reviewer.mjs](src/lib/reviewer.mjs): the independent AI reviewer, Claude Sonnet 5.5 in a
  fresh process with no tools. Its answers are saved in `data/reviews/` and replayed.
- [src/lib/blast.mjs](src/lib/blast.mjs), [src/lib/swarm.mjs](src/lib/swarm.mjs),
  [src/lib/edit-check.mjs](src/lib/edit-check.mjs), [src/lib/reach.mjs](src/lib/reach.mjs): the
  tools. The agent runs were recorded once by the scripts in [scripts/](scripts/); the demo replays them.
- [docs/](docs/): [concept card](docs/concept-card.md), [decisions](docs/decisions.md),
  [lessons log](docs/lessons-log.md), [planted-fault measurement](docs/measurement.md),
  [reviewer agreement](docs/reviewer-agreement.md).

## Data and licence

- The shop sample is made up for this demo and built from [sample/](sample/).
- [data/tieto/](data/tieto/) holds recorded review data for the real Tieto pull requests, including
  excerpts of MessagePack-CSharp (MIT). See [data/tieto/NOTICE.upstream.md](data/tieto/NOTICE.upstream.md).
- [vis-network](src/public/vendor/vis-network/) is included under its own licence.
- Everything else: [MIT](LICENSE).
