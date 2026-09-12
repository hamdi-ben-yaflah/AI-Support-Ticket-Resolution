# Eighth core user story: compare evaluation results by prompt and model version

## Goal

Implement PRD story 8 so an engineer can use the existing `/admin/evaluations` surface to compare two persisted evaluation runs and understand how model and versioned prompt changes affected aggregate quality, operations, and individual golden cases.

Both the browser-triggered workflow and `pnpm eval` will continue to use the current shared live evaluator. After a report is fully generated and schema-validated, the configured service will persist only its existing safe metadata, metrics, and compact case results. The UI will load recent runs, identify their model and prompt versions, and produce an explicit baseline-to-candidate comparison.

## Scope decisions

- The repository route is `/admin/evaluations` (plural), so story 8 will extend that existing page rather than introduce the singular `/admin/evaluation` alias or a second evaluation UI.
- Comparing by prompt/model version means comparing saved run outputs whose metadata already records the generation model plus classification, resolution, and citation-judge prompt versions. Engineers produce variants through normal versioned source/config changes and then run the suite again.
- The browser will not accept arbitrary prompt text, prompt file paths, provider names, API keys, or unvalidated model IDs. Runtime prompt editing, model routing, and automatic experiment matrices are outside this story.
- Comparison is valid only for runs with the same report schema, exact dataset version/hash, and identical case-ID set. The UI will reject incompatible pairs instead of presenting misleading deltas.
- Differences in retrieval, resolution-policy, threshold, or pricing configuration do not prevent comparison, but they will be surfaced prominently as confounders.
- Preserve the existing unauthenticated, local-only admin posture. This story does not add accounts, roles, session ownership, or production exposure hardening.
- Keep a bounded recent-history view and no retention/delete controls. Database cleanup policy and evaluation-run deletion are not required for this local portfolio MVP.

## Requirements traced to the repository

- PRD story 8: compare evaluation results by prompt and model version.
- PRD evaluation experience: retain classification, schema, citation, abstention, latency, token/cost, and failed-case visibility.
- Technical specification sections 7 and 16: store aggregate evaluation configuration and per-case scores while retaining provider, model, prompt, retrieval, threshold, and dataset versions.
- `AGENTS.md` data model: add `evaluation_runs` and `evaluation_results` through Drizzle, validate stored JSON, keep SQL/database imports in `src/db`, and never persist raw ticket text, prompts, provider responses, or source content.
- Existing story-7 decision: reuse the shared evaluator for browser and CLI; comparison/history was explicitly deferred to this story.
- Next.js 16 guidance reviewed while planning: keep database reads in server-only code, expose browser access through App Router Route Handlers, keep interactive selectors in a narrow Client Component, and return uncached history/comparison responses.

## Current repository baseline

- The worktree is clean at planning time. Story 7 is committed in `844243b`.
- `/admin/evaluations` currently starts one synchronous live run, validates the safe `evaluation-report.v1` response, displays aggregate metrics and case details, and offers a client-side JSON download.
- `POST /api/evaluations/run` is strict, non-cacheable, unauthenticated, and guarded against overlapping in-process browser runs. It does not persist the completed report.
- `pnpm eval` calls the same configured service and writes an ignored JSON artifact, but no database history is created.
- `EvaluationReportSchema` already records the run UUID, timestamps, dataset version/hash, generation provider/model, three prompt versions, retrieval and resolution-policy configuration, thresholds, metrics, and compact per-case actuals/scores/telemetry/errors. It omits ticket text, generated drafts, excerpts, prompts, provider payloads, and secrets.
- The Drizzle schema currently contains documents/chunks and resolution-run/source tables only. There are no evaluation tables, repositories, list/compare APIs, or comparison contracts.
- The existing UI copy and README explicitly say that history and comparison do not exist; those statements must be replaced as part of this story.

## In scope

