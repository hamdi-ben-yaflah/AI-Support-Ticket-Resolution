# AI Engineering 03 — Per-task model routing: implementation plan

**Spec:** `prompts/ai-eng-03-model-routing.md`  
**Status:** Implemented after approval. Verification complete; live-provider baseline remains a separate red measurement.

---

## 0. Findings and gates to clear first

### Prompt 02 exists, but its replay gate is currently red

The current branch contains the AI-ENG-02 replay-evaluation work, but a clean baseline run does not
pass:

```text
pnpm eval:replay
→ exit 1
→ CassetteMissError for a resolve.v4 resolution request
```

Classification replay and retrieval succeed; the first resolution lookup misses because the
committed cassettes no longer match the current request hash. Prompt 03 must not claim an evaluation
gate while that gate is red. The first implementation checkpoint will therefore be:

1. record the current all-Sonnet baseline with no routing code change;
2. confirm the refreshed baseline passes live thresholds;
3. confirm `pnpm eval:replay` is green and remains network-free;
4. only then change model routing.

The refreshed baseline cassettes are task-required evidence, not a prompt or dataset change.

### Current Anthropic facts (verified 2026-09-21)

The prompt names a `claude-api` skill, but that skill is not installed in this environment. The
fallback source was Anthropic's current official model, pricing, Messages API, and deprecation
documentation.

| Candidate | Claude API ID | Input / output per MTok | Lifecycle note |
|---|---|---:|---|
| Sonnet 5 | `claude-sonnet-5` | $2 / $10 | current fast/general model |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 | active; support commitment only extends to 2026-10-15 |
| Opus 5 | `claude-opus-5` | $5 / $25 | current stronger model |

Anthropic now documents `temperature` as deprecated: models released after Opus 4.6 reject values
other than `1.0`. The repository has already moved the old inline Sonnet-only check into
`supportsExplicitTemperature`, with coverage for several current models. I will preserve that
provider-capability boundary, make the helper directly unit-testable if needed, and extend its table
tests for every model used by the measurement matrix. Model strings used as routing defaults will
not be added to pipeline code.

Before recommending Haiku for a shipped binding, I will re-check its lifecycle status. A passing
quality grid alone is not enough if the model has entered deprecation.

### Two spec omissions must be handled for truthful measurements

1. The evaluator reports abstention accuracy/precision/recall, but not **abstention rate**. Add the
   requested non-gating proportion (`predicted abstentions / all cases`) to reports, comparisons,
   persistence views, and the admin console.
2. Evaluation generation tokens currently combine classification and resolution. Applying one
   price to that total would make every mixed-model cost wrong. Preserve aggregate counters for
   compatibility, add task-level token accounting for evaluation, and calculate cost using the
   model bound to each task. This is evaluation accounting required by this prompt, not production
   cost persistence from prompt 07.

---

## 1. Configuration and provider construction

1. `src/config/ai.ts`
   - Accept optional trimmed, non-empty `LLM_MODEL_CLASSIFICATION`, `LLM_MODEL_RESOLUTION`, and
     `LLM_MODEL_JUDGE` values.
   - Keep `LLM_MODEL` as the compatibility fallback. Validate that every task resolves to a model;
     configurations with neither a fallback nor a task override fail with the existing safe error.
   - Expose `models: { classification, resolution, judge }` on `AiConfig`; remove the ambiguous
     single `model` consumer surface.
2. `.env.example`
   - Document the fallback and three overrides, including that this is static per-task selection,
     not request-time routing or fallback.
3. `src/ai/pipeline/classify-ticket.ts`
   - The standalone configured classifier uses only `models.classification`.
4. `src/ai/pipeline/resolve-ticket.ts`
   - Construct separate classification and resolution provider instances.
   - Pass the classification instance only to the classifier callback and the resolution instance
     only to generation. Do not add escalation or retry-on-another-model behavior.
5. `src/evals/service.ts`
   - Construct independent classification, resolution, and judge providers in live/record mode.
   - Select the matching scoped provider per case and task.
   - Replay mode gets the same three bindings from the cassette manifest, requiring no secrets.

The `LlmProvider` contract remains unchanged: each provider instance still owns exactly one model.

---

## 2. Run metadata and database migration

