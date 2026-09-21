# AI Engineering 01 — Prompt caching: implementation plan

**Spec:** `prompts/ai-eng-01-prompt-caching.md`
**Status:** Awaiting approval. One PR.

---

## 0. Blocking finding — read before approving

Verified against the `claude-api` skill (`shared/prompt-caching.md` § API reference), not memory:

| Model | Minimum cacheable prefix |
|---|---:|
| Claude Opus 5, Fable 5/5.1, Mythos 5/5.1 | 512 tokens |
| **Claude Sonnet 5**, Opus 4.8, Sonnet 4.6/4.5 | **1024 tokens** |
| Opus 4.7, Haiku 3.5 | 2048 tokens |
| Opus 4.6, Opus 4.5, Haiku 4.5 | 4096 tokens |

A prefix under the minimum is **silently not cached** — no error, `cache_creation_input_tokens: 0`.

Measured system-prompt sizes in this repo (chars → ~3.8 chars/token estimate):

| Call | Prompt | Chars | ≈ Tokens |
|---|---|---:|---:|
| Classification | `classify.v1` | 1,123 | ~295 |
| Resolution | `resolve.v4` | 3,198 | ~840 |
| Citation judge | `citation-judge.v1` | 420 | ~110 |

The spec's estimates (~700 resolution / ~400 classification) are in the right area but land on the
wrong side of the thresholds. Consequences:

- **On Claude Sonnet 5 (min 1024): none of the three prompts caches. All three counters stay zero,
  the measurement table shows no delta, and the PR's headline claim cannot be made.** The adapter
  special-case `supportsExplicitTemperature(model) === model !== "claude-sonnet-5"`
  (`src/ai/providers/anthropic.ts:158`) and the test default model both indicate Sonnet 5 is what
  this project runs.
- **On Claude Opus 5 (min 512): only the resolution call caches** (~840 tokens). Classification and
  the judge stay below the line.

There is no cost *increase* in either case — a sub-minimum prefix produces no cache write — so the
feature is safe to ship. But shipping it silently against Sonnet 5 means shipping a no-op and
writing a docs page about savings that do not exist.

Three ways forward; **I need a decision before implementing:**

- **(A) Implement as specced and run the measurement on Claude Opus 5** (`LLM_MODEL=claude-opus-5`).
  Resolution caches; classification and judge measurably do not. Document the threshold honestly,
  including which calls are below it and why. Recommended — it is the truthful version of this PR
  and the per-call threshold result is itself the interesting finding.
- **(B) Implement as specced, measure on the current model, and report the zero.** Defensible, but
  the README line and `docs/operations/prompt-caching.md` savings table become "no measurable
  saving at this prompt size on this model".
- **(C) Cache the evidence block too, so the prefix clears the minimum.** Rejected — the spec
  forbids it, and correctly: evidence differs per ticket, producing writes with no reads.

Enlarging a prompt to clear the threshold is out of scope by the spec's own rule (prompt text
changes are a separate PR with their own evaluation run).

Everything below assumes **(A)**, and changes only the measurement step if you pick (B).

---

## 1. Verified API facts

From `shared/prompt-caching.md` and the installed SDK (`@anthropic-ai/sdk` 0.125.0):

- Shape: `cache_control: { type: "ephemeral" }` (5-minute TTL, default) or
  `{ type: "ephemeral", ttl: "1h" }` (1-hour).
- Max **4** breakpoints per request. We use **1**.
- Render order is `tools` → `system` → `messages`. A breakpoint on the last `system` block caches
  everything before it. The system prompt is already the first prompt content here, and all
  per-request data is in `messages` — the ordering requirement is already satisfied, no prompt
  reordering needed.
- `system?: string | Array<TextBlockParam>` and `TextBlockParam.cache_control` exist in the
  installed SDK types (`resources/messages/messages.d.ts:3537`, `:139`). No `any`, no cast needed.