- Transactional PostgreSQL persistence for safe completed evaluation reports and per-case comparison data.
- Persistence from both configured CLI and browser runs without making the pure evaluation runner depend on PostgreSQL.
- A bounded recent-run listing and a deterministic baseline-to-candidate comparison service.
- Strict, non-cacheable list and comparison Route Handlers with safe error mapping.
- An extension of `/admin/evaluations` that preserves current run/report inspection and adds recent history, baseline/candidate selection, version/config context, metric deltas, and case regressions/improvements.
- Drizzle migration, deterministic unit/component/route tests, isolated PostgreSQL integration coverage, documentation, and normal repository verification.

## Out of scope

- Arbitrary browser-supplied prompt text or model identifiers, prompt editors, playgrounds, provider routing/fallback, experiment grids, or automated winner selection.
- Running two variants concurrently, background jobs, queues, streaming progress, cancellation, or scheduled evaluations.
- Authentication, roles, protected admin routing, per-user ownership, public deployment hardening, or remote sharing.
- Charts across more than two runs, statistical significance claims, confidence intervals, judge calibration changes, or automatic threshold/prompt tuning.
- Run deletion, retention settings, export formats beyond the existing JSON report, import of historical artifact files, or backfilling the previously generated ignored artifact.
- Changes to the golden dataset, prompts, retrieval thresholds, evaluation graders, story-5 actions, or production resolution behavior merely to improve scores.

## Implementation plan

### 1. Define storage and comparison contracts

- Add strict Zod contracts under `src/evals` for a persisted run summary, compact persisted case data, recent-run list responses, comparison requests, configuration-difference labels, aggregate metric deltas, operational deltas, and per-case change outcomes.
- Keep the existing `evaluation-report.v1` response backward-compatible. Derive storage records from a validated report rather than expanding the browser report with database fields.
- Represent deltas consistently as `candidate - baseline`; preserve `null` when either metric or cost is unavailable and retain each side's numerator/denominator for auditability.
- Classify case changes as `regressed`, `improved`, `changed`, or `unchanged`. A pass-to-fail transition is a regression, fail-to-pass is an improvement, and other actual/score/error changes are changed without implying improvement.
- Require different baseline/candidate run IDs, exact schema/dataset/hash/case-set compatibility, and validated timestamps/UUIDs. Return a controlled incompatibility result rather than calculating across different datasets.

### 2. Add Drizzle evaluation tables and migration

- Extend `src/db/schema.ts` and generate one new committed Drizzle migration for `evaluation_runs` and `evaluation_results`.
- `evaluation_runs` will use the report run UUID and store dataset identity, prompt versions, provider, explicit generation/judge model identifiers, retrieval/resolution configuration, thresholds, timestamps, and a schema-valid aggregate summary.
- `evaluation_results` will use a generated UUID, reference its run with cascade deletion, and store the stable case ID, compact actual, scores, pass state, latency, token/retry telemetry, and sanitized error. It will not store ticket text, expected ticket input, generated reply text, source excerpts, judge prompt text, credentials, vectors, SQL, or full provider output.
- Add uniqueness for `(evaluation_run_id, case_id)`, recent-run and run/case indexes, non-empty/version checks, non-negative telemetry checks, and completed-at ordering constraints that can be enforced in PostgreSQL.
- Keep all SQL and Drizzle client access in `src/db` and use database-generated identifiers/timestamps only where they do not conflict with the report's stable run identity and measured timestamps.

### 3. Implement the evaluation-run repository

- Add a server-only repository that validates a complete report, maps it to allowlisted rows, and inserts the run and all case results in one transaction. A duplicate run UUID must be idempotently recognized only when stored content is equivalent; conflicting reuse is an error.
- Add a bounded recent-run query, ordered by completion time and UUID for deterministic results, returning summary metadata only.
- Add a query that loads exactly two requested runs and their cases without N+1 reads. Parse all JSONB values through Zod before they leave the data layer; malformed or missing stored data becomes a controlled repository error.
- Add narrowly scoped test cleanup helpers keyed by explicit run UUIDs for isolated integration tests.

### 4. Persist configured evaluations from both entry points