1. `src/domain/resolution-run.ts`
   - Add a strict reusable `TaskModelsSchema` for `{ classification, resolution }`.
   - Replace `ResolutionRunMetadata.model` with `models`.
   - Keep provider, aggregate latency/token/retry fields, prompt versions, and validation semantics
     unchanged.
2. `src/ai/pipeline/resolve-ticket.ts`
   - Populate both configured/observed task models even when policy abstention means the resolution
     provider is not called. This records the run's binding without pretending tokens were spent.
3. `src/db/schema.ts` and `src/db/resolution-runs.ts`
   - Replace `resolution_runs.model` with a non-null JSONB `models` value typed to the strict
     per-task record.
   - Preserve the non-empty invariant with JSON shape/string checks in the database constraint.
4. Generate the next Drizzle migration and snapshots using `pnpm db:generate`; inspect the SQL and
   ensure existing rows migrate from `model` to
   `{ "classification": model, "resolution": model }` rather than losing history.

No raw ticket, prompt, provider response, or new production cost data is persisted.

---

## 3. Evaluation runtime, replay, persistence, and comparison

1. Evaluation contracts (`src/evals/runner.ts`, `src/evals/contracts.ts`,
   `src/evals/comparison-contracts.ts`)
   - Replace runtime `model` with
     `models: { classification, resolution, judge }`.
   - Carry both generation models into each case's compact actual result.
   - Bump the evaluation report schema version because persisted shape changes; keep read handling
     explicit rather than silently misreading old runs.
2. Replay (`src/evals/replay.ts`, cassette manifest, service wiring)
   - Bump the manifest schema and store all three task model bindings.
   - Keep request hashes model-sensitive and cassette misses hard failures.
   - Recording/replay providers remain case-scoped so classification, resolution, and judge files
     cannot cross-resolve accidentally.
3. Evaluation persistence (`src/evals/persistence.ts`, `src/db/schema.ts`,
   `src/db/evaluation-runs.ts`)
   - Replace the single generation-model column with a JSONB task-model record or explicit
     classification/resolution columns; retain a separate judge model only if it avoids a destructive
     migration. In either representation, repository reads must reconstruct the canonical three-task
     runtime record.
   - Add the necessary Drizzle migration with non-empty checks for every model.
4. Comparison (`src/evals/comparison.ts`)
   - Show classification, resolution, and judge model differences separately.
   - Continue allowing intentional version/configuration differences to be displayed while keeping
     dataset, case-set, and schema compatibility strict.
   - A judge-model difference is labelled as a measuring-instrument change, not a product-quality
     change.
5. Evaluation UI and formatting
   - Update CLI output and `src/app/admin/evaluations/**` labels to display the cascade compactly and
     unambiguously.
   - Before editing these Next.js components, read the repository's installed App Router guide at
     `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`.

---

## 4. Accurate abstention-rate and mixed-model cost reporting

1. Add `abstentionRate` as a Wilson-interval proportion metric. It is reported and compared but is
   not added to the regression threshold set in this PR.
2. Preserve existing aggregate generation token fields, and add the minimum task-level usage needed
   to distinguish classification from resolution in evaluation results. Abstained cases record zero
   resolution usage.
3. Evolve evaluation pricing to a validated per-model map while retaining the old single-price
   configuration only for all-same-model runs. A mixed cascade with missing prices returns
   `estimatedCostUsd: null`; it never applies a known-wrong blended price.
4. Price classification, resolution, and judge usage independently, including cache reads/writes,
   then aggregate into total and per-resolution cost. Store/report the pricing snapshot used so a
   later comparison remains reproducible.
5. Add migration/default handling needed for prior evaluation rows. Old history must remain readable
   or be rejected with a clear schema-version incompatibility, never silently relabelled.

This is the smallest reliable way to produce the prompt's cost column from the same evaluation run.

---

## 5. Tests

Implement network-free tests before each production change:

1. AI config:
   - fallback-only config resolves all three tasks to `LLM_MODEL`;
   - each override wins independently;
   - partial overrides work with a fallback;
   - no resolvable model fails safely;
   - empty override strings are treated as absent, not as valid models.
2. Provider wiring:
   - configured classification, resolution, and judge paths receive only their assigned model;
   - abstention does not call the resolution provider but metadata still names both bindings;
   - there is no cross-model retry/fallback.
