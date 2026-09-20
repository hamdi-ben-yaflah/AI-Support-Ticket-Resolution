# AI Engineering Roadmap — nine PRs

Index for `prompts/ai-eng-01..09`. Each file is a self-contained brief for one session and one
pull request. Every brief has the same shape:

- **Concept primer** — the AI-engineering idea explained from scratch, in terms a full-stack
  engineer already has words for. Read this before the scope.
- **Objective / Decisions / Scope / Non-goals** — the house format used by every other file in
  `prompts/`.
- **Measurement** — the numbers the PR must produce. In this domain a change without a
  measurement is an opinion; every brief demands the table.
- **Documentation to update** — which of `README.md`, `AGENTS.md`, `.env.example`, and
  `docs/operations/` this PR must touch.
- **How to review this PR** — three or four things to check, including the most likely defect.

## Order and dependencies

```text
01 prompt caching ──────────────────────────────────┐
                                                    │
02 evaluation gate in CI ──┬── 03 model routing ────┤
                           │                        ├── 07 cost accounting
                           │                        │
04 corpus + ANN index + ───┴── 05 hybrid retrieval  │
   retrieval benchmark                              │
                                                    │
06 adversarial evaluation                           │
                                                    │
08 feedback loop                                    │
                                                    │
09 model-health SLOs and drift ─────────────────────┘
   (consumes everything above)
```

| # | PR | Tier | Hard dependency | Why here |
|---|---|---|---|---|
| 01 | [Prompt caching](ai-eng-01-prompt-caching.md) | 1 | none | Safe warm-up. Output-neutral, immediate cost win, and the counters already exist. |
| 02 | [Evaluation gate](ai-eng-02-eval-regression-gate.md) | 1 | none | Must land before any change that alters model behaviour. |
| 03 | [Model routing](ai-eng-03-model-routing.md) | 1 | 02 | Changes model behaviour; needs the gate to be credible. |
| 04 | [Corpus, ANN index, benchmark](ai-eng-04-retrieval-benchmark-and-index.md) | 2 | none | Builds the measuring instrument for all retrieval work. |
| 05 | [Hybrid retrieval](ai-eng-05-hybrid-retrieval-and-reranking.md) | 2 | 04 | Unprovable without 04's benchmark. |
| 06 | [Adversarial evaluation](ai-eng-06-adversarial-eval-suite.md) | 2 | 02 (reuses gating), 04 (helps) | Converts the safety design into measured evidence. |
| 07 | [Cost accounting and budget breaker](ai-eng-07-production-cost-accounting.md) | 3 | 01, 03 | Shows the caching and cascade wins in production. |
| 08 | [Feedback loop](ai-eng-08-feedback-loop.md) | 3 | 02 (helps) | Independent; can be done any time after the gate exists. |
| 09 | [Model-health SLOs and drift](ai-eng-09-model-health-slos-and-drift.md) | 3 | all | Consumes the signals the others add. |

One PR per branch, one branch per prompt. Suggested branch names:
`ai-eng/01-prompt-caching`, `ai-eng/02-eval-regression-gate`, and so on.

## How to run a session

Start a fresh session in this repository and say, in substance:

> Read `prompts/ai-eng-01-prompt-caching.md` and follow the AGENTS.md workflow. Inspect the
> repository, then propose the implementation plan for approval before writing code.

`AGENTS.md` §1 already requires a saved, approved plan before implementation, so the brief is
the input to that step rather than a replacement for it. Two things the brief does not do, and
you should insist on in the session:

- It does not authorise scope beyond its own Non-goals. Anything extra is a new plan.
- It does not exempt the session from the current provider documentation. Several briefs say to
  load the `claude-api` skill and verify API shapes and prices rather than writing them from
  memory.

## Glossary

Terms used across the briefs, in the order you will first meet them.

