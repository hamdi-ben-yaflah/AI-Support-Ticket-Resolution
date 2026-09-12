# Seventh core user story: evaluation suite with admin UI

## User story

As an engineer, I can run a repeatable evaluation suite from the command line and from a separate browser page.

## Goal

Add one reusable, bounded, versioned evaluation service around the existing classification, retrieval, grounding, and abstention pipeline. An engineer can run it from `pnpm eval` or start it from an unauthenticated `/admin/evaluations` page, inspect quality and operational metrics, drill into failed cases, and download the same schema-validated JSON report.

The browser controls and displays a run, but Anthropic, Voyage AI, PostgreSQL, authoritative validation, grading, and retry logic remain server-side. No provider key, database client, prompt, vector, or raw provider response enters the client bundle.

## Explicit scope decision

- The latest user direction explicitly overrides the repository’s proposed exclusion of an evaluation UI and proposed session authorization for this endpoint.
- The page is intentionally unauthenticated as requested. It is a local portfolio/admin surface, not a production-safe public endpoint; the UI and README will state that running it consumes live provider capacity and must not be publicly exposed as-is.
- PRD story 7 still requires a repeatable command-line workflow, so the CLI remains as a thin entry point over the same evaluation service rather than becoming a separate implementation.
- Run comparison/history is story 8 and remains deferred.

## Requirements traced to the product documents

- PRD story 7 and FR-8: provide a version-controlled golden dataset, a repeatable runner, and a non-zero CLI exit when configured regression thresholds fail.
- PRD evaluation experience: show classification accuracy, schema validity, citation support, abstention, latency, token usage/optional cost, and failed expected-versus-actual cases.
- PRD data requirements: include 30–50 synthetic normal, edge, adversarial, ambiguous, and unanswerable tickets with expected category, priority, action, relevant sources, and abstention behavior.
- Technical specification section 16: deterministic graders where possible, an inspectable rubric-based citation judge, bounded concurrency, stable case IDs, versioned run metadata, and JSON plus concise summary output.
- Current user direction: expose the complete evaluation workflow on a separate `/admin/evaluations` page with no authentication.
- Next.js 16 guidance reviewed for this plan: keep interactive state in a narrow Client Component, keep secrets and service/database calls in server-only modules, use an App Router Route Handler for the browser boundary, validate request payloads, and do not cache run responses.

## Current repository baseline