- Pricing multipliers: cache **write** 1.25× base input (5-min TTL) / 2× (1-h TTL); cache **read**
  ~0.1× base input. Break-even at 5-min TTL is two requests.
- Caches are per-workspace and per-model. Changing `LLM_MODEL` between runs uses separate entries.

**TTL choice: 5-minute (default).** Evaluation runs at concurrency 3 fire back-to-back, well inside
5 minutes, and a read refreshes the timer at no cost. The 1-hour tier doubles the write price and
buys nothing here. Not configurable in this PR.

---

## 2. Changes, file by file

### Adapter and contract

1. `src/ai/types.ts` — add `cacheableSystemPrompt?: boolean` to `GenerateRequest`. Provider-neutral
   hint; no Anthropic type leaves the adapter.
2. `src/ai/providers/anthropic.ts` — add `promptCacheEnabled: boolean` to
   `AnthropicProviderOptions` (default `true` if omitted, so existing test construction is
   unaffected). In `generateStructured`, build `system` as:
   - `request.system` (plain string) when the hint is unset or the provider option is `false`;
   - `[{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]` otherwise.

   The only Anthropic caching type in the codebase lives in this file. No other change to the
   request, retry loop, deadline, or error mapping.
3. `src/config/ai.ts` — add `ANTHROPIC_PROMPT_CACHE_ENABLED` to `AiConfigSchema`, Zod-validated
   boolean with default `true`, surfaced as `promptCacheEnabled` on `AiConfig`. Zod v4 has no
   env-string boolean coercion that treats `"false"` as `false`, so use an explicit
   `z.enum(["true","false"]).default("true").transform(v => v === "true")`-style parse rather than
   `z.coerce.boolean()` (which would make `"false"` truthy — a real trap here).
4. Wire the config through every `new AnthropicLlmProvider(...)` construction site (classification,
   resolution, eval runner/judge provider factory — I will enumerate them during implementation and
   keep the list to actual call sites).

### Call sites setting the hint

5. `createClassificationRequest` (`src/ai/pipeline/classify-ticket.ts:39`),
   `createResolutionRequest` (`src/ai/pipeline/resolve-ticket.ts:118`), and the judge request
   (`src/evals/judge.ts:23`): set `cacheableSystemPrompt: true`.

### Telemetry propagation (the gap the spec flags as "verify")

`GenerateResult.usage` already carries `cachedInputTokens` / `cacheWriteInputTokens`, and
`resolve-ticket.ts:389` already puts them on spans. They **stop there** — they are not in
`ResolutionExecution.metadata`, so the evaluation harness cannot see them.

6. `src/domain/resolution-run.ts` — add `cachedInputTokens` / `cacheWriteInputTokens` to the
   execution metadata schema, non-negative ints defaulting to `0`.
7. `src/ai/pipeline/classify-ticket.ts` + `resolve-ticket.ts` — carry the two counters into
   `ClassificationExecution.metadata` and sum them in `createExecutionMetadata`
   (`resolve-ticket.ts:111`), the same way `inputTokens` is summed today.

### Evaluation reporting

8. `src/evals/contracts.ts`
   - per-case `telemetry` (`:152`): add `generationCachedInputTokens`,
     `generationCacheWriteTokens`, `judgeCachedInputTokens`, `judgeCacheWriteTokens`.
   - `metrics.operations` (`:263`): add `cachedInputTokens` and `cacheWriteInputTokens` totals.
   - **All new fields get `.default(0)`, not bare `.int()`.** `src/db/evaluation-runs.ts:42/70/89`
     re-parses stored history through these same strict schemas on read; required fields would make
     every run persisted before this PR unreadable and break the comparison console. Defaults keep
     old rows valid and reading as zero.
9. `src/config/evaluation.ts` — add `EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION` and
   `EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION`, extending the existing all-or-nothing `.refine`
   so all four prices are configured together or none are.