- Keep `runEvaluation` pure and database-free for deterministic tests.
- Update `runConfiguredEvaluation` to schema-validate the completed report, persist it transactionally, and return the same report. Since both the Route Handler and CLI already call this service, both workflows will create comparable history without duplicate orchestration.
- Treat persistence failure as a controlled evaluation setup/internal failure: never claim a run is available for comparison when it was not committed. Keep logging limited to run ID, status, counts, timing, and safe error codes.
- Preserve current CLI JSON writing and threshold-based exit behavior after persistence; no generated artifacts or provider data are committed.

### 5. Build a deterministic comparison service

- Add a provider-neutral comparison function that accepts two validated stored runs, checks compatibility, identifies model/prompt changes, and lists any retrieval, policy, threshold, pricing, provider, or concurrency differences.
- Compare every quality metric with its baseline/candidate values and delta. Compare P50/P95 latency, total generation/judge tokens, retries, errors, and optional estimated cost without turning operational movement into an unsupported quality judgment.
- Join cases by stable case ID and compare pass state, compact actual classification/action/model/prompt metadata, grader scores, telemetry, and sanitized error codes. Return deterministic case-ID order and summary counts for regressions, improvements, changed, and unchanged cases.
- Do not rank a model as universally better, calculate statistical significance, or conceal configuration drift.

### 6. Add history and comparison APIs

- Add `GET /api/evaluations/runs` with a strict bounded `limit` query (safe default, maximum 50) that returns recent summary records only.
- Add `GET /api/evaluations/compare?baseline=<uuid>&candidate=<uuid>` that validates query parameters, loads the pair, invokes the comparison service, and distinguishes invalid input, missing runs, incompatible runs, configuration/database failure, and unexpected failure with safe `ApiResult` envelopes.
- Keep both endpoints intentionally unauthenticated to match the existing local-only admin page, use `Cache-Control: private, no-store`, and never return ticket text, generated drafts, excerpts, prompts, database internals, or stack traces.
- Retain dependency-injected handler factories so route behavior remains deterministic and network/database-free in the default unit suite.

### 7. Extend the existing `/admin/evaluations` experience

- Preserve the current run controls, live status, report metrics, case inspection, and download behavior.
- Add a focused history/comparison Client Component rather than growing the current console into one large component. It will load recent runs on mount and refresh after a successful new run.
- Show each run's completion time, pass/regression status, dataset, provider/model, classification/resolution/judge prompt versions, and compact headline metrics. Default to the two most recent compatible runs when possible while keeping explicit baseline and candidate selectors.
- Display a clear version header showing exactly what changed, configuration-drift warnings, side-by-side baseline/candidate values, signed deltas, and accessible improvement/regression labels. Use a compact table rather than adding a chart library.
- Add filters for regressions, improvements, all changed cases, and all cases. Per-case rows will show pass transitions, changed actual category/priority/action, changed grader values, latency/token movement, and sanitized error-code movement without exposing the original ticket or generated content.
- Handle no history, one run only, loading, malformed response, unavailable database, missing/deleted selection, incompatible pair, and successful comparison states. Keep responsive keyboard-accessible controls and the existing project-owned Tailwind visual language.

### 8. Add deterministic and database-backed tests

- Unit-test report-to-storage mapping, nullable/signed metric deltas, case outcome classification, deterministic ordering, configuration-drift detection, and rejection of incompatible datasets/case sets.
- Route-test strict limits/UUIDs, no-store headers, list success, not-found/incompatible comparison responses, safe database/configuration failures, and absence of sensitive fields using injected dependencies.
- Component-test history loading, two-run selection, default compatible pair, version labels, signed deltas, regressions/improvements filters, refresh after a completed live run, and all empty/error/incompatible states with mocked fetch responses.
- Add an isolated PostgreSQL integration test that runs the committed migrations, verifies transactional run/case persistence, deterministic recent ordering, pair loading, uniqueness/idempotency behavior, and cleanup by explicit test run IDs.
- Preserve the existing network-free evaluation, AI, retrieval, ingestion, session, route, and UI tests.

