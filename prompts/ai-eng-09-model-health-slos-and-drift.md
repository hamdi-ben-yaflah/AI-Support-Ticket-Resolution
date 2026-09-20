# AI Engineering 09 — Model-health SLOs and drift detection

**Status:** Proposed. One PR. Run last: it consumes signals that prompts 01–08 add, and it is
the piece that closes the loop from "we built it" to "we operate it."

## Concept primer (read this first)

### Service health is not model health

You already know SLIs, SLOs, and error budgets from web operations: p95 latency, 5xx rate,
availability. Those still apply here, and this repository is well instrumented for them.

They are also blind to the failure mode that actually matters in an LLM system. Consider a
deploy where the resolution model starts abstaining on 60% of tickets instead of 8%. Every
request returns HTTP 200. Latency improves, because abstentions skip the resolution call. Cost
falls. Error rate is zero. Every conventional dashboard is green, and the product is broken.

This is **silent failure**, and it is the defining operational characteristic of LLM systems:
the software works perfectly while the behaviour degrades. Detecting it requires SLIs derived
from the *decisions the system makes*, not from the transport.

### The model-health SLIs this system already emits and ignores

Every one of these is already produced and thrown away:

| signal | where it is produced today | what a shift means |
|---|---|---|
| abstention rate, split by `reasonCode` | `logAbstention` in `resolve-ticket.ts`, `support.abstention.reason_code` | behaviour drift; the product silently got more or less conservative |
| classification confidence distribution | `support.confidence` span attribute | model or prompt change; directly drives the abstention gate |
| retrieval similarity distribution | `similarities` in the `retrieval_completed` log event | corpus drift, embedding-model change, or a shift in what users ask |
| `fallbackUsed` rate | `retrieval_completed` | category filter is failing more often |
| finish-reason mix (`refusal`, `max_tokens`) | `support.finish_reason` | prompt or model regression; truncation means output-token budget is too small |
| `validationPassed` / `invalid_output` rate | model-call log events | the model is drifting out of the schema contract |
| retry rate | `support.retry_count` | provider instability, eating the latency budget |
| action mix (`reply` / `request_refund_review` / `needs_human_review`) | persisted on every run | the clearest single view of product behaviour |

### Monitor distributions, not averages

A mean hides exactly the failures you care about. If retrieval similarity used to be tightly
clustered around 0.82 and is now bimodal — half at 0.85 and half at 0.66 — the mean barely
moves while a whole class of queries has started retrieving near-garbage.

So: alert on quantiles (p10 of similarity is more informative than the mean), on rates within
bounded ranges rather than one-sided thresholds (abstention above 25% *or* below 2% are both
suspicious — an abstention rate that collapses to zero means the safety valve stopped working),
and on distribution distance between a recent window and a baseline window.

Keep the statistical machinery proportionate. A **Population Stability Index** or a
Kolmogorov–Smirnov statistic over a histogram of recent versus baseline values is enough, and
is far easier to explain in a review than anything heavier. What matters is that the comparison
is against a **recorded baseline** — the distribution captured at a known-good release — and
that the baseline is versioned alongside the prompt and model versions that produced it.

### The guardrail-metric pattern

When you ship a prompt or model change, you have a *target* metric you hope moves (say, cost) and
**guardrail metrics** that must not move (abstention rate, action mix, citation count per reply).
Defining the guardrails before the change, and checking them after, is what turns "we deployed
and it seemed fine" into a release practice. The alert definitions from this PR are exactly that
guardrail set.

## Objective

Turn the signals this system already emits into named SLIs with SLOs, a recorded baseline,
drift detection against it, and alert definitions — without building a production analytics
dashboard (`AGENTS.md` §2 forbids one).

## Decisions

- Metrics are **derived from data already recorded**. Do not add new content to logs, traces, or
  the database to make this work; if an SLI needs a signal that does not exist, add it
  explicitly and to the tracing allowlist, and extend the privacy-boundary tests.
- Emit **OpenTelemetry metrics** alongside the existing spans, through the same project-owned
  facade pattern as `src/observability/tracing.ts`. Keep the backend swappable; Langfuse and any
  OTLP collector should both work. Metric emission must be fail-open exactly as tracing is —
  an exporter outage cannot fail or delay a ticket.
- Baselines are **committed artifacts**, versioned by prompt versions, model set, retrieval
  version, and dataset version. A baseline that is not tied to the configuration that produced
  it is not a baseline.
- Alert **definitions** are committed as code/config in the repository, so they are reviewable
  and diffable, even though the alerting backend lives outside it. A committed threshold with a
  written rationale is the deliverable; the specific vendor wiring is documentation.
- The operator view stays **local-only**, behind the existing non-production guard, and the
  production 404 assertions in `.github/workflows/pipeline.yml` must cover any new route.