10. `src/evals/runner.ts` — populate the new telemetry fields in `runCase`, add the two totals to
    `metrics.operations`, and make `estimateCost` (`:226`) cache-aware:
    `uncached × input + cacheRead × cacheReadPrice + cacheWrite × cacheWritePrice`. Note
    `usage.input_tokens` from Anthropic already **excludes** cached and cache-write tokens, so the
    existing `generationInputTokens` term needs no subtraction — I will assert this in the adapter
    test rather than assume it.
11. `src/evals/format.ts` — one line in the summary: cache hit rate
    `cacheRead / (cacheRead + uncachedInput + cacheWrite)`, printed as `n/a` when the denominator
    is 0 (matches the existing `percent()` null convention).
12. `src/evals/comparison-contracts.ts:150` — add `cachedInputTokens` / `cacheWriteInputTokens` to
    `OperationalDeltasSchema`; `src/evals/comparison.ts:198` — add both keys to the delta list.

### Documentation

13. `.env.example` — the three new variables with empty/commented placeholders.
14. `docs/operations/prompt-caching.md` (new) — what is cached, why evidence is deliberately not,
    **the per-model minimum-prefix table and which of our three prompts clear it**, how to verify a
    hit (`support.usage.cached_input_tokens > 0` in Langfuse/logs), and the measured savings table.
15. `README.md` — one line under "What it demonstrates" with the measured delta.
16. `AGENTS.md` — no change.

---

## 3. Tests (TDD, one at a time, network-free, injected client)

Extending `tests/ai/anthropic.test.ts`'s existing `provider(parse, ...)` pattern:

1. Hint set + provider enabled → `system` is a one-element array whose block carries
   `cache_control: { type: "ephemeral" }`.
2. Hint set + provider disabled → `system` is the plain string, no `cache_control` anywhere in the
   request.
3. Hint unset → plain string (proves the default is off at the contract level).
4. **The prefix test that actually protects the feature:** two `generateStructured` calls with the
   same system prompt and *different* `input` → the captured `system` argument is deeply equal
   between calls, and the differing bytes appear only under `messages`.
5. `cache_read_input_tokens` / `cache_creation_input_tokens` absent or `null` in the provider
   response → parses, and `usage.cachedInputTokens` / `cacheWriteInputTokens` are simply absent
   (regression guard on existing behaviour).
6. Counters present → they survive into `GenerateResult.usage` and, via a pipeline test, into
   `ResolutionExecution.metadata`.
7. `estimateCost` charges cache reads at the read price and cache writes at the write price
   (`tests/evals/`), and returns `null` when pricing is unconfigured.
8. Persisted-history regression: a stored run JSON without the new telemetry fields still parses
   through `PersistedEvaluationRunSchema`.

Behaviour-neutrality is covered by 2/3/4 plus the unchanged existing suite — no abstention,
grounding, citation, or action test changes.

---

## 4. Verification and measurement

```bash
pnpm verify
ANTHROPIC_PROMPT_CACHE_ENABLED=false pnpm eval -- --concurrency=3 --output=artifacts/eval-cache-off.json
ANTHROPIC_PROMPT_CACHE_ENABLED=true  pnpm eval -- --concurrency=3 --output=artifacts/eval-cache-on.json
```

Both runs on the same dataset version and the same `LLM_MODEL`. Artifacts are not committed; the
table goes in the PR description: total input / cached input / cache write tokens, estimated cost,
p50+p95 latency, and every quality metric, with the cache-hit-rate caveat that 36 cases at
concurrency 3 is not a production traffic shape.

**Quality metrics must be identical.** If they move, the prompt bytes changed and the PR is wrong.

Cost of the measurement: two live evaluation runs (~72 generation calls plus judge calls). Say the
word if you want that budgeted or run once instead of twice.

---

## 5. Out of scope (per spec)

Evidence caching, prompt text changes, response/semantic caching, retry and deadline changes, and
`resolution_runs` cost tracking (prompt 07).
