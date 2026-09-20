# AI Engineering 01 — Prompt caching on the Anthropic adapter

**Status:** Proposed. One PR. No dependencies on other AI-engineering prompts.

## Concept primer (read this first)

An LLM API call is stateless. Every request re-sends the full prompt, and the provider
re-processes every token of it before generating the first output token. In this repository
that means the ~700-token `RESOLUTION_SYSTEM_PROMPT` and the ~400-token
`CLASSIFICATION_SYSTEM_PROMPT` are paid for, in full, on every single ticket — even though
they are byte-identical across requests.

**Prompt caching** lets you mark a point in the prompt and say "everything before here is
stable; remember your processed form of it." The provider keeps that processed prefix in
memory for a short TTL. A later request whose prompt begins with the exact same bytes reuses
it, skipping recomputation. Commercially this shows up as two new token counters:

- `cache_creation_input_tokens` — tokens written into the cache. Billed at a premium over
  normal input tokens (a one-off cost per cache entry).
- `cache_read_input_tokens` — tokens served from cache. Billed at a large discount versus
  normal input tokens.

Three rules govern whether it works at all, and they are the whole design problem:

1. **It is a prefix cache.** The match is on the literal token sequence from the start of the
   prompt up to the marked breakpoint. If anything before the breakpoint varies per request,
   every request is a cache miss. Therefore: order the prompt static-first, variable-last.
2. **There is a minimum cacheable prefix length**, which differs by model. A prefix shorter
   than the minimum is silently not cached — no error, just no savings.
3. **The TTL is short** (a few minutes by default, with a longer opt-in tier). Caching helps
   under sustained traffic and helps nothing on a cold, once-an-hour request. This is why the
   feature must be measured, not assumed.

This repository already *reads* both counters (`src/ai/providers/anthropic.ts`, the
`AnthropicMessageSchema.usage` block), threads them into spans as
`support.usage.cached_input_tokens` / `support.usage.cache_write_tokens`, and logs them. It
just never sets a cache breakpoint, so those counters are permanently absent. The meter is
built; this PR turns on the tap.

## Objective

Enable Anthropic prompt caching on the classification, resolution, and citation-judge calls
through the existing provider-neutral `LlmProvider` boundary, and prove the saving with
numbers from the existing evaluation harness.

## Before you write code

- Load the `claude-api` skill and confirm against current Anthropic documentation: the exact
  `cache_control` request shape, the per-model minimum cacheable prefix length for the models
  this project uses, the available TTL tiers, the maximum number of breakpoints per request,
  and the current cache-write and cache-read price multipliers. Do not rely on memory for any
  of these numbers.
- Read `src/ai/providers/anthropic.ts`, `src/ai/types.ts`, `src/ai/pipeline/classify-ticket.ts`,
  `src/ai/pipeline/resolve-ticket.ts`, `src/evals/judge.ts`, `src/evals/runner.ts`, and
  `src/config/evaluation.ts` before deciding what to change.

## Decisions

- Caching is an **adapter concern**, not a domain concern. `GenerateRequest` may gain a
  provider-neutral hint (for example `cacheableSystemPrompt: boolean`), but no domain,
  pipeline, retrieval, or evaluation code may import Anthropic cache types.
- Cache the **system prompt only** in this PR. The system prompts are static per prompt
  version and are the largest stable block. Do not attempt to cache retrieved evidence: the
  evidence block is different on almost every ticket, so it would produce cache writes with
  no reads — a cost increase, not a saving.
- Caching must be **fail-open and behaviour-neutral**. A cache miss, a provider that ignores
  the field, or a disabled configuration must produce byte-identical model output and
  identical control flow. Nothing about abstention, grounding, citations, or actions changes.
- Gate the feature behind validated configuration so a reviewer can run the evaluation with
  it off and on and compare.

## Scope

- Extend `GenerateRequest` in `src/ai/types.ts` with a provider-neutral caching hint.
- Set the Anthropic `cache_control` breakpoint at the end of the system prompt in
  `AnthropicLlmProvider.generateStructured`, only when the hint is set and the configuration
  enables it.
