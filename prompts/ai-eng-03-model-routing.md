# AI Engineering 03 — Per-task model routing (the cascade)

**Status:** Proposed. One PR. **Depends on prompt 02** — do not merge a model change without
an evaluation gate to prove it.

## Concept primer (read this first)

Model families ship at several capability tiers, and the price difference between the smallest
and largest is roughly an order of magnitude per token. Latency differs by a similar factor.

A **cascade** (also called model routing, or tiered inference) is the practice of binding each
task in a pipeline to the cheapest model that still passes that task's quality bar, instead of
running the whole pipeline on one model chosen for the hardest step.

This repository runs everything on a single `LLM_MODEL` environment variable: classification,
resolution, and the citation judge. Look at what those tasks actually are:

- **Classification** — read a ticket, emit `{category, priority, summary, confidence}` capped
  at 300 output tokens. This is structured extraction with a four-way label. It is the
  textbook small-model task.
- **Resolution** — read the ticket, a classification, and up to 3,500 tokens of retrieved
  policy, then decide between three actions, obey a refund-eligibility policy with several
  required facts, draft a customer-facing reply, and attach citations that must survive
  provenance validation. This is the task that justifies a strong model.
- **Citation judge** (evaluation only) — decide whether each citation supports its claim.

Two things make this more than a cost trick, and they are what a reviewer will look for:

1. **You can only route what you can measure.** The claim "the small model is good enough for
   classification" is worthless as an assertion and valuable as a measurement. Prompt 02 built
   the gate; this PR is the first real use of it. The deliverable is a table.
2. **Judge independence.** Using the same model to generate an answer and to judge it invites
   *self-preference bias* — models tend to rate their own outputs generously. Running the
   citation judge on a different model than the resolution model is a cheap, well-recognised
   mitigation, and it belongs in this PR because it is the same configuration change.

There is a failure mode to respect: a cascade is not free quality-wise. If the small model's
`confidence` is systematically miscalibrated, the abstention gate in
`resolveTicket` (`classification.confidence < policy.minimumConfidence`) will fire at a
different rate, and abstention rate is a product-visible behaviour. Measure it explicitly.

## Objective

Replace the single `LLM_MODEL` binding with validated per-task model configuration, and prove
with the evaluation harness which model each task can safely run on.

## Decisions

- Task-to-model binding lives in `src/config/ai.ts`, is Zod-validated, and is read only by
  pipeline code that constructs a provider. No task-specific model constant is hard-coded.
- The `LlmProvider` interface does not change shape. A provider instance still has one model;
  the pipeline constructs one instance per task. This keeps the adapter simple and keeps
  routing an application decision.
- Keep `LLM_MODEL` working as the default for any task without an explicit override, so
  existing deployments and the `.env.local` of anyone running this locally do not break.
- Record **both** models on every run. A run that used two models and reports one is a
  telemetry lie that will bite during incident review.
- Routing is **static per task**, chosen offline by evaluation. Do not implement dynamic
  per-request routing (difficulty prediction, confidence-triggered escalation to a bigger
  model). That is a larger design with its own failure modes, and it is explicitly not in
  scope here.

## Before you write code

- Load the `claude-api` skill and confirm the current model IDs and their relative pricing.
  Do not write a model ID from memory.
- Re-read `supportsExplicitTemperature` in `src/ai/providers/anthropic.ts`. It special-cases
  one model ID for temperature support. With several models in play, this needs to be a
  deliberate, tested capability check rather than an inline string comparison.

## Scope

**Configuration**

- Add to `src/config/ai.ts`: `LLM_MODEL_CLASSIFICATION`, `LLM_MODEL_RESOLUTION`,
  `LLM_MODEL_JUDGE`, each optional and each defaulting to `LLM_MODEL`. Validate that at least
  one resolvable model exists.
- Document all four in `.env.example` with a comment explaining the cascade.

**Pipeline**

- `classifyTicketWithConfiguredProvider` constructs its provider from the classification model.
- The resolution path constructs its provider from the resolution model.
- `src/evals/service.ts` constructs the judge provider from the judge model.
- Move the temperature-capability decision into a small, tested function in the adapter.

