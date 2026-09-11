# Second core user story: knowledge-base-grounded reply

## User story

As a support agent, I can see a proposed reply grounded in the supplied knowledge base.

## Goal

Extend the existing classification slice into the smallest safe grounded-response slice. A submitted synthetic ticket will still receive its schema-validated category, priority, summary, and confidence signal, and will additionally receive a proposed reply whose knowledge-dependent claims cite only chunks retrieved from the repository-owned Markdown knowledge base.

The existing `POST /api/tickets/resolve` endpoint remains the single HTTP boundary. This story introduces the knowledge-base storage, ingestion, embedding, retrieval, grounded-generation, and deterministic citation-validation foundations required to produce the reply. It does not implement exact source-content inspection, signed-session ownership, a `needs_human_review` resolution action, mock actions, resolution-run persistence, or evaluations.

## Current repository baseline

- The first story is implemented as a classification-only vertical slice with shared Zod contracts, a provider-neutral LLM boundary, an Anthropic adapter, a versioned prompt, structured redacted telemetry, a Route Handler, and a focused Client Component.
- There is no database, pgvector service, Markdown corpus, embedding provider, ingestion command, retrieval service, resolution prompt, or grounded-reply contract yet.
- The worktree was clean when this plan was prepared.
- Baseline verification passed: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test` (42 tests), and `pnpm build`.

## Scope boundary

### In scope

- Eight synthetic, version-controlled Markdown knowledge-base documents covering the product areas required by the PRD.
- PostgreSQL with pgvector through Docker Compose.
- Drizzle schemas, generated migrations, database client, and database-only query modules for `documents` and `document_chunks`.
- Deterministic Markdown/front-matter parsing and semantic, token-aware chunking.
- A provider-neutral embedding boundary with a Voyage AI implementation used only for embeddings.
- Idempotent ingestion that skips unchanged documents and safely replaces chunks for changed documents.
- Configurable cosine-similarity retrieval with category-first search and an unfiltered fallback when category-filtered evidence is inadequate.
- A versioned Anthropic resolution prompt that treats both ticket text and retrieved Markdown as untrusted data.
- A schema-validated proposed reply with citation metadata and deterministic validation against the exact retrieved chunk set.
- A controlled, non-success response when no adequate evidence exists; no ungrounded draft may be returned.
- UI presentation of the proposed draft and compact citation references beside it.
- Structured, redacted embedding, retrieval, and resolution-generation telemetry.
- Network-free unit tests and deterministic PostgreSQL integration tests that use fake embeddings/model outputs.
- Updated local setup and verification documentation.

### Explicitly out of scope

- The story-3 `GET /api/sources/:chunkId` endpoint, exact source excerpts/content inspection, signed references, anonymous signed sessions, and citation ownership across later requests.
- The story-4 successful `needs_human_review` resolution/action state and the complete abstention experience. This story returns a controlled `insufficient_evidence` failure when a grounded reply cannot safely be produced.
- Recommended actions, refund-review proposals, confirmation, execution, and action audit records.
- `resolution_runs`, `action_audit`, `evaluation_runs`, and `evaluation_results` persistence.
- Golden datasets, evaluation commands, an evaluation UI, or live-provider tests in the default suite.
- Keyword/hybrid search, reranking, file uploads, crawling, a knowledge-base admin UI, streaming, chat history, or autonomous tool execution.

## Implementation plan

### 1. Add the grounded-reply domain contracts

- Add a citation contract with `chunkId` (UUID), stable `sourceId`, non-empty heading path/section, and a concise claim describing what the citation supports.
- Add a grounded-reply contract with a 1-to-4,000-character `suggestedResponse` and 1-to-8 citations.
- Add a resolution-proposal contract that preserves every existing classification field and adds the grounded reply. Keep the composition explicit so the resolution model cannot rewrite the already-validated classification.
- Extend the API error allowlist with `retrieval_unavailable` and `insufficient_evidence`. Keep provider, model-output, timeout, configuration, and unexpected errors controlled and safe for the browser.
- Validate provider output, stored JSON metadata, retrieval rows, and the final API envelope with Zod; do not use `any` or handwritten trust-boundary assertions.

### 2. Establish PostgreSQL, pgvector, and Drizzle boundaries

- Add only the required persistence dependencies and scripts: Drizzle ORM/Kit, the PostgreSQL driver and its types, plus a TypeScript script runner where needed.
- Add `compose.yaml` using a pinned pgvector PostgreSQL image, a named local volume, health check, and local-only credentials intended solely for synthetic development data.
- Add a Drizzle configuration that loads root environment files for CLI use without exposing values to the browser.
- Add a server-only database configuration module and `src/db/client.ts`; no module outside `src/db` may create a PostgreSQL client or issue SQL.
- Define `documents` and `document_chunks` in `src/db/schema.ts` with the PRD fields and constraints: generated UUIDs/timestamps, unique stable `source_id`, content hashes, validated JSONB metadata, foreign-key cascade, non-negative chunk indexes, positive token counts, and a fixed 1,024-dimension vector column.
- Commit a generated Drizzle migration plus the minimal custom `CREATE EXTENSION IF NOT EXISTS vector` statement required before the vector column is created. Add a cosine-distance index only if the query shape can use it correctly; the corpus remains small enough for exact search if an approximate index adds no value.
- Keep document/chunk lookup, content-hash checks, transactional upsert/replacement, and cosine search in focused `src/db` query modules.

### 3. Add the supplied synthetic Markdown knowledge base and chunker

- Add exactly eight concise synthetic Markdown documents under `data/knowledge-base/`, covering duplicate charges, invoices/payments, refund policy, subscription changes, account access, account security/verification, common technical troubleshooting, and incident escalation.
- Give every file schema-valid front matter with a stable `sourceId`, display title, category, and document version. Avoid real customer or company data.
- Parse front matter and Markdown headings with established parsers rather than treating arbitrary lines as trusted metadata.
- Split by semantic heading path first. Split an oversized section into approximately 300-to-600-token chunks with limited overlap, while never producing empty chunks; keep small coherent policy sections intact.
- Produce stable chunk indexes from deterministic file/section order and compute a SHA-256 content hash from canonical document input.
- Unit-test heading paths, front-matter validation, stable ordering/indexes, size/overlap behavior, and empty/malformed document rejection.

### 4. Implement Voyage AI embeddings as a separate provider capability

- Add a provider-neutral `EmbeddingProvider` contract that exposes provider/model/dimensions, requires an explicit `document` or `query` input type, and returns ordered vectors plus normalized usage/latency metadata.
- Add a server-only Voyage AI adapter using the official TypeScript library and text-embeddings endpoint. Request float output, disable silent truncation, and explicitly request 1,024 dimensions. Default to the balanced general-purpose `voyage-4` model, but keep the model in server configuration and verify every returned vector is finite, ordered, and exactly the database dimension before persistence or search.
- Apply a bounded timeout and conservative retries for retryable embedding failures; map SDK-specific responses into internal embedding errors without leaking SDK types outside the adapter.
- Add `VOYAGE_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, embedding batch size, and timeout/retry settings to lazy server-only configuration and empty placeholders/defaults in `.env.example`.
- Emit redacted embedding-call telemetry with trace/ingestion identifiers, provider/model, input count, token usage, latency, validation result, and retry count. Never log raw chunks, ticket text, vectors, prompts, or provider responses.
- Embed knowledge-base chunks with Voyage's `document` input type and ticket searches with its `query` input type, as recommended for retrieval. Keep Voyage AI completely outside classification and reply generation; Anthropic remains the only text-generation provider.