- Add `ANTHROPIC_PROMPT_CACHE_ENABLED` (default `true`) to `src/config/ai.ts` with Zod
  validation, and document it in `.env.example`.
- Set the hint on the classification request, the resolution request, and the citation-judge
  request.
- Surface cache token counts through `GenerateResult` (already modelled as
  `cachedInputTokens` / `cacheWriteInputTokens` — verify they survive to the caller).
- Extend the evaluation report so cache behaviour is visible and costed:
  - add `cachedInputTokens` and `cacheWriteInputTokens` to the operations metrics in
    `src/evals/contracts.ts`;
  - add `EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION` and
    `EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION` to `src/config/evaluation.ts`, keeping the
    existing "all-or-nothing pricing" refinement style;
  - make `estimateCost` in `src/evals/runner.ts` cache-aware so `estimatedCostUsd` reflects
    the real bill rather than charging cached tokens at full input price;
  - add a cache hit rate (`cacheRead / (cacheRead + uncachedInput + cacheWrite)`) to the
    printed summary in `src/evals/format.ts` and to the comparison in
    `src/evals/comparison.ts` / `comparison-contracts.ts`.
- Add deterministic unit tests (network-free, using the existing injected-client pattern in
  `tests/ai/anthropic.test.ts`):
  - the cache breakpoint is present on the request when enabled and absent when disabled;
  - the request prefix is byte-identical across two calls with different ticket text;
  - cache token counts absent from the provider response do not break parsing;
  - cost estimation charges cache reads and cache writes at their own rates.

## Non-goals

- Do not cache retrieved evidence, ticket text, or any per-request content.
- Do not change any prompt text. If a prompt must be reordered to make a stable prefix, that
  is a separate PR with its own evaluation run, because prompt text changes model behaviour.
- Do not add a response cache, a semantic cache, or request deduplication. Different concept,
  different PR.
- Do not change retry policy, the request deadline budget, timeouts, or error mapping.
- Do not add cost tracking to production `resolution_runs`. That is prompt 07.

## Measurement (this PR is not done without these numbers)

Run the live evaluation twice against the same dataset version and model, once with
`ANTHROPIC_PROMPT_CACHE_ENABLED=false` and once with `true`, and record in the PR description:

| | cache off | cache on |
|---|---|---|
| total input tokens | | |
| cached input tokens | | |
| cache write tokens | | |
| estimated cost (USD) | | |
| p50 / p95 latency (ms) | | |
| every quality metric | | |

**Quality metrics must be unchanged.** If they moved, caching changed the prompt bytes and
something is wrong — investigate rather than explaining it away. Expect latency to improve
slightly on cache hits (there is less prefix to process) and expect the first case of the run
to be a cache write.

Note honestly whether concurrency and case ordering produced a high or low hit rate, and why.
A 36-case run at concurrency 3 will not show the hit rate a production workload would.

## Documentation to update

- `README.md`: in "What it demonstrates", one line on prompt caching with the measured cost
  delta. Add the new environment variables to the setup section only if a local developer
  must set them (they have defaults, so probably a mention in `.env.example` is enough).
- `.env.example`: the three new variables with empty placeholders and one-line comments.
- `docs/operations/` — add a short `prompt-caching.md` covering: what is cached, why evidence
  is deliberately not cached, how to verify a cache hit in Langfuse/logs
  (`support.usage.cached_input_tokens > 0`), and the measured savings table.
- `AGENTS.md`: nothing to change. Caching is inside the approved provider adapter.

## How to review this PR

1. Open `src/ai/providers/anthropic.ts` and check that the only Anthropic-specific caching
   type lives in that file.
2. Confirm the system prompt is the *first* content in the request and the breakpoint sits at
   its end — anything variable placed before it silently kills the cache.
3. Read the new tests: the "byte-identical prefix across two different tickets" test is the
   one that actually protects the feature.
4. Look at the before/after table. Cost down, quality identical. If quality moved, reject.

## Verification

```bash
pnpm verify
pnpm eval -- --concurrency=3 --output=artifacts/eval-cache-off.json   # with cache disabled
pnpm eval -- --concurrency=3 --output=artifacts/eval-cache-on.json    # with cache enabled
```

Do not commit the artifacts; paste the comparison into the PR description.