## Scope

**Metrics facade**

- Add `src/observability/metrics.ts`: a typed facade with a no-op implementation (default) and
  an OpenTelemetry implementation, mirroring the tracing module's structure and its
  in-memory test double in `src/observability/testing.ts`.
- Instrument counters and histograms for: resolutions by outcome and abstention reason,
  classification confidence, retrieval similarity (p10/p50/p90), `fallbackUsed`, finish reasons,
  validation failures, retries, latency by stage, and — after prompt 07 — cost.
- Attribute every metric with the dimensions that make it actionable: prompt version, model,
  retrieval version, category, and deployment revision. Those are the axes you will slice by
  when something moves, and adding them later means losing the history.

**SLO definitions**

- Add `src/observability/slo.ts` (or a committed config file) defining each SLI, its objective,
  its evaluation window, and a one-line rationale. Two-sided bounds where a collapse is as
  suspicious as a spike.
- Suggested starting set, to be replaced by values your own data supports: abstention rate
  within a band; `invalid_output` rate below a small ceiling; refusal rate near zero; truncation
  rate near zero; retry rate below a ceiling; p95 end-to-end latency within the existing request
  deadline; retrieval p10 similarity above a floor. Derive the initial numbers from an
  evaluation run and from local traffic, and **document how each number was chosen** — a
  threshold with no derivation is a number someone made up, and reviewers can tell.

**Drift detection**

- Add `src/observability/drift.ts`: histogram capture, a committed baseline format, and a
  distribution-distance function (PSI or KS) with unit tests over synthetic distributions where
  you know the expected answer.
- Add `scripts/capture-baseline.ts` and `pnpm baseline:capture`, writing a versioned baseline
  from an evaluation run or a window of production runs.
- Add `scripts/check-drift.ts` and `pnpm drift:check`, comparing a recent window to a baseline
  and exiting non-zero beyond the configured distance. Suitable for a scheduled job.

**Operator view and alerts**

- Extend the local-only admin surface with an SLI panel: current values, objectives, and drift
  versus baseline.
- Add `docs/operations/alerts/` with committed alert definitions — condition, window, severity,
  and a runbook line for each ("abstention rate above band → compare prompt version and model
  against the last baseline; run `pnpm eval` to confirm; roll back if quality regressed").

## Non-goals

- No production analytics dashboard, no multi-tenant metrics, no customer-facing reporting
  (`AGENTS.md` §2).
- No automated rollback or self-healing. Alerts and runbooks; a human decides.
- No new content in logs or traces. This PR consumes what exists.
- No sampling based on ticket content (already forbidden by the observability design).

## Measurement (the deliverable)

- A committed baseline for the current release, with the prompt versions, model set, retrieval
  version, and dataset version it was captured under.
- A demonstrated drift detection: deliberately change something behaviour-affecting on a local
  branch — lower `RESOLUTION_MINIMUM_CONFIDENCE`, or swap the classification model — run traffic
  or an evaluation, and show `pnpm drift:check` catching it with the specific distribution that
  moved. **An alert nobody has seen fire is not known to work**, and this demonstration is the
  single most convincing artifact in this PR.
- A table of every SLI with its objective and the derivation of that objective.
- The guardrail set: which metrics must not move when a prompt or model changes, and why.

## Documentation to update

- `README.md`: an "Operations" line in "What it demonstrates" covering model-health SLOs and
  drift detection, and `pnpm drift:check` / `pnpm baseline:capture` in Useful commands.
- `docs/operations/langfuse-observability.md`: extend to cover metrics alongside traces.
- `docs/operations/` — add `model-health.md`: the SLI catalogue, why service health is
  insufficient, how baselines are captured and versioned, how drift is computed, and the
  runbook for each alert.
- `AGENTS.md` §3: note that `src/observability` now owns metrics as well as logs and traces.
- `.env.example`: any metrics exporter configuration.

## How to review this PR

1. Check that every SLO number has a written derivation next to it. Undocumented thresholds are
   the thing that makes monitoring untrustworthy.
2. Confirm the abstention-rate SLO is two-sided. A one-sided alert misses the failure where the
   safety valve stops firing, which is the more dangerous direction.
3. Confirm the baseline file records the prompt versions, models, retrieval version, and dataset
   version. A baseline without them cannot be interpreted six months later.
4. Look at the demonstrated drift detection. If the PR only defines thresholds and never shows
   one firing, ask for the demonstration before merging.
5. Confirm metric emission is fail-open and that no metric carries ticket content, session
   identifiers, or free-text reasons.

## Verification

```bash
pnpm verify
pnpm baseline:capture
pnpm drift:check              # green against the fresh baseline
# then apply a deliberate behaviour change and show it go red
```
