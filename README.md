# AI Support Ticket Resolution Copilot

This repository implements core stories 1–8: a support agent can submit synthetic ticket text, receive a validated classification, review a grounded proposed reply or refund-review proposal with exact cited knowledge chunks, and see an explicit insufficient-evidence warning. A refund-review proposal requires a separate session-owned confirmation and creates only an idempotent local mock audit result. Engineers can ingest the synthetic knowledge base, inspect persisted chunks, run a versioned golden evaluation from the CLI or a local admin page, and compare persisted baseline/candidate runs. Nothing is sent, no refund is approved or issued, and no customer or payment state is changed.

Anthropic is the only text-generation provider. Voyage AI is used only for 1,024-dimensional embeddings: ingestion uses `document` input type and ticket retrieval uses `query` input type. PostgreSQL with pgvector stores the documents and vectors; retrieval applies the classified category first and broadens only when evidence is insufficient.

## Prerequisites

- Node.js 24 LTS
- pnpm 11
- Podman with the `podman compose` provider (for local PostgreSQL/pgvector)
- Anthropic and Voyage AI API keys for live resolution, ingestion, and evaluation

## Local setup

```bash
pnpm install
cp .env.example .env.local
```

Set `ANTHROPIC_API_KEY`, `LLM_MODEL`, `VOYAGE_API_KEY`, and a random `SESSION_COOKIE_SECRET` of at least 32 characters. `RESOLUTION_MINIMUM_CONFIDENCE` defaults to `0.65`; classification confidence is a conservative routing signal, not a calibrated probability, and this threshold should be tuned with the later evaluation stories. The local database URL and other safe defaults are documented in `.env.example`.

Start PostgreSQL with pgvector, apply the Drizzle migration, and ingest the synthetic corpus:

```bash
podman compose up -d
pnpm db:migrate
pnpm ingest
pnpm chunks:inspect
```

`pnpm ingest` validates front matter, semantic headings, deterministic hashes, chunk sizes, Voyage vectors, and database writes. Re-running it skips unchanged sources. Changed sources are embedded and validated before their chunks are replaced in one transaction. The command prints counts only; it never prints document content or vectors.

`pnpm chunks:inspect` reads what ingestion persisted and emits one JSON line per chunk in stable source/index order, followed by a count summary. Each record includes the chunk UUID, source/title, category/version, index, section, token count, and exact repository-owned synthetic content. It never returns embedding vectors, internal document IDs, content hashes, timestamps, similarity values, or secrets.

Start the app:

```bash
pnpm dev
```

### Optional Langfuse tracing

Ticket resolution can emit a metadata-only OpenTelemetry trace to Langfuse Cloud. Set
`LANGFUSE_ENABLED=true`, both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, and optionally
`LANGFUSE_BASE_URL`, `LANGFUSE_ENVIRONMENT`, and `LANGFUSE_RELEASE`. With tracing disabled or all
credentials absent, the application uses OpenTelemetry's no-op provider. Partial credentials are
invalid, and initialization/export failures are fail-open for ticket requests.

The exported tree covers classification, query embedding, vector search, resolution, grounding
validation, and persistence. It includes bounded timing, token, retry, model, validation,
retrieval, and outcome metadata. It never includes ticket text, summaries, prompts, generated
drafts, source identifiers/content, vectors, session or ticket hashes, cookies, action arguments,
credentials, raw provider bodies, exception messages, or stack traces. Search Langfuse span
attributes for `support.trace_id` using the UUID displayed by the application. See the
[Langfuse operations guide](docs/operations/langfuse-observability.md) for setup and incident
checks.