### 9. Document and verify

- Update README story status, architecture, migration/setup steps, CLI/browser persistence behavior, comparison semantics, compatibility rules, configuration-drift warnings, local-only security posture, and lack of deletion/retention controls.
- Replace statements that refresh/server restart clears all history; clarify that the current in-tab report state is transient but validated safe summaries/results persist in local PostgreSQL.
- Document how to create meaningful prompt/model comparisons: migrate, run a baseline, change a versioned prompt or `LLM_MODEL`, run the candidate, then select both runs in `/admin/evaluations`.
- Run `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`.
- When `TEST_DATABASE_URL` is configured, run `pnpm test:integration`.
- With live provider/database prerequisites, run `pnpm db:migrate`, execute at least two intentionally version-distinct evaluations through the existing CLI/browser workflow, and manually verify the comparison. If live credentials are unavailable, report that check as unavailable rather than fabricating results.

## Acceptance criteria

1. A successfully configured browser or CLI evaluation persists one validated `evaluation_runs` row and one `evaluation_results` row per golden case in a single transaction.
2. Stored history contains the exact dataset, provider/model, classification/resolution/judge prompt, retrieval/policy, threshold, time, metric, and compact per-case information needed for comparison, while forbidden raw/sensitive content is absent.
3. Recent history is bounded, deterministic, non-cacheable, and visible after browser refresh or server restart as long as PostgreSQL data remains.
4. An engineer can select a baseline and candidate on `/admin/evaluations` and see their prompt/model versions, configuration drift, aggregate quality/operational values and signed deltas, and deterministic per-case regressions/improvements.
5. Runs with different report schemas, dataset versions/hashes, or case-ID sets are not compared; the API/UI explains incompatibility without leaking internal details.
6. The existing live-run UI, safe report response/download, overlap protection, CLI JSON artifact, and threshold exit code continue to work.
7. History/comparison endpoints strictly validate inputs, use `ApiResult`, set `Cache-Control: private, no-store`, remain local-only/unauthenticated by explicit scope, and expose no tickets, drafts, source text, prompts, credentials, provider payloads, SQL, or stack traces.
8. No prompt editor, arbitrary browser model control, provider routing, automated experiment loop, chart dependency, deletion/retention system, authentication system, or unrelated product behavior is added.
9. Deterministic tests stay network-free, database behavior is covered by the isolated integration suite, and all required verification results plus exact manual steps are reported.

## Manual test checklist for handoff

1. Configure `.env.local`, start PostgreSQL/pgvector, run `pnpm db:migrate`, and run `pnpm ingest`.
2. Open `/admin/evaluations` and confirm the current live-run workflow remains usable and the history area initially shows an honest zero/one-run state.
3. Set a known baseline `LLM_MODEL`, run the complete evaluation, and confirm the completed run appears in history with the expected model and three prompt versions; refresh and confirm it remains.
4. Change only `LLM_MODEL` or a versioned prompt implementation/version constant, restart as required, run a candidate evaluation, and select the baseline and candidate.
5. Confirm the comparison labels baseline versus candidate, uses candidate-minus-baseline deltas, shows aggregate quality and operational changes, and calls out every non-model/prompt configuration difference.
6. Filter case changes to regressions and improvements; inspect examples and confirm pass transitions, changed compact actuals/scores/errors, and latency/token deltas match the two stored reports.
7. Attempt to compare the same UUID, an invalid/unknown UUID, and a deliberately incompatible dataset run fixture; confirm controlled UI/API errors and no internal data leakage.
8. Trigger a new browser evaluation after history is loaded and confirm history refreshes without losing the completed report inspection/download state.
9. Run `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`; confirm its run is added to the same history and its process exit still matches threshold status.
10. Inspect evaluation tables, list/compare JSON, rendered HTML, browser bundle, and logs for a known synthetic ticket sentence plus `suggestedResponse`, source `content`, prompt bodies, and secret values; confirm none are present.
