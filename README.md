# AI Support Ticket Resolution Copilot

This repository implements core stories 1–4 and 6–8: a support agent can submit synthetic ticket text, receive a validated classification, and either review a grounded proposed reply with exact cited knowledge chunks or see an explicit insufficient-evidence warning. Engineers can ingest the synthetic knowledge base, inspect persisted chunks, run a versioned golden evaluation from the CLI or a local admin page, and compare persisted baseline/candidate runs. Replies require human review; nothing is sent and no customer action is performed.

Anthropic is the only text-generation provider. Voyage AI is used only for 1,024-dimensional embeddings: ingestion uses `document` input type and ticket retrieval uses `query` input type. PostgreSQL with pgvector stores the documents and vectors; retrieval applies the classified category first and broadens only when evidence is insufficient.

## Prerequisites

- Node.js 20 or newer
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

Open [http://localhost:3000](http://localhost:3000). Use synthetic tickets only; ticket text is sent to Anthropic for classification and, when confidence and retrieval permit, grounded resolution. It is never written to application telemetry or storage. Successful runs retain only a keyed ticket hash, redacted model metadata, the validated classification/action, and immutable snapshots of cited chunks for replies. Successful abstentions retain no cited-source rows.

## Evaluation suite

The committed `data/evals/golden.jsonl` contains 36 unique synthetic cases across normal, edge, adversarial, ambiguous, contradictory, and unanswerable scenarios. Every case declares a stable ID, dataset version, ticket input, expected category, allowed priorities/actions, relevant source IDs, abstention label, and tags. Loading fails before provider work for malformed JSONL, blank lines, duplicates, mixed versions, or a case count outside 30–50.

Run the shared evaluator from the CLI:

```bash
pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json
```

The runner uses the real Anthropic classification/resolution pipeline, Voyage query embeddings, PostgreSQL retrieval, and a strict versioned Anthropic citation-support judge. It preserves dataset order, continues after isolated case errors, prints a compact summary, persists the validated safe run/case representation transactionally, writes the full schema-validated safe report atomically, and exits non-zero if persistence fails or any quality threshold is unavailable or fails. Reports and history never contain ticket text, proposed drafts, source excerpts, prompts, credentials, vectors, SQL, provider payloads, or stack traces. Live report artifacts under `artifacts/eval-results*.json` are ignored by Git.

The deterministic quality metrics are schema validity, exact category, allowed priority/action, retrieval recall@5 by expected source ID, citation provenance, and abstention accuracy/precision/recall. Citation support is advisory and model-judged against only each claim's cited synthetic excerpt. The initial `evaluation-thresholds.v1` gates are schema validity 100%, category accuracy 90%, retrieval recall@5 90%, citation support 85%, and abstention accuracy 85%. P50/P95 latency, generation/judge tokens, retries, errors, and optional estimated cost are also reported. Because the configured Anthropic model judges its own pipeline output, citation support is useful for regression triage but is not an independent ground truth.

To estimate cost, set both `EVAL_ANTHROPIC_INPUT_USD_PER_MILLION` and `EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION` to reviewed prices for the configured model. If either is absent, cost is `null`; the application never guesses current provider pricing.

With `pnpm dev` running, open [http://localhost:3000/admin/evaluations](http://localhost:3000/admin/evaluations). This route is intentionally unauthenticated and local-only. Starting a run makes costly live provider calls, the API allows only one in-process browser run at a time, and the synchronous request may exceed managed-hosting duration limits. Do not publicly deploy this admin surface as-is. The complete downloadable report exists only in tab memory, while an allowlisted aggregate and compact per-case representation persists in local PostgreSQL across refreshes and server restarts.

The page lists the 20 most recent runs and compares an explicit baseline with a candidate only when report schema, dataset version/hash, and exact case-ID set match. Quality and operational deltas are always `candidate - baseline`; missing metrics and unconfigured cost remain `null`. Model and classification/resolution/citation-judge prompt versions are shown separately. Retrieval, resolution-policy, threshold, pricing, provider, and concurrency changes are displayed as confounders rather than hidden or used to declare a universal winner. History is bounded to 50 records per API request and this local MVP has no retention or deletion controls.

To make a meaningful comparison, run `pnpm db:migrate`, execute a baseline with the current versioned prompts and `LLM_MODEL`, change one versioned prompt implementation/version constant or `LLM_MODEL`, restart the app if needed, execute the candidate, then select both runs on `/admin/evaluations`. CLI and browser runs use the same persistence path.

### Latest local live verification

On 2026-09-12, `claude-sonnet-5`, `voyage-4`, `retrieval.v1`, and `resolution-policy.v1` were run over all 36 cases at concurrency 3. The result was correctly reported as a regression and the CLI exited non-zero: schema validity 30.6% (11/36), category accuracy 30.6% (11/36), priority accuracy 25.0% (9/36), retrieval recall@5 0.0% (0/27), abstention accuracy 13.9% (5/36), P50 5,568 ms, and P95 6,485 ms. Citation support was unavailable because no reply reached citation judging. There were 25 sanitized case errors; local telemetry identified Voyage HTTP 429 rate limiting as the dominant cause. Pricing was not configured, so estimated cost remained `null`. This is one environment-specific measurement, not a product guarantee, and its raw ignored report is not checked in.

Three representative failure analyses:

- `eval-billing-duplicate-settled` classified billing/medium correctly, but no chunk cleared the 0.65 similarity threshold. The pipeline safely abstained, so action, abstention, and retrieval-recall grades failed without inventing policy.
- `eval-adversarial-ignore-billing` produced a sanitized `retrieval_unavailable` case error after Voyage rate limiting. The runner continued and exposed the failure without ticket text or provider detail in the report.
- `eval-contradictory-refund-date` correctly classified and abstained via low confidence, but still received zero retrieval recall because an expected-source case bypassed retrieval. This is intentional: early abstention cannot silently disappear from the retrieval denominator.

## Commands

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm ingest
pnpm chunks:inspect
pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json
pnpm test:integration
```

Unit tests are deterministic and make no provider calls. Integration tests require an explicitly isolated PostgreSQL database whose name ends in `_test`, supplied as `TEST_DATABASE_URL`; they run the committed migration and use fixed fake vectors.

## Architecture

- `src/app`: server-rendered shell, narrow client resolution/evaluation interfaces, ticket/source APIs, and strict non-cacheable evaluation run/history/comparison Route Handlers
- `src/domain`: Zod contracts for ticket input, classification, discriminated reply/human-review outcomes, citations, knowledge metadata/inspection, and API errors
- `src/ai`: provider-neutral Anthropic generation boundary, versioned classification/resolution prompts, grounding validation, and resolution pipeline
- `src/embeddings`: provider-neutral embedding contract and server-only Voyage AI adapter with deadlines, retries, finite-vector/dimension validation, and redacted telemetry
- `src/ingestion`: front-matter parsing, Markdown AST semantic sectioning, token-aware chunking, deterministic hashes/indexes, idempotent ingestion, and the validated chunk-inspection output contract
- `src/retrieval`: category-first cosine retrieval, safe broad fallback, thresholds, deduplication, context budgets, and untrusted evidence delimiters
- `src/evals`: strict golden/report/history/comparison contracts, versioned dataset loading, deterministic graders and run comparison, advisory citation judging, bounded shared runner, thresholds, safe persistence mapping, and live service composition
- `src/db`: Drizzle schema, PostgreSQL client, migration-backed persistence, cosine search, document replacement, deterministic chunk inspection, successful resolution/cited-source snapshots, and transactional evaluation run/case history
- `src/config`: lazy server-only environment validation
- `src/auth`: anonymous signed HTTP-only session creation/verification and keyed one-way session/ticket hashes

Provider SDK types and secrets stay server-side. The resolve response is a discriminated success: `action: "reply"` includes a bounded rationale, proposed draft, and compact citation metadata; `action: "needs_human_review"` includes a bounded reason and deliberately omits a draft and citations. Low classification confidence, below-threshold retrieval, or model-detected ambiguity/contradiction can produce the human-review outcome. Retrieval/database/embedding unavailability remains a retryable service error, not an abstention. Exact chunk content remains server-side until the browser requests a cited chunk with its signed anonymous session cookie. The source endpoint returns only chunk ID, stable source ID, document title, section, and the immutable cited excerpt; missing, tampered, expired, cross-session, uncited, and unknown access is denied with the same non-revealing response. Source and evaluation-history responses are private and non-cacheable. Accounts and controlled actions/audits remain out of scope.

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