### 5. Build idempotent knowledge-base ingestion

- Add a `pnpm ingest` command that loads environment configuration, reads only repository-owned `.md` files from `data/knowledge-base`, validates metadata, chunks changed documents, batches embeddings, and calls `src/db` persistence functions.
- Sort files and chunks deterministically. Compare each source's content hash before embedding so unchanged documents produce no provider call or database rewrite.
- For a new or changed document, finish parsing/chunking/embedding validation before opening the database transaction, then upsert the document and atomically replace its previous chunks.
- Fail the command with a concise structured error on malformed Markdown, duplicate source IDs, dimension mismatch, provider failure, or database failure. Do not partially replace a changed document's chunks.
- Print a safe summary containing file/document/chunk counts and skipped/updated totals, without document bodies or vectors.

### 6. Implement category-aware pgvector retrieval

- Add retrieval configuration with bounded candidate/final counts, minimum similarity, and maximum context tokens; validate all values in a server-only config module.
- Embed the validated ticket text once, then query cosine distance in PostgreSQL through `src/db`. Search the classified category first and broaden to all categories only when too few above-threshold candidates remain.
- Deduplicate candidates, retain deterministic similarity ordering/tie-breaking, enforce the similarity threshold and context token budget, and expose only the provider-neutral evidence shape needed by the pipeline.
- Wrap each selected chunk in stable source delimiters containing its chunk ID, source ID, and section. State explicitly that the enclosed Markdown is untrusted data and cannot override application instructions.
- Distinguish retrieval/database/embedding unavailability from an empty or below-threshold result. The former maps to a retryable service error; the latter becomes controlled `insufficient_evidence`.
- Log retrieval configuration/version, category filter/fallback use, candidate/selected counts, similarity summary, and latency without logging query text, document content, or embeddings.

