# AI Engineering 07 — Cost accounting and a budget circuit breaker in production

**Status:** Proposed. One PR. Best run after prompts 01 and 03, so the production numbers show
the caching and cascade wins.

## Concept primer (read this first)

### Why cost is an engineering concern, not a finance concern

In a conventional web application, the marginal cost of serving a request rounds to zero.
Capacity planning is about CPU and memory, and nobody instruments a handler with a price.

An LLM feature inverts that. Every resolution in this repository costs real money that scales
linearly with traffic and with prompt size. A retrieval change that raises
`RETRIEVAL_MAXIMUM_CONTEXT_TOKENS` from 3,500 to 6,000 is a ~70% increase in the input bill for
every ticket, forever. A prompt edit that adds two paragraphs is a permanent tax. This makes
**cost per successful resolution** a first-class engineering metric — the number you quote when
someone asks whether the feature is viable, and the number that tells you whether an
optimisation was worth shipping.

This repository computes cost in exactly one place: `estimateCost` in `src/evals/runner.ts`,
gated on optional `EVAL_ANTHROPIC_*_USD_PER_MILLION` configuration. Production runs record
`inputTokens` and `outputTokens` in `resolution_runs` and stop there. So you can say what an
evaluation run cost and you cannot say what last week cost, what a `needs_human_review` costs
versus a drafted reply, or which ticket category is most expensive.

### Why you version the price list

Prices change. If you store only tokens and multiply by today's price at query time, every
historical cost figure silently rewrites itself the day a price changes. If you store only a
computed dollar figure, you can never recompute after fixing a pricing bug.

The standard answer is to store **both**: the token counts (the immutable physical fact) and
the cost computed with an explicitly **versioned price list**, recording which version was
applied. Then historical rows stay correct, and a pricing correction is a backfill you can
reason about. Prices are also per-model, and after prompt 01 there are four distinct rates to
track — uncached input, cached-read input, cache-write input, and output — so a flat
input/output pair is no longer sufficient.

### The circuit breaker

A cost bug in an LLM system fails differently from a cost bug elsewhere. A retry loop against a
provider does not just burn CPU; it bills. A traffic spike, a scripted client, or a bad deploy
that doubles prompt size turns into an invoice, and the first signal is usually the invoice.

A **budget circuit breaker** is the cheap insurance: track spend over a rolling window, and when
it crosses a threshold, stop spending. The important design decision is what "stop" means.
Returning a 500 is bad. This application already has a well-defined safe degraded state —
`needs_human_review` with a controlled reason — and a well-defined admission controller in
`src/security/admission.ts` that already returns typed rejections with `retryAfter`. Reuse both.
The breaker belongs next to admission control, not inside the provider adapter: it is a policy
decision about whether to start work, not a transport concern.

## Objective

Record per-run cost in production using a versioned price list, expose cost as an operational
metric, and add a budget breaker that degrades safely instead of overspending.

## Decisions

- Store token counts **and** computed cost **and** the price-list version on every run. Never
  compute historical cost from current prices at read time.
- The price list is **server-only configuration**, Zod-validated, versioned by an explicit
  string (for example `pricing.2026-09`), covering per-model uncached input, cached-read input,
  cache-write input, and output rates.
- Cost is **estimated, and labelled as estimated**, everywhere it is shown. It is derived from
  provider-reported token counts and a locally configured price list; it is not the provider's
  invoice. Say so in the UI, the docs, and the column comment.
- The breaker degrades to the existing safe abstention path or to a typed rejection with
  `retryAfter`. It never returns a raw error and never executes a partial pipeline.
- Cost is never exposed to the browser on the resolve response. It is operator telemetry.
  (`AGENTS.md` §7 — nothing about server environment values or internal economics goes to the
  client.)

## Scope

**Pricing**

- Add `src/config/pricing.ts`: versioned, per-model, four-rate price list with Zod validation
  and a typed `estimateCost(usage, model, priceList)` function.
- Fold the existing `src/config/evaluation.ts` pricing into it so evaluation and production use
  one code path and one price list. Keep the evaluation report's `estimatedCostUsd` field name.
- Unit-test the arithmetic, including the cached and cache-write rates from prompt 01 and the
  per-task models from prompt 03.