| Term | Meaning here |
|---|---|
| **Prompt caching** | Provider-side reuse of a processed prompt *prefix*. Prefix-matched, minimum length, short TTL. Brief 01. |
| **Cache read / cache write tokens** | The two new billing counters caching introduces: discounted reads, premium one-off writes. Brief 01. |
| **Eval (evaluation suite)** | A fixed dataset scored on *properties* rather than exact strings. The LLM equivalent of a test suite. Brief 02. |
| **Golden dataset** | The version-controlled case file, `data/evals/golden.jsonl`. |
| **Cassette / replay** | A recorded provider response, replayed offline so evals run free and deterministically in CI. Brief 02. |
| **Wilson interval** | A confidence interval for a proportion. Gating on its lower bound stops small-sample noise from flapping the build. Brief 02. |
| **LLM-as-judge** | Using a model to grade outputs. Here: `src/evals/judge.ts` scoring citation support. |
| **Self-preference bias** | A judge model rating its own family's output generously. Mitigated by judging with a different model. Brief 03. |
| **Cascade / model routing** | Binding each pipeline task to the cheapest model that passes its quality bar. Brief 03. |
| **Dense retrieval** | Embedding-based semantic search — what this repo does today. |
| **Lexical retrieval / BM25** | Word-matching search, weighted by term rarity. Strong exactly where dense is weak: identifiers, rare names, negation. Brief 05. |
| **Hybrid retrieval** | Running both and merging. Brief 05. |
| **RRF (Reciprocal Rank Fusion)** | Merging by rank rather than by score, avoiding incomparable score scales. Brief 05. |
| **ANN / HNSW** | Approximate nearest-neighbour search. Trades a little recall for large latency wins, tuned by `ef_search`. Brief 04. |
| **recall@k / MRR / nDCG** | Retrieval metrics computable without any LLM. Brief 04. |
| **Bi-encoder vs cross-encoder** | Encoding query and document separately (fast, precomputable) versus together (accurate, expensive). The basis of reranking. Brief 05. |
| **Prompt injection, direct and indirect** | Instructions smuggled in through user input, or through retrieved content. Brief 06. |
| **Attack success rate** | Failed-defence cases over total attack cases, with machine-checkable success conditions. Brief 06. |
| **Over-refusal** | The cost of hardening: a system that abstains on everything scores perfectly on attacks and is useless. Brief 06. |
| **Unit economics / cost per resolution** | The marginal cost of one successful run. A first-class engineering metric in LLM systems. Brief 07. |
| **Budget circuit breaker** | Spend ceiling that degrades to a safe state instead of overspending. Brief 07. |
| **Offline vs online evaluation** | Fixed dataset versus measurement of real production outcomes. Brief 08. |
| **Data flywheel** | Production failures becoming labelled evaluation cases, making the suite progressively harder to pass. Brief 08. |
| **Selection bias** | Collecting only complaints produces a dataset that cannot measure accuracy. Fixed by stratified sampling. Brief 08. |
| **Silent failure** | The defining LLM failure mode: HTTP 200, green dashboards, wrong behaviour. Brief 09. |
| **Model-health SLI** | An indicator derived from the system's *decisions*, not its transport. Brief 09. |
| **Drift** | A shift in an input, retrieval, or behaviour distribution relative to a recorded baseline. Brief 09. |
| **Guardrail metric** | A metric that must *not* move when you ship a change targeting a different metric. Brief 09. |

## Deliberately deferred

Identified as worthwhile, excluded from these nine to keep each PR reviewable. Each deserves
its own brief later.

- **Judge calibration.** Hand-label 40–60 citations and report agreement between the human
  labels and `citation-judge.v1`. Without it, `citationSupport >= 0.85` is a gate on an
  uncalibrated instrument. This is the highest-value deferred item.
- **Reranking.** A cross-encoder second stage on top of brief 05's hybrid retrieval. Requires
  amending `AGENTS.md` §4, which currently permits `voyageai` for embeddings only — a
  governance change that should not ride along with an algorithm change.
- **Query transformation.** Embedding the classification summary instead of raw ticket text, or
  HyDE / multi-query expansion. Each independently moves the same retrieval metrics as brief 05,
  so bundling them makes attribution impossible.
- **Contextual retrieval.** Prepending document-level context to each chunk before embedding.
  Fits naturally into `src/ingestion` and typically yields a solid recall gain.
- **Runtime entailment checking.** `validateGroundedReply` verifies citation *provenance* but
  never that the chunk *supports* the claim; that check exists only in the offline judge. A
  cheap second-model pass would close the gap between what is evaluated and what ships.
- **Repeat-n variance runs.** Temperature 0 is not determinism. Running the dataset n times and
  reporting per-case flakiness would show which cases are genuinely stable.
- **Prompt canary / shadow evaluation.** Running `resolve.v4` and `resolve.v5` against live
  traffic and comparing cohorts. `resolution_runs.prompt_versions` already exists, so most of
  the schema work is done.
- **Wiring the bounded investigation agent.** `src/investigation/` is a tested, well-designed
  foundation — catalog, dispatcher, provenance, budgets — that nothing imports. Reachable only
  under an approved V2 plan per `AGENTS.md` §2, and it is the largest single remaining
  opportunity in this repository.