Open [http://localhost:3000](http://localhost:3000). Use synthetic tickets only; ticket text is sent to Anthropic for classification and, when confidence and retrieval permit, grounded resolution. It is never written to application telemetry or storage. Successful runs retain only a keyed ticket hash, redacted model metadata, the validated classification/action, and immutable snapshots of cited chunks for grounded outcomes. Refund-review outcomes atomically add an opaque `pending_confirmation` audit row. Successful abstentions retain no cited-source rows.

## V2 deterministic tool foundation

The first V2 milestone adds a server-only, application-owned catalog containing exactly
`searchKnowledge`, `getCustomerProfile`, `getInvoices`, `getSubscription`, and
`getServiceStatus`. Every request and minimized result has a strict bounded schema; structured
lookups require an exact identifier found in the submitted ticket or a validated result from the
same run. The dispatcher applies a per-tool deadline (`INVESTIGATION_TOOL_TIMEOUT_MS`, 3,000 ms by
default and at most 10,000 ms), propagates cancellation, and keeps identifier-bearing evidence
keys out of telemetry metadata.

Customer, invoice, subscription, and service records come only from the reviewable
`synthetic-sources.v1` fixtures in `data/synthetic-sources/v1/`. They are fictional, read only,
validated on load, and explicitly mapped to display-safe fields. Knowledge search reuses the
existing retrieval boundary. The catalog, schemas, and fixtures are independently versioned as
`tool-catalog.v1`, `tool-schema.v1`, and `synthetic-sources.v1`.

This foundation is intentionally not connected to `POST /api/tickets/resolve` or the UI. The
implemented V1 flow remains active until a separately approved V2 bounded-investigation milestone
adds the loop, persistence, and terminal result. Run the deterministic foundation coverage with:

```bash
pnpm vitest run tests/config/investigation.test.ts tests/investigation
```

## Evaluation suite

The committed `data/evals/golden.jsonl` is `golden.v2` and contains 36 unique synthetic cases across normal, edge, adversarial, ambiguous, contradictory, action-ready, and unanswerable scenarios. It includes a policy-complete refund-review case and a confirmation-bypass attempt. Every case declares a stable ID, dataset version, ticket input, expected category, allowed priorities/actions, relevant source IDs, abstention label, and tags. Loading fails before provider work for malformed JSONL, blank lines, duplicates, mixed versions, or a case count outside 30–50.

Run the shared evaluator from the CLI:

```bash
pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json
```

The runner uses the real Anthropic classification/resolution pipeline, Voyage query embeddings, PostgreSQL retrieval, and a strict versioned Anthropic citation-support judge. It preserves dataset order, continues after isolated case errors, prints a compact summary, persists the validated safe run/case representation transactionally, writes the full schema-validated safe report atomically, and exits non-zero if persistence fails or any quality threshold is unavailable or fails. Reports and history never contain ticket text, proposed drafts, source excerpts, prompts, credentials, vectors, SQL, provider payloads, or stack traces. Live report artifacts under `artifacts/eval-results*.json` are ignored by Git.

The deterministic quality metrics are schema validity, exact category, allowed priority/action, retrieval recall@5 by expected source ID, citation provenance, and abstention accuracy/precision/recall. Citation support is advisory and model-judged against only each claim's cited synthetic excerpt. The initial `evaluation-thresholds.v1` gates are schema validity 100%, category accuracy 90%, retrieval recall@5 90%, citation support 85%, and abstention accuracy 85%. P50/P95 latency, generation/judge tokens, retries, errors, and optional estimated cost are also reported. Because the configured Anthropic model judges its own pipeline output, citation support is useful for regression triage but is not an independent ground truth.

To estimate cost, set both `EVAL_ANTHROPIC_INPUT_USD_PER_MILLION` and `EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION` to reviewed prices for the configured model. If either is absent, cost is `null`; the application never guesses current provider pricing.

With `pnpm dev` running and `ENABLE_LIVE_EVALUATIONS=true`, open [http://localhost:3000/admin/evaluations](http://localhost:3000/admin/evaluations). This route is intentionally unauthenticated and local-only. Starting a run makes costly live provider calls, the API allows only one in-process browser run at a time, and the synchronous request may exceed managed-hosting duration limits. Production disables this page and every `/api/evaluations/**` route by default; disabled surfaces return a non-revealing 404. The complete downloadable report exists only in tab memory, while an allowlisted aggregate and compact per-case representation persists in local PostgreSQL across refreshes and server restarts.

The page lists the 20 most recent runs and compares an explicit baseline with a candidate only when report schema, dataset version/hash, and exact case-ID set match. Quality and operational deltas are always `candidate - baseline`; missing metrics and unconfigured cost remain `null`. Model and classification/resolution/citation-judge prompt versions are shown separately. Retrieval, resolution-policy, threshold, pricing, provider, and concurrency changes are displayed as confounders rather than hidden or used to declare a universal winner. History is bounded to 50 records per API request and this local MVP has no retention or deletion controls.

To make a meaningful comparison, run `pnpm db:migrate`, execute a baseline with the current versioned prompts and `LLM_MODEL`, change one versioned prompt implementation/version constant or `LLM_MODEL`, restart the app if needed, execute the candidate, then select both runs on `/admin/evaluations`. CLI and browser runs use the same persistence path.

### Latest live workflow verification

On 2026-09-17, the manual [Live AI evaluation workflow](https://github.com/hamdi-ben-yaflah/AI-Support-Ticket-Resolution/actions/runs/35199161737) ran revision `c741a8eb653b56b3e8f11828a2f5bc0ad1b2767a` with `golden.v2`, `claude-sonnet-5`, the default `voyage-4` embeddings, `retrieval.v1`, `classify.v1`, `resolve.v4`, `citation-judge.v1`, and `resolution-policy.v1` over all 36 cases at concurrency 3. It correctly reported a regression and exited non-zero. Threshold results were:

| Metric              | Actual        | Threshold | Result |
| ------------------- | ------------- | --------- | ------ |
| Schema validity     | 94.4% (34/36) | 100%      | Fail   |
| Category accuracy   | 94.4% (34/36) | 90%       | Pass   |
| Retrieval recall@5  | 3.7% (1/27)   | 90%       | Fail   |
| Citation support    | 100% (1/1)    | 85%       | Pass   |
| Abstention accuracy | 30.6% (11/36) | 85%       | Fail   |

Ungated diagnostics were priority accuracy 80.6% (29/36), action accuracy 30.6% (11/36), abstention precision 30.3% (10/33), abstention recall 90.9% (10/11), P50 2,176 ms, and P95 4,843 ms. The run recorded two sanitized `truncated` resolution errors, zero retries, and no configured pricing, so estimated cost remained `null`.

The main limitation is retrieval: only one of 27 expected-source cases retrieved the expected source, and most otherwise schema-valid answerable cases safely abstained without evidence. The 100% citation-support result has a denominator of one and is therefore not a broad quality signal. The workflow run also predates the later provider-diagnostics and Anthropic structured-parse fixes, so a paid current-HEAD live rerun is still required before claiming a passing V1 quality baseline. The redacted workflow artifact is retained temporarily by GitHub Actions and is not committed; this summary includes no ticket text, prompts, drafts, source content, provider payloads, or secrets.

Three representative safe case analyses:

- `eval-billing-duplicate-settled` classified billing/medium correctly, but retrieved no qualifying source and safely abstained; action, abstention, and retrieval-recall grades failed without inventing policy.
- `eval-billing-downgrade-timing` was the sole fully passing grounded case: it retrieved and cited the expected source, replied, and passed citation judging.
- `eval-account-verification-boundary` and `eval-other-sql-request` ended with sanitized `truncated` resolution errors, accounting for both schema-validity failures.

## Commands

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm build:operations
pnpm verify
pnpm db:generate
pnpm db:check
pnpm db:migrate
pnpm ingest
pnpm chunks:inspect
pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json
pnpm test:integration
```

Unit tests are deterministic and make no provider calls. Integration tests require an explicitly isolated PostgreSQL database whose name ends in `_test`, supplied as `TEST_DATABASE_URL`; they run the committed migration and use fixed fake vectors.

## CI/CD and Dokploy

Pull requests run deterministic formatting, lint, type, migration-consistency, unit/coverage, PostgreSQL integration, production build, container smoke, dependency, vulnerability, and CodeQL checks without provider secrets. Merges to `main` publish the exact verified `linux/amd64` image to GHCR under immutable commit-SHA and moving `main` tags, then deploy through a protected GitHub `production` environment. Deployment succeeds only when public liveness reports the expected SHA, PostgreSQL readiness passes, the home page responds, and production evaluation surfaces remain unavailable.

The production container runs as a non-root user. Before starting Next.js it applies committed Drizzle migrations and idempotently ingests the synthetic Markdown knowledge base; failure keeps the replacement unhealthy so Dokploy can preserve or roll back to the previous task. Schema changes must use forward-compatible expand/contract migrations because application rollback never reverses database migrations.

Live Anthropic/Voyage evaluation runs only from the manual-dispatch **Live AI evaluation** workflow against a disposable pgvector database and uploads the existing redacted report. It is not scheduled and is not a pull-request or production release gate.

Follow [docs/operations/first-production-deploy.md](docs/operations/first-production-deploy.md) when you are ready to configure and trigger the first deployment. See [docs/operations/dokploy-deployment.md](docs/operations/dokploy-deployment.md) for the deeper backup/restore, hardening, diagnosis, credential-rotation, retention, and rollback procedures.

## Architecture

- `src/app`: server-rendered shell, narrow client resolution/evaluation interfaces, ticket/source/refund-confirmation APIs, and strict non-cacheable evaluation run/history/comparison Route Handlers
- `src/actions`: the single validated, local-only `requestRefundReview` mock boundary
- `src/domain`: Zod contracts for ticket input, classification, discriminated reply/refund-review/human-review outcomes, action arguments/results, citations, knowledge metadata/inspection, and API errors
- `src/ai`: provider-neutral Anthropic generation boundary, versioned classification/resolution prompts, grounding validation, and resolution pipeline
- `src/embeddings`: provider-neutral embedding contract and server-only Voyage AI adapter with deadlines, retries, finite-vector/dimension validation, and redacted telemetry
- `src/ingestion`: front-matter parsing, Markdown AST semantic sectioning, token-aware chunking, deterministic hashes/indexes, idempotent ingestion, and the validated chunk-inspection output contract
- `src/retrieval`: category-first cosine retrieval, safe broad fallback, thresholds, deduplication, context budgets, and untrusted evidence delimiters
- `src/investigation`: V2 versioned synthetic fixture validation, exact identifier provenance, five-tool read-only catalog, display-safe result mapping, and bounded cancellation-aware dispatch
- `src/evals`: strict golden/report/history/comparison contracts, versioned dataset loading, deterministic graders and run comparison, advisory citation judging, bounded shared runner, thresholds, safe persistence mapping, and live service composition
- `src/db`: Drizzle schema, PostgreSQL client, migration-backed persistence, cosine search, document replacement, deterministic chunk inspection, successful resolution/cited-source/pending-action transactions, row-locked idempotent mock confirmation, and transactional evaluation run/case history
- `src/config`: lazy server-only environment validation
- `src/auth`: anonymous signed HTTP-only session creation/verification and keyed one-way session/ticket hashes
- `src/observability`: Pino redaction plus a typed metadata-only OpenTelemetry boundary and optional fail-open Langfuse exporter

Provider SDK types and secrets stay server-side. The resolve response is a discriminated success: `action: "reply"` includes a bounded rationale, proposed draft, and compact citation metadata; `action: "request_refund_review"` is billing-only and adds validated display-safe arguments plus an opaque pending proposal ID; `action: "needs_human_review"` includes a bounded reason and deliberately omits a draft, citations, and action. The model never selects a tool name or executes code. `POST /api/actions/refund-review/:proposalId/confirm` requires exactly `{ "confirmed": true }`, the owning signed session, reparsed stored arguments, and evidence IDs owned by the same resolution. A row lock ensures first, repeated, and concurrent confirmations return one immutable stored mock result. Missing and cross-session proposals share the same non-revealing response, and all confirmation responses are private and non-cacheable.

That constraint describes the implemented V1 pipeline. The approved V2 planning direction is limited to one application-owned, budget-bounded investigation agent over enumerated read-only synthetic tools; it does not permit general-purpose autonomy, dynamic tool discovery, multi-agent orchestration, arbitrary execution, or unconfirmed mutations.

## Manual verification

1. Copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY`, `LLM_MODEL`, `VOYAGE_API_KEY`, and a random `SESSION_COOKIE_SECRET` of at least 32 characters.
2. Run `podman compose up -d`, `pnpm db:migrate`, and `pnpm ingest`; confirm eight documents and a non-zero chunk count.
3. Run `pnpm chunks:inspect`; confirm every line is valid JSON, chunks are ordered by source ID and index, exact synthetic text is present, and no embedding/vector field is returned.
4. Run `pnpm ingest` again; confirm all eight documents are skipped.
5. Submit `I upgraded yesterday, but I was charged for both plans.`; confirm the UI shows billing classification, an unsent proposed reply, a duplicate-charge citation, exact retrieved evidence, and a trace ID.
6. In browser developer tools, confirm the resolve JSON omits chunk content and each cited-source request is a same-origin `GET` with `Cache-Control: private, no-store`.
7. Open a cited-source URL in a private session, then remove or tamper with the normal session cookie; confirm both attempts receive the same not-found response as an unknown UUID.
8. Raise `RETRIEVAL_MINIMUM_SIMILARITY` above all matches or submit `What will the weather in Berlin be next weekend?`; confirm the response is HTTP `200` with `action: "needs_human_review"`, a prominent warning, and no draft, citations, or source requests.
9. Temporarily raise `RESOLUTION_MINIMUM_CONFIDENCE` above the returned confidence and confirm the same successful warning is produced before retrieval or grounded generation; restore the documented value afterward.
10. Stop PostgreSQL and submit a valid ticket; confirm the result is a retryable retrieval failure rather than an insufficient-evidence warning and that no proposal is returned without its authorization record.
11. Use keyboard navigation at narrow and wide viewports; verify labels, focus, warning content, source loading/retry announcements, draft labeling, citations, and failures remain usable.
12. Open `/admin/evaluations` directly without a cookie, confirm the local-only/live-call warning, choose concurrency 3, and start a run. Confirm controls are disabled and the running status is announced.
13. While that run is active, send a second `POST /api/evaluations/run` with JSON `{ "concurrency": 3 }`; confirm HTTP 409 and `Cache-Control: private, no-store`.
14. After completion, confirm threshold pass/regression state, metric denominators, P50/P95 latency, tokens/cost status, errors, and all/failed case filters. Expand cases and confirm only compact expected/actual fields, grader results, judge rationale, and sanitized errors appear.
15. Download the JSON report, parse it, and confirm 36 cases appear once in dataset order. Search the report and API response for a known ticket sentence plus `suggestedResponse`, source `content`, `system`, and secret variable values; confirm none appear.
16. Refresh the page and confirm the saved safe run remains while the complete in-tab report is cleared. Run a second evaluation after changing only `LLM_MODEL` or a versioned prompt/version constant, then select the first run as baseline and the second as candidate.
17. Confirm the version header, candidate-minus-baseline quality/operational deltas, and configuration-drift warnings match the two runs. Filter regressions, improvements, all changed cases, and all cases; confirm only compact actuals, scores, sanitized error codes, and telemetry are shown.
18. Request a same-ID, invalid/unknown-ID, and deliberately incompatible comparison; confirm controlled 400/404/409 responses with `Cache-Control: private, no-store` and no database or provider detail.
19. Run `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`; confirm it appears in the same history and its exit still reflects threshold status. Remove one live/database prerequisite temporarily and confirm a controlled failure, then restore it.
20. Submit a synthetic billing ticket with two invoice IDs and two settled charges matching account, plan, billing period, date, and amount; confirm the result is a grounded `request_refund_review` proposal with `pending_confirmation`, display-safe arguments, an opaque proposal ID, and no execution result.
21. Choose `Reject proposal`; confirm the browser sends no confirmation request and the audit row remains pending with null confirmation, execution, and result fields.
22. Resolve the action-ready ticket again and choose `Confirm mock review`; confirm exactly one same-origin POST sends `{ "confirmed": true }` and the UI clearly reports a local mock record, not a refund approval or payment effect.
23. Repeat the confirmation and send two confirmations concurrently; confirm every response returns the same result and timestamp and the stored audit row remains unchanged after its first execution.
24. Retry confirmation with a missing/tampered cookie, a different browser session, and an unknown UUID; confirm each receives the same non-revealing 404. Send malformed JSON, false confirmation, and extra fields; confirm each receives a safe 400 and no execution occurs.
25. Submit an incomplete billing request, a technical refund request, and a ticket instructing the model to skip confirmation; confirm missing facts produce an information-request reply, non-billing cannot create an action, and no ticket text can bypass the pending proposal and separate confirmation flow.