3. Anthropic temperature capability:
   - table-test Sonnet 5, Opus 5, Haiku 4.5, and representative legacy behavior against the current
     documented rule.
4. Resolution persistence:
   - schema and inserted row carry both generation models;
   - migration upgrades an existing single-model row without data loss;
   - malformed/empty task-model JSON is rejected.
5. Evaluation/replay:
   - manifest round-trips three task models;
   - cassette lookup remains model-sensitive per task;
   - stale or wrong-model cassettes fail hard;
   - report, database history, CLI, admin UI, and comparison show the full cascade;
   - judge changes are distinguished from generation changes.
6. Metrics/cost:
   - abstention rate denominator is all cases, including failed cases;
   - low-confidence/insufficient-evidence runs spend zero resolution tokens;
   - mixed-model cost applies each task's price and cache rates correctly;
   - missing mixed-model pricing yields `null`, not a false estimate;
   - compatible old stored runs follow the declared migration/default behavior.

---

## 6. Measurement sequence and shipping rule

Use current official model IDs only as environment values for these runs; do not hard-code them as
application defaults.

| Run | classification | resolution | judge |
|---|---|---|---|
| current baseline | Sonnet 5 | Sonnet 5 | Sonnet 5 |
| cheap classifier | Haiku 4.5 | Sonnet 5 | Sonnet 5 |
| independent judge | Haiku 4.5 | Sonnet 5 | Opus 5 |
| cheap generation stress case | Haiku 4.5 | Haiku 4.5 | Opus 5 |

For each cascade:

```bash
LLM_MODEL_CLASSIFICATION=<id> \
LLM_MODEL_RESOLUTION=<id> \
LLM_MODEL_JUDGE=<id> \
pnpm eval -- --concurrency=3 --output=artifacts/eval-cascade-<name>.json
```

Publish category accuracy, priority accuracy, action accuracy, abstention accuracy, abstention rate,
citation support, p50/p95 latency, total cost, and cost per resolution. Also report threshold status,
error count, and judge model so the table cannot hide a failed run or measurement change.

Shipping rule:

- no cascade is recommended unless it passes the existing evaluation gate;
- classification/priority/action metrics cannot regress beyond the gate;
- abstention-rate movement is called out separately even if abstention accuracy passes;
- judge changes trigger a citation-support re-baseline and are not described as a system-quality
  improvement by themselves;
- the recommendation considers Haiku lifecycle status as well as quality, latency, and cost;
- if no cheaper cascade clears those rules, retain the all-Sonnet binding and publish that result.

After selecting the evidence-backed recommendation, record and commit cassettes for that one cascade
and prove `pnpm eval:replay` is green with provider secrets removed from the command environment.

---

## 7. Documentation

1. `README.md` — explain the static per-task cascade, setup variables, measured cost per resolution,
   and the evidence-backed default recommendation.
2. `docs/operations/model-routing.md` — bindings, exact dated measurement grid, how to change and
   re-evaluate a binding, lifecycle check, rollback metric, and mandatory judge re-baselining.
3. `AGENTS.md` — clarify that one provider with offline-evaluated static task bindings is allowed;
   runtime provider routing, automatic fallback, and dynamic escalation remain forbidden.
4. `.env.example` — add the three overrides and any validated pricing-map example without secrets.

No prompt text, thresholds, dataset cases, provider routing, dynamic escalation, or live side effects
are added.

---

## 8. Verification and handoff

Focused tests first, followed by the repository-required checks:

```bash
pnpm verify
pnpm eval:replay
pnpm test:integration
```

Also run the four live evaluations above, then the final recommended-cascade recording run. If a
provider/model is unavailable or live measurements cannot complete, do not invent the grid or ship a
new default; report the exact blocker and leave routing overrides opt-in.

Manual checks:

1. Resolve a synthetic ticket and verify classification/resolution spans name their assigned models.
2. Inspect the persisted `resolution_runs.models` JSON and confirm both bindings.
3. Run a low-confidence case and confirm no resolution span/tokens while both configured bindings are
   recorded.
4. Open `/admin/evaluations`, confirm the three-task cascade and abstention rate are visible, and
   compare runs with generation and judge differences.
5. Run replay with Anthropic/Voyage secrets unset and confirm it passes without network access.