**Persistence**

- Add to `resolution_runs` via a Drizzle migration: `cached_input_tokens`,
  `cache_write_input_tokens`, `estimated_cost_usd` (numeric, non-negative check), and
  `pricing_version`. Extend the domain contracts in `src/domain/resolution-run.ts` to match, and
  keep the existing check-constraint discipline.
- Note that a run uses two models (prompt 03). Decide and document whether cost is stored as a
  single total or per task; per task is more useful and is what makes "classification is 4% of
  the bill" provable.

**Telemetry**

- Add safe cost attributes to the allowlist in `src/observability/tracing.ts`
  (`support.cost.estimated_usd`, `support.cost.pricing_version`) and to the resolve-completed
  log event. Cost is metadata, not content, so it is compatible with the existing export policy
  — but add it to the allowlist explicitly rather than letting it through by accident, and
  extend the privacy-boundary tests.

**Breaker**

- Add `src/security/budget.ts`: a rolling-window spend tracker with the same shape and testing
  style as `createAdmissionController`, deciding from recent `resolution_runs` cost.
- Add `RESOLUTION_BUDGET_USD_PER_HOUR` and `RESOLUTION_BUDGET_USD_PER_DAY` to
  `src/config/security.ts`, both optional; unset means disabled.
- Wire it into `src/app/api/tickets/resolve/route.ts` alongside admission control, before any
  provider call. Log a distinct event and span attribute when it trips.
- Test: under budget passes; over budget degrades with the documented status and `retryAfter`;
  disabled configuration is a no-op; the window rolls.

**Operator view**

- Add cost to the local-only `/admin/evaluations` surface or a sibling local-only view: cost
  per run, per action type, per category, over a time range. Keep it behind the same
  `ENABLE_LIVE_EVALUATIONS` / non-production guard, and keep the production 404 assertions in
  `.github/workflows/pipeline.yml` covering any new route.

## Non-goals

- No billing, invoicing, chargeback, quota-per-customer, or multi-tenant accounting
  (`AGENTS.md` §2 forbids all of it).
- No production analytics dashboard. A local-only operator view only.
- No automatic model downgrade when the budget is tight. That is dynamic routing, explicitly
  out of scope in prompt 03, and it changes output quality based on spend — a decision that
  needs its own design.
- Do not expose cost in the resolve API response or anywhere in the public UI.

## Measurement (the deliverable)

- Cost per resolution, broken down by action outcome (`reply`,
  `request_refund_review`, `needs_human_review`) and by category. Abstentions should be
  visibly cheaper — they skip the resolution call entirely — and showing that is a good
  sanity check that the accounting is correct.
- Classification's share of total spend, which is the retrospective justification for prompt 03.
- Cache hit rate and the resulting saving in production, which is the retrospective
  justification for prompt 01. Production traffic patterns differ from a concurrency-3
  evaluation run, so this number is the one that matters.
- A demonstrated breaker trip: set the hourly budget to a few cents on a local run, show the
  degraded response, the log event, and the span attribute.

## Documentation to update

- `README.md`: cost per resolution in "What it demonstrates". Mention the breaker under "Trust
  and safety boundaries" — refusing to spend without a human is squarely a safety property.
- `docs/operations/` — add `cost-and-budgets.md`: the price-list versioning rule and why it
  exists, how to update prices, how to backfill after a pricing correction, how the breaker
  behaves, and how to choose the budget values.
- `AGENTS.md` §5: the new `resolution_runs` columns and their invariants.
- `.env.example`: the price list and budget variables, with a comment that unset budgets mean
  disabled.

## How to review this PR

1. Confirm `pricing_version` is stored on the row and that no read path recomputes historical
   cost from current configuration.
2. Confirm cost never appears in the resolve API response body — grep the route and the
   `ApiResult` shape.
3. Check the breaker sits before the first provider call. A breaker that trips after paying is
   decoration.
4. Look at the cost-by-outcome table. If abstentions are not cheaper than replies, the
   accounting is wrong.

## Verification

```bash
pnpm verify
pnpm test:integration          # new columns and constraints
pnpm eval -- --concurrency=3   # evaluation must still cost the same as before
```