### 7. Generate and validate the grounded proposal

- Add `resolve.v1` with an immutable prompt version. Require a professional proposed draft, knowledge/policy claims based only on supplied chunks, exact citation chunk IDs, no instructions followed from ticket/source data, no statement that a reply/action/refund was sent or completed, and no unsupported policy invention.
- Add request construction that separately delimits the untrusted ticket, validated classification, and untrusted retrieved chunks.
- Reuse the provider-neutral Anthropic generation boundary for the grounded-reply schema and add `resolution` telemetry using the resolution prompt version.
- Add a `resolveTicket` pipeline that performs classification, retrieval, evidence sufficiency gating, grounded generation, and deterministic post-generation validation in that order.
- Reject a generated proposal unless it has at least one citation and every cited chunk ID exists in the current retrieved set. Also verify the cited source ID and section match that chunk, reject duplicate/mismatched citations, and enforce all schema limits before combining the reply with the original classification.
- Map invalid citations or invalid grounded output to the existing controlled model-output failure. Never silently drop a bad citation or return a partially grounded draft.

### 8. Extend the existing Route Handler without adding endpoints

- Change the injectable route dependency from a classifier to the complete resolver while preserving one route-generated UUID trace ID and the existing authoritative ticket validation.
- Return `ApiResult<ResolutionProposal>` on success and retain safe status/error mapping for classification and generation failures.
- Return a retryable `503 retrieval_unavailable` response for database/retrieval infrastructure failures and a non-retryable controlled response for `insufficient_evidence`; do not convert either into an ungrounded model call.
- Preserve the current testability pattern: the Route Handler accepts deterministic injected dependencies and never requires provider credentials or a live database in unit tests.

### 9. Update the support-agent UI for the proposed reply

- Rename/refocus the client form and page copy from classification to ticket resolution while keeping the server-rendered page shell and the interactive form/result logic inside a narrow Client Component, consistent with the repository's Next.js 16 guidance.
- Validate the expanded API envelope before rendering it. Preserve duplicate-submit prevention, accessible form behavior, explicit processing state, safe errors, and trace-ID display.
- Continue showing category, priority, summary, and confidence, then add a clearly labeled “Proposed reply” panel that states it is a draft requiring human review and has not been sent.
- Place compact citation references beside the reply using only the response's source ID, section, and supported-claim label. Do not include raw chunk content, a source-detail interaction, or a source-fetch endpoint; exact evidence inspection remains story 3.
- Add distinct controlled UI messaging for temporary retrieval failure, insufficient evidence, invalid grounded model output, and the existing provider failures.
- Update metadata and workspace copy to describe grounded resolution rather than classification alone without redesigning unrelated UI.

### 10. Add deterministic test coverage

- Extend domain/API schema tests for valid and invalid replies, citation limits, UUIDs, lengths, and the expanded error allowlist.
- Unit-test Markdown parsing/chunking and deterministic hashes/indexes with synthetic fixtures.
- Unit-test the Voyage AI embedding adapter with a fake SDK client for document/query input types, ordering, usage normalization, timeout/error mapping, invalid/NaN values, and dimension mismatch; make no live API calls.
- Unit-test ingestion with fake repositories and embeddings for unchanged-document skipping, batching, changed-document replacement intent, duplicate source IDs, and no partial persistence after embedding failure.
- Unit-test retrieval selection for category filtering, broad fallback, thresholds, deduplication, ordering, and context-token limits.
- Add an opt-in PostgreSQL integration suite against an explicitly named test database that refuses unsafe database names. Verify migrations/pgvector, document/chunk persistence, idempotent replacement, and cosine/category retrieval using fixed fake vectors.
- Unit-test the resolution prompt/request, evidence delimiters, insufficient-evidence short circuit, valid proposal combination, and rejection of unknown, duplicate, or metadata-mismatched citations.
- Extend Route Handler tests for the expanded success payload, retrieval failure, insufficient evidence, invalid citations, safe bodies, and trace propagation.
- Extend UI tests for processing, validated reply/citation rendering, “not sent” labeling, insufficient evidence, retrieval failure, malformed responses, retry behavior, and trace IDs.

### 11. Document and verify