- Before this plan was revised, the only worktree change was its earlier CLI-only version.
- Stories 1–4 and 6 are implemented. The existing provider-neutral pipeline returns a validated `ResolutionExecution` with prompt versions, provider/model, aggregate generation tokens, latency, retries, action, and cited-source snapshots.
- The retrieval path exposes a provider-neutral `EvidenceRetriever`, stable source/chunk IDs, deterministic ordering, and versioned configuration that an evaluation-only recorder can wrap.
- `AiTask` permits `evaluation`, but no dataset, grader, judge prompt, runner, report schema, CLI, evaluation API, or evaluation page exists.
- The current application supports only `reply` and `needs_human_review`; refund-review/escalation execution is story 5 and will not be added here.
- JSON artifacts are sufficient for this single-run story. Evaluation database tables and historical comparison remain story 8, so no Drizzle migration is planned.
- Baseline verification passed while preparing the original plan: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test` (14 files, 117 tests), and `pnpm build`.

## Scope

### In scope

- A version-controlled and schema-validated 30–50 case golden JSONL dataset.
- A shared server-only evaluation service used by both browser and CLI.
- Deterministic schema/category/priority/retrieval/citation-provenance/abstention/action graders.
- A versioned, strict, Anthropic-backed citation-support judge that remains advisory.
- Aggregate quality and operational metrics, initial versioned thresholds, compact failure diagnostics, and optional cost estimation.
- `POST /api/evaluations/run` for a complete synchronous run and a responsive `/admin/evaluations` page with run controls, loading/failure/pass states, metrics, threshold status, case inspection, and client-side report download.
- `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json` over the same service with threshold-based process status.
- Deterministic network-free tests, route/component coverage, documentation, and available live verification.

### Out of scope

- Authentication, accounts, roles, protected admin routing, or session ownership for the evaluation page/API.
- Evaluation history, run comparison, charts over multiple runs, an evaluation database schema, saved server-side browser runs, or a list/delete-runs API.
- Streaming/SSE/WebSockets, background job infrastructure, queues, cancellation, or progress events. The page shows a single bounded running state until the synchronous response completes.
- Story 5 actions or audits; changing prompts/retrieval thresholds merely to improve the first score; adding providers; OpenAI judging; model routing/fallback; or autonomous grader loops.
- Browser-side SDK calls, embeddings, SQL, retries, authoritative Zod checks, source contents, prompts, provider responses, or secret configuration.

## Implementation plan

### 1. Define evaluation contracts and versioned configuration

- Add Zod contracts under `src/evals` for golden cases, run requests, citation-judge decisions, per-case expected/actual results, grader scores, sanitized errors, aggregates, threshold outcomes, and the browser/CLI report.
- Require stable unique case IDs, one dataset version, schema-valid ticket inputs, non-empty allowed priority/action sets, unique relevant source IDs/tags, and explicit abstention labels. Reject malformed JSONL, duplicates, mixed versions, blank lines, and datasets outside 30–50 cases before provider work.
- Add the technical-spec thresholds: schema validity `1.0`, category accuracy `0.9`, retrieval recall at 5 `0.9`, citation support `0.85`, and abstention accuracy `0.85`.
- Validate concurrency in a narrow safe range with default `3`. Keep dataset, rubric, prompt, threshold, retrieval, resolution-policy, provider, and model versions in report metadata.
- Support optional configured Anthropic per-million input/output prices; use `null`, never a fabricated estimate, when pricing is absent.

### 2. Add the synthetic golden dataset

- Add `data/evals/golden.jsonl` with 30–50 concise synthetic cases based only on the eight committed knowledge documents.
- Cover all four categories, standard/premium tiers, allowed priority variants, supported answers, safe follow-up questions, insufficient/contradictory evidence, prompt injection, secret-seeking requests, and cases related to future tool selection.
- Label expected category, allowed priorities/actions, relevant source IDs, abstention, and tags. Future refund/escalation scenarios may expect the currently safe `reply`/`needs_human_review`; this task will not implement story 5 to improve action scores.
- Do not include real customer content, secrets, provider outputs, or golden draft prose.

### 3. Build one server-only evaluation service

- Create a `server-only` executor that constructs the configured Anthropic provider, Voyage-backed evidence retriever, classifier, and resolution policy, then invokes `resolveTicket` directly—not the ticket HTTP route and not browser code.
- Wrap the retriever per case to record ranked source/chunk IDs without changing production response contracts. Re-validate successful executions and preserve dataset order after bounded concurrent completion.
- Continue after isolated per-case provider/retrieval/judge errors so the report explains failures instead of aborting the whole suite.
- Record only compact safe actuals: classification, action, citation/source IDs, scores, model metadata, tokens, latency, retries, and error codes. Omit ticket text, draft text, excerpts, full prompts, full provider payloads, credentials, vectors, SQL, and stack traces.
- Do not create normal `resolution_runs` or evaluation history rows; the suite is an offline synthetic measurement and story 8 owns persistence/comparison.

### 4. Implement deterministic graders and citation judging

- Grade schema validity, exact category, allowed priority/action, abstention accuracy/precision/recall, retrieval recall at 5, and citation existence against the exact evidence retrieved for the case.
- An expected-source case that fails or abstains before retrieval receives zero retrieval recall instead of disappearing from the denominator.
- Add a versioned citation-support rubric and strict structured output invoked through `LlmProvider` with task `evaluation` and temperature zero where supported.
- Judge generated knowledge-dependent claims only against their cited synthetic excerpts. Require exactly one verdict per citation and reject duplicate/missing/unknown IDs. Judge failures remain visible and contribute zero rather than being silently excluded.
- Aggregate explicit numerators/denominators, stable nearest-rank P50/P95 latency, total/average generation and judge tokens, retries/errors, and optional estimated cost. Treat the judge as advisory and document same-model judging as an MVP limitation.

### 5. Produce one safe report and threshold decision

- Schema-validate a report containing run ID/timestamps, dataset version/hash, provider/model, classification/resolution/judge versions, retrieval/resolution settings, threshold version/values, aggregate metrics, threshold pass/fail records, and stable per-case results.
- Make overall status fail when any configured threshold fails or is unavailable. Per-case operational errors stay represented in the report and naturally lower the relevant metrics.
- Provide shared console-summary formatting for the CLI and a browser-safe report shape for the route/UI.
- Keep live JSON artifacts ignored by Git. The CLI writes its requested file atomically; the web route does not write server files, and the browser creates a download from its validated in-memory response.

### 6. Add the unauthenticated evaluation API

- Add `POST /api/evaluations/run` using an App Router Route Handler. Accept only `{ concurrency? }`, enforce JSON content type/size and Zod validation, and ignore no unknown fields.
- Intentionally perform no login/session check, matching the explicit request. Add `Cache-Control: private, no-store` and return only the safe report envelope.
- Run the shared evaluator synchronously and return `200` even when quality thresholds fail, because that is a valid evaluation result. Return controlled 4xx/5xx errors only for malformed requests, invalid/missing server configuration, fatal dataset/setup failure, or unexpected run failure.
- Enforce one in-process active web evaluation at a time and reject overlap with `409` so an unauthenticated browser cannot accidentally multiply a costly local run. This is process-local protection, not authentication or production rate limiting.
- Log run IDs, status, counts, latency, and error codes only. Close evaluation-owned resources without closing the application-wide database pool from the request handler.

### 7. Build `/admin/evaluations`

- Add a separate Server Component page that renders a clear local-admin shell and a narrow Client Component for interactivity. Add a discoverable link from the existing page header and a return link from the evaluation page.
- Match the existing green/cream/yellow visual language with project-owned Tailwind markup; introduce no component library or styling system.
- Show dataset size/version, model/provider, threshold definitions, a concurrency control, estimated live-call warning, and a single “Run evaluation” action. Clearly label the route as unauthenticated/local-only and live-provider-backed.
- Implement idle, running, completed-pass, completed-regression, validation/configuration/provider/setup failure, and overlapping-run states. Disable duplicate submissions and keep accessible status/alert semantics.
- On completion, show metric cards with numerators/denominators, threshold comparisons, P50/P95 latency, tokens/cost, error counts, and a filterable all/failed case table. Expand a case to show tags, expected category/priority/action/sources/abstention, compact actuals, grader outcomes, judge rationale, and sanitized error—never its ticket, draft, prompt, or evidence excerpt.
- Add a client-side “Download JSON report” action with a deterministic filename. Keep the last response only in component memory; a refresh or server restart clears it by design.

### 8. Keep the required CLI entry point

- Add `scripts/eval.ts` and `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json` over the same evaluation service/graders/report schema.
- Validate missing/duplicate/unknown CLI arguments and the output destination. Preserve stable order and always close the CLI database pool.
- Exit zero only after the report is written and every threshold passes. Still write the report and exit non-zero for quality regressions/case failures; use a concise non-zero fatal path for configuration/dataset/output failures.
- Print the same compact metric/threshold/failure summary without raw tickets, drafts, evidence, prompts, provider payloads, or secrets.

### 9. Add deterministic tests

- Test schemas, JSONL loading, duplicate/mixed-version/size rejection, graders, denominators, percentiles, thresholds, cost calculations, judge ID validation, safe report serialization, and console formatting.
- Test bounded concurrency, stable order, continuation after case errors, and the shared evaluator with fake LLM/retrieval/judge dependencies. Default tests remain network-free and database-free.
- Test the API factory with injected dependencies: strict request validation, no session/auth requirement, no-store response, overlap `409`, threshold-failing `200`, safe error mapping, and absence of sensitive fields.
- Test the evaluation Client Component with Testing Library: start/disabled/running states, pass/regression/error rendering, metric and case filters/details, download behavior, and malformed response handling.
- Preserve existing AI, retrieval, ingestion, route, session, and UI coverage.

### 10. Document and verify

- Update README story status, commands, architecture, dataset/metric definitions, threshold/exit behavior, UI and CLI workflows, pricing option, judge caveat, and artifact policy.
- Explicitly document that `/admin/evaluations` has no authentication, makes costly live calls, should remain local/not publicly exposed, runs synchronously, stores no history, and may be subject to hosting request-duration limits.
- Document migrated/ingested PostgreSQL plus Anthropic/Voyage credentials as live prerequisites.
- If live prerequisites are available, run the suite, record only aggregate measured results plus at least three concise known failure analyses in README, and keep raw live artifacts ignored. Otherwise report the live check as unavailable rather than inventing measurements.
- Run `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`.
- When `TEST_DATABASE_URL` is configured, run `pnpm test:integration`.
- With live prerequisites, run `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`, then run from `/admin/evaluations` with concurrency 3 and confirm both report shapes/metrics match for the same implementation (allowing live nondeterminism).

## Acceptance criteria

1. The repository contains 30–50 unique, schema-valid, synthetic golden cases covering required normal and failure/adversarial classes.
2. One shared server-only service runs the real classification/retrieval/resolution/judge pipeline with bounded concurrency, stable case IDs/order, safe partial failure handling, and no normal resolution persistence.
3. `/admin/evaluations` is a separate, responsive, unauthenticated page from which an engineer can configure bounded concurrency, start one live evaluation, see an honest running state, inspect required metrics/thresholds and failed cases, and download the JSON report.
4. Browser code never imports or receives provider/database clients, credentials, vectors, prompts, ticket text, generated drafts, source excerpts, full provider payloads, SQL, or stack traces.
5. The evaluation API strictly validates input, is non-cacheable, allows one active local run, requires no auth/session, returns valid threshold regressions as report data, and maps fatal failures safely.
6. `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json` uses the same evaluator, produces console and machine-readable output, and exits non-zero when any versioned threshold fails.
7. Reports include auditable schema/category/priority/retrieval/citation/abstention/action metrics plus latency, token, retry/error, optional cost, version/config metadata, and compact expected-versus-actual failures.
8. No evaluation history/comparison, database migration, streaming/background infrastructure, auth system, story 5 action, provider migration, or unrelated product behavior is added.
9. Deterministic tests remain network-free; all required verification commands and exact manual browser steps are reported.

## Manual test checklist for handoff

1. Configure `.env.local`, start PostgreSQL/pgvector, then run `pnpm db:migrate`, `pnpm ingest`, and `pnpm chunks:inspect`.
2. Start `pnpm dev`, open `/admin/evaluations` directly without a cookie/login, and confirm the page labels itself unauthenticated/local-only.
3. Select concurrency 3 and start the run; confirm duplicate submission is disabled, the running state is announced, and a second direct POST receives `409` while the first is active.
4. Confirm completion displays pass/regression status, all required metric denominators and thresholds, latency/tokens/cost status, and case failures without raw ticket/draft/evidence text.
5. Filter to failed cases, expand several rows, and verify expected/actual scores, judge rationale, and sanitized errors are useful and schema-valid.
6. Download the report, parse it as JSON, and confirm every case appears once in dataset order with all run/config/version metadata.
7. Search the HTML, browser bundle, API response, logs, and report for known ticket text and secret/internal field names; confirm none are exposed.
8. Run `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`; confirm it exercises the same metrics/report contract and its exit code matches threshold status.
9. Stop PostgreSQL or remove one provider configuration locally and confirm the page shows a controlled setup failure with no secret details; restore configuration afterward.
10. Refresh after a successful run and confirm no browser run history remains, as documented.
