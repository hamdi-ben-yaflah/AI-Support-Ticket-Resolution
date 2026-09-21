# Prompt caching

Anthropic prompt caching lets the provider keep its processed form of a stable prompt prefix and
reuse it on later requests. This repository caches **system prompts only**, inside the Anthropic
adapter, behind a validated configuration flag.

## What is cached

| Call                         | System prompt       | Approximate size |
| ---------------------------- | ------------------- | ---------------: |
| Classification               | `classify.v1`       |      ~295 tokens |
| Resolution                   | `resolve.v4`        |      ~840 tokens |
| Citation judge (evaluations) | `citation-judge.v1` |      ~110 tokens |

Each of those requests sets the provider-neutral hint `cacheableSystemPrompt: true`
(`src/ai/types.ts`). `AnthropicLlmProvider` turns that hint into a single
`cache_control: { type: "ephemeral" }` breakpoint at the end of the system block
(`src/ai/providers/anthropic.ts`). That is the only Anthropic cache type in the codebase; no
domain, pipeline, retrieval, or evaluation module imports it.

The default 5-minute TTL is used. A cache read refreshes the entry's timer at no extra cost, so
back-to-back evaluation cases keep an entry warm; the 1-hour tier doubles the write price and buys
nothing at this traffic shape.

## The minimum cacheable prefix decides whether any of this pays off

A prefix shorter than the model's minimum is **silently not cached** — no error, and the cache
counters simply stay at zero.

| Model                     | Minimum prefix | Our prompts that clear it |
| ------------------------- | -------------: | ------------------------- |
| Claude Opus 5             |     512 tokens | resolution only           |
| Claude Sonnet 5, Opus 4.8 |    1024 tokens | none                      |
| Opus 4.7                  |    2048 tokens | none                      |
| Opus 4.6, Haiku 4.5       |    4096 tokens | none                      |

So the saving is a property of `LLM_MODEL`, not of this code. On Claude Opus 5 the resolution call
— the largest and most frequent prompt — caches, and the other two calls do not. On Claude Sonnet 5
nothing caches and the feature is an inert no-op. There is no cost _increase_ in either case: a
sub-minimum prefix produces no cache write at all.

Making the shorter prompts cacheable would mean changing prompt text, which changes model
behaviour, so it belongs in its own PR with its own evaluation run.

## Why retrieved evidence is deliberately not cached

Caching is a prefix match. The evidence block differs on almost every ticket, so marking it would
create a cache write per request and almost never a read — a cost increase, not a saving. Only the
system prompt, which is byte-identical per prompt version, sits before the breakpoint.

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

Two runs of the 36-case golden dataset at concurrency 3, same dataset version and model.

> **Pending.** Populate from `pnpm eval` with `ANTHROPIC_PROMPT_CACHE_ENABLED=false` and then
> `true`. Quality metrics must be identical between the two runs; if they moved, the prompt bytes
> changed and the cause must be found rather than explained away.

|                        | cache off | cache on |
| ---------------------- | --------- | -------- |
| total input tokens     |           |          |
| cached input tokens    |           |          |
| cache write tokens     |           |          |
| estimated cost (USD)   |           |          |
| p50 / p95 latency (ms) |           |          |

A 36-case run at concurrency 3 does not produce the hit rate a sustained production workload would:
the first case of each prompt is a cache write, and only cases that start within the TTL of a
previous one can read.