**Telemetry and persistence**

- `ResolutionRunMetadata` (`src/domain/resolution-run.ts`) currently carries a single `model`.
  Change it to carry a per-task record — mirroring the existing `promptVersions` shape is the
  natural move: `models: { classification, resolution }`.
- `resolution_runs.model` in `src/db/schema.ts` becomes a jsonb column (or gains a sibling),
  with a Drizzle migration. Keep the existing non-empty check constraints in spirit.
- Spans already carry `gen_ai.request.model` / `gen_ai.response.model` per span, so the trace
  is already correct once each pipeline step has its own provider — verify this rather than
  adding anything.
- `EvaluationRuntime.model` in `src/evals/runner.ts` becomes the same per-task record, and the
  evaluation report and comparison must show it. Two runs on different cascades must be
  distinguishable in `src/evals/comparison.ts`, and comparing incompatible configurations must
  stay as strict as it is today.

**Tests**

- Configuration defaults and overrides resolve as specified.
- Each pipeline step constructs a provider with its own model.
- Run metadata and the persisted row carry both models.
- Temperature capability is decided by the tested function, per model.

## Non-goals

- No dynamic or confidence-triggered routing, no fallback-to-bigger-model on failure, no
  provider fallback (AGENTS.md forbids the last one outright).
- No prompt changes. If the small model needs a differently worded classification prompt, that
  is a `classify.v2` in its own PR with its own evaluation.
- No streaming, no batching, no cost persistence (prompt 07).

## Measurement (the deliverable)

Run the live evaluation across the candidate cascades and publish the grid. At minimum:

| cascade (classify → resolve → judge) | category acc | priority acc | action acc | abstention acc | abstention **rate** | citation support | p50 / p95 ms | cost USD |
|---|---|---|---|---|---|---|---|---|
| large → large → large (baseline) | | | | | | | | |
| small → large → large | | | | | | | | |
| small → large → *different* large (judge) | | | | | | | | |
| small → small → large | | | | | | | | |

Then state a recommendation in plain terms: which cascade ships as the default, what it costs
per resolution versus baseline, and which metric would have to regress for you to revert.

Pay specific attention to two rows of that table:

- **abstention rate**, not just abstention accuracy. If the small classifier is less confident
  on average, more tickets fall under `RESOLUTION_MINIMUM_CONFIDENCE` and the product silently
  gets more conservative. If this happens, say so and either accept it or retune the threshold
  in a follow-up PR with evidence.
- **judge agreement.** When you change the judge model, `citationSupport` may move without the
  *system* changing at all — the measuring instrument moved. Flag any judge-model change as a
  measurement change and re-baseline rather than reading it as a quality change.

## Documentation to update

- `README.md`: the cascade and its measured cost-per-resolution, in "What it demonstrates".
  Update the setup section where it tells the reader to set `LLM_MODEL`.
- `docs/operations/` — add `model-routing.md`: the per-task bindings, the measurement grid that
  justified them, how to change a binding, and the "re-baseline when the judge moves" rule.
- `AGENTS.md` §4: the "Do not use" list bans provider routing and automatic model fallback —
  that ban stays and is not what this PR does. Add a line to §4 or §3 making the distinction
  explicit: one provider, statically configured per-task models, no runtime routing.
- `.env.example`: the three new model variables.

## How to review this PR

1. Confirm no model ID string appears outside `src/config/ai.ts` and `.env.example`.
2. Confirm the persisted run and the evaluation report both name two models, not one.
3. Read the measurement grid. The recommended cascade must be the one the numbers support,
   not the cheapest one.
4. Check that the abstention *rate* row exists. Its absence is the most likely way this PR
   ships a silent behaviour change.

## Verification

```bash
pnpm verify
pnpm eval:replay                                   # cassettes are keyed on model — expect a forced re-record
pnpm eval -- --concurrency=3 --output=artifacts/eval-cascade-<name>.json   # once per cascade
pnpm test:integration                              # the run-persistence schema changed
```
