# Prompt caching

Anthropic prompt caching lets the provider keep its processed form of a stable prompt prefix and
reuse it on later requests. This repository caches **system prompts only**, inside the Anthropic
adapter, behind a validated configuration flag.

## What is cached

Classification, resolution, and the evaluation citation judge each set the provider-neutral hint
`cacheableSystemPrompt: true` (`src/ai/types.ts`). `AnthropicLlmProvider` turns that hint into a
single `cache_control: { type: "ephemeral" }` breakpoint at the end of the system block
(`src/ai/providers/anthropic.ts`). That is the only Anthropic cache type in the codebase; no
domain, pipeline, retrieval, or evaluation module imports it.

A breakpoint on the system block caches **everything the provider renders before it**, which is
the structured-output schema as well as the system prompt text. That matters: the schema is a
large stable block, so the cached prefix is considerably bigger than the prompt text alone.
Measured cached prefixes on `claude-opus-5`:

| Call                         | System prompt text | Cached prefix (measured) |
| ---------------------------- | -----------------: | -----------------------: |
| Classification + resolution  | ~295 + ~840 tokens |    2,720 tokens combined |
| Citation judge (evaluations) |        ~110 tokens |               722 tokens |

The default 5-minute TTL is used. A cache read refreshes the entry's timer at no extra cost, so
back-to-back evaluation cases keep an entry warm; the 1-hour tier doubles the write price and buys
nothing at this traffic shape.

## The minimum cacheable prefix decides whether any of this pays off

A prefix shorter than the model's minimum is **silently not cached** — no error, and the cache
counters simply stay at zero.

| Model                     | Minimum prefix |
| ------------------------- | -------------: |
| Claude Opus 5             |     512 tokens |
| Claude Sonnet 5, Opus 4.8 |    1024 tokens |
| Opus 4.7                  |    2048 tokens |
| Opus 4.6, Haiku 4.5       |    4096 tokens |

On **Claude Opus 5 all three calls cache** — measured, see the savings table below. On a model with
a 1024-token minimum the 722-token judge prefix would fall below the line and stop caching, while
the generation prefix would still clear it; that is inference from the table, not a measurement.
The saving is therefore a property of `LLM_MODEL`, not of this code. There is no cost _increase_
on any model: a sub-minimum prefix produces no cache write at all.

## Why retrieved evidence is deliberately not cached

Caching is a prefix match. The evidence block differs on almost every ticket, so marking it would
create a cache write per request and almost never a read — a cost increase, not a saving. Only the
schema and system prompt, byte-identical per prompt version, sit before the breakpoint.

## Configuration

| Variable                                     | Default | Purpose                                          |
| -------------------------------------------- | ------- | ------------------------------------------------ |
| `ANTHROPIC_PROMPT_CACHE_ENABLED`             | `true`  | Set `false` to send the system prompt uncached.  |
| `EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION`  | unset   | Cache-read price for evaluation cost estimates.  |
| `EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION` | unset   | Cache-write price for evaluation cost estimates. |

The four `EVAL_ANTHROPIC_*` prices are all-or-nothing: configure all four, or leave all four empty
and `estimatedCostUsd` stays `null`. Cache reads bill at roughly 0.1× base input, cache writes at
1.25× base input for the 5-minute TTL.

## Verifying a cache hit

- **Logs and traces:** a cached request records `support.usage.cached_input_tokens > 0` on the span
  (and `cachedInputTokens` in the structured `model_call` log line). A first request records
  `support.usage.cache_write_tokens > 0` instead. Both are visible in Langfuse when metadata-only
  tracing is enabled.
- **Evaluation summary:** `pnpm eval` prints a `cache hit` line with the hit rate, cache-read
  tokens, and cache-write tokens. Zero across a whole run with caching enabled means the prefix is
  under the model's minimum, or the run is spread far enough apart that every entry expired.

## Measured savings

36-case golden dataset `golden.v2`, concurrency 3, `LLM_MODEL=claude-opus-5`, prices $5 / $25 per
MTok input/output, $0.50 cache read, $6.25 cache write. One run per arm.

|                            |      cache off |       cache on |
| -------------------------- | -------------: | -------------: |
| uncached input tokens      |         70,585 |         14,903 |
| cached (read) input tokens |              0 |         60,972 |
| cache write tokens         |              0 |          6,914 |
| output tokens              |          9,686 |         11,227 |
| input-side cost (USD)      |         0.3529 |  0.1482 (−58%) |
| total estimated cost (USD) |         0.5951 |  0.4289 (−28%) |
| p50 / p95 latency (ms)     | 4,849 / 16,429 | 6,110 / 18,850 |
| cache hit rate             |             0% |          73.6% |

**Latency did not improve.** p50 rose 26% between the two runs. Caching removes prefix processing,
so the expectation was a small improvement; what the numbers show is that run-to-run variance and
differing case paths dominate at this sample size.

### Quality metrics moved, and why that is not evidence of a prompt change

Schema validity 86.1% → 94.4%, category accuracy 86.1% → 94.4%, retrieval recall@5 46.3% → 59.3%,
errors 6 → 2 — all better on the cache-on run.

Caching cannot change model output, and three things confirm the prompt bytes were identical:

- 60,972 cache **reads** only happen when the prefix matches byte-for-byte across requests. A
  changed prefix produces writes and no reads.
- A unit test asserts the rendered system block is deeply equal across two calls whose ticket text
  differs.
- The movement is in the _better_ direction on both arms, which prompt corruption would not cause.

The actual cause is that **this pipeline is not deterministic on Claude Opus 5**: the model rejects
`temperature`, so both runs used default sampling with adaptive thinking. Classification output
varies → the category filter varies → retrieval varies → recall and every downstream metric varies.

So the defensible claim from this measurement is **cost down, quality not comparable from a single
pair**. Establishing that caching is quality-neutral empirically would need several runs per arm,
or a model whose sampling can be pinned. The byte-level argument above is the stronger evidence and
does not depend on run count.

### Hit rate caveat

A 36-case run at concurrency 3 does not reproduce a sustained production workload: the first case
of each prompt is a cache write, and only cases starting within the 5-minute TTL of a previous one
can read. 73.6% here reflects a dense burst of traffic over a few minutes.