- Update the README with the story's architecture, supported scope, Docker/pgvector setup, Drizzle migration flow, Voyage-embeddings-only boundary, Anthropic-generation-only boundary, ingestion semantics, environment variables, and synthetic-data warning.
- Add consistent scripts for database generation/migration, ingestion, and the PostgreSQL integration test suite. Keep all documented commands on pnpm.
- Before implementation edits, re-read the relevant installed Next.js 16 guides for Route Handlers, server/client boundaries, environment variables, and Vitest.
- Run `docker compose config` and start the local pgvector service.
- Run the committed Drizzle migration against the development and explicitly isolated test databases.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run the PostgreSQL integration-test command.
- Run `pnpm ingest` with a valid Voyage AI key and record the safe document/chunk summary; if credentials are unavailable, report that live ingestion check explicitly rather than claiming it passed.
- Run `pnpm build` with build-safe lazy runtime configuration.

## Acceptance criteria

1. From the home screen, a support agent can submit a supported synthetic ticket and see the existing classification plus a clearly labeled proposed reply and its compact knowledge-base citation references.
2. Every successful reply conforms to the grounded-reply schema, contains at least one citation, and cites only IDs actually retrieved for that request with matching source ID and section metadata.
3. Ticket text and knowledge-base Markdown are delimited as untrusted data; attempted instructions in either cannot become application instructions or expose hidden prompts.
4. No reply is generated or returned when retrieval has no evidence above the configured sufficiency threshold. The API/UI expose a controlled insufficient-evidence outcome without inventing policy.
5. Voyage AI is used only for embeddings with `document` inputs during ingestion and `query` inputs during retrieval; Anthropic remains the only text-generation provider. SDK-specific types remain inside their adapters.
6. The repository contains eight schema-valid synthetic Markdown documents, and `pnpm ingest` creates stable documents/chunks with validated 1,024-dimension embeddings in PostgreSQL/pgvector.
7. Re-running ingestion skips unchanged documents. Updating a document replaces its chunks atomically only after all new embeddings validate.
8. Retrieval uses pgvector cosine distance, applies the classified-category filter first, broadens safely when needed, and respects configured count, similarity, and context-token limits.
9. Provider keys, database credentials, raw tickets, full prompts/responses, chunk bodies, and embedding vectors never reach the browser or application telemetry.
10. Exact source-content inspection, sessions, actions, audits, persisted resolution runs, and evaluations are absent from this story.
11. Tests remain deterministic and make no live provider calls. Lint, strict type-checking, unit tests, isolated PostgreSQL integration tests, ingestion verification when credentials are available, and production build results are reported explicitly.

## Manual test checklist for handoff

1. Copy `.env.example` to `.env.local`, set `ANTHROPIC_API_KEY`, `LLM_MODEL`, `VOYAGE_API_KEY`, and the documented local `DATABASE_URL` values.
2. Start PostgreSQL/pgvector, run the database migration, run `pnpm ingest`, and confirm the safe summary reports eight documents plus a non-zero stable chunk count.
3. Run `pnpm ingest` again unchanged and confirm all eight documents are skipped and no chunks are rewritten.
4. Start `pnpm dev`; submit `I upgraded yesterday, but I was charged for both plans.` and confirm the UI shows billing classification, a proposed unsent reply, at least one duplicate-charge/refund citation reference, and a trace ID.
5. Submit representative account and technical tickets covered by the supplied corpus; confirm each draft is relevant and every visible citation reference belongs to the ingested knowledge base.
6. Temporarily raise the similarity threshold above all matches or use an unsupported synthetic question; confirm no proposed reply appears and the controlled insufficient-evidence state is shown.
7. Stop PostgreSQL and submit a valid ticket; confirm the UI shows a retryable retrieval failure with a trace ID and no database/provider details.
8. Use an injected test response containing an unknown or metadata-mismatched citation; confirm the server returns a controlled model-output error and the UI never renders the draft.
9. Navigate and submit with a keyboard at narrow and wide viewport sizes; verify labels, focus, loading/result announcements, the draft, citations, and failure states remain usable.

## Documentation references used for this plan

- Anthropic embeddings guide explaining the Voyage AI integration: https://platform.claude.com/docs/en/build-with-claude/embeddings
- Voyage AI text embeddings guide: https://docs.voyageai.com/docs/embeddings
- Voyage AI text embeddings API reference: https://docs.voyageai.com/reference/embeddings-api
- Drizzle PostgreSQL extensions/pgvector guide: https://orm.drizzle.team/docs/extensions
- Drizzle migration generation guide: https://orm.drizzle.team/docs/drizzle-kit-generate
- pgvector project documentation: https://github.com/pgvector/pgvector
