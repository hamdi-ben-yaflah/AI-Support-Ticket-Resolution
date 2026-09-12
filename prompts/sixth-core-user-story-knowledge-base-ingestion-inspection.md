# Sixth core user story: knowledge-base ingestion and chunk inspection

## User story

As an engineer, I can ingest the sample knowledge base and inspect the created chunks.

## Goal

Complete the existing engineer-facing ingestion workflow without changing embedding providers or adding a knowledge-base UI. A fresh local checkout can seed the eight repository-owned Markdown documents into PostgreSQL/pgvector, re-run ingestion idempotently, and use a dedicated CLI command to inspect the exact persisted chunk identifiers, ordering, headings, token counts, metadata, and synthetic content without exposing embedding vectors.

Voyage AI remains the sole embedding provider. Anthropic remains the sole text-generation provider.

## Requirements traced to the product documents

- PRD story 6: an engineer can ingest the sample knowledge base and inspect the created chunks.
- PRD FR-2: ingestion reads Markdown, creates identifiable chunks, generates embeddings, and stores text, source metadata, and vectors.
- PRD acceptance criterion 1: a fresh installation seeds the database and knowledge base using documented commands.
- Technical specification section 8: chunk by semantic heading, target bounded token sizes with overlap only for oversized sections, preserve stable source metadata and indexes, batch embeddings, skip unchanged documents, and atomically replace changed chunks.
- Repository architecture: only `src/db` issues database queries; provider SDK types stay inside adapters; secrets remain server-only.
- Explicit task direction: keep the existing Voyage AI embedding implementation and do not migrate to OpenAI.

## Current repository baseline

- Before this task plan was added, the worktree was clean.
- Eight synthetic Markdown files, deterministic semantic chunking, a provider-neutral embedding interface, a server-only Voyage AI adapter, PostgreSQL/pgvector persistence, idempotent content-hash checks, transactional replacement, and `pnpm ingest` already exist.
- Ingestion uses Voyage `document` embeddings, batches requests, validates 1,024-dimensional finite vectors, skips unchanged documents, and prints a counts-only completion summary.
- The missing story behavior is inspection: there is no supported database-backed command for an engineer to inspect the persisted chunks, so doing so currently requires ad hoc SQL.
- The existing vector schema, Voyage configuration, retrieval integration, and provider disclosure already support the ingestion path and will be preserved.
- Baseline verification passed while preparing the original plan: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test` (13 files, 114 tests), and `pnpm build`.

## Scope

### In scope

- Add a deterministic `pnpm chunks:inspect` command backed by a typed query in `src/db`.
- Print an explicit allowlist of persisted synthetic chunk fields, including exact content, while omitting vectors and secrets.
- Verify the existing ingestion and inspection behavior with deterministic unit and PostgreSQL integration coverage.
- Update setup, commands, architecture, and manual-verification documentation for the completed story.

### Out of scope

- Replacing Voyage AI, adding OpenAI, changing provider dependencies, or altering embedding configuration and dimensions.
- Modifying the Voyage adapter, embedding contract, retrieval behavior, chunking thresholds, database vector column, or existing knowledge documents unless a story-specific defect is discovered during implementation.
- A browser knowledge-base admin or inspection page, new HTTP endpoint, arbitrary uploads, crawling, non-Markdown input, editing, deletion, pagination, or search/filter UX.
- Evaluation commands, mock actions, retrieval tuning, reranking, or unrelated application behavior.
- Printing embedding vectors, API keys, database credentials, prompts, provider responses, raw tickets, or non-knowledge application data.

## Implementation plan

### 1. Define the inspection output contract

- Add a focused Zod contract for a persisted chunk inspection record containing only `chunkId`, `sourceId`, document `title`, `category`, `version`, `chunkIndex`, `section`, `tokenCount`, and exact synthetic `content`.
- Reuse the existing source-ID, category, metadata, UUID, non-empty text, and positive-count constraints where practical.
- Keep the inspection shape separate from retrieval candidates and browser source details because it serves a trusted, local engineer CLI and includes ordering/token metadata that those consumers do not need.

### 2. Add a typed database inspection query

- Add a query in `src/db/knowledge.ts` that joins `documents` to `document_chunks`, selects only the inspection allowlist, validates the returned rows, and orders deterministically by stable source ID and chunk index.
- Read the persisted database rows rather than reparsing Markdown so the command demonstrates what ingestion actually created.
- Do not select or return the embedding vector, internal document UUID, content hash, timestamps, arbitrary JSON, or similarity values.
- Keep the corpus-small behavior intentionally simple: list all current chunks with no pagination or filtering.

### 3. Add the engineer inspection command

- Add a small TypeScript CLI entry point and a `pnpm chunks:inspect` package script.
- Load `.env.local` consistently with the existing ingestion command, dynamically import the server-only database boundary, read the persisted chunks, and always close the database connection.
- Emit one stable JSON line per chunk using an event such as `knowledge_chunk`, followed by a counts-only `chunk_inspection_completed` summary.
- Include exact chunk content because the corpus is repository-owned synthetic data and the engineer explicitly invoked the inspection command. Keep routine `pnpm ingest` output counts-only.
- If the database is empty, complete successfully with zero chunk records and an explicit zero-count summary rather than fabricating data.
- On validation or database failure, emit one concise structured failure, set a non-zero exit code, and omit credentials, SQL, stack traces, vectors, and other sensitive internals.

### 4. Add deterministic coverage

- Add unit coverage for the inspection record schema and any extracted pure CLI formatting/error helper.
- Extend the isolated PostgreSQL knowledge-repository suite to verify inspection rows after insert and replacement, stable source/index ordering, exact persisted content, metadata validation, and strict omission of vectors and unrelated fields.
- Preserve the existing network-free Voyage adapter, chunking, ingestion, retrieval, resolution, route, authorization, and UI tests without changing provider assertions.
- Do not require Voyage credentials in the default test suite; use the existing fake vectors and isolated test-database safeguards.

### 5. Update documentation and verify

- Update the README’s implemented-story summary, command list, architecture description, ingestion section, and manual test instructions to include `pnpm chunks:inspect`.
- Document the JSON-lines output, deterministic ordering, explicit inclusion of repository-owned synthetic content, and omission of vectors and secrets.
- Update technical-spec ingestion/setup commands to use pnpm consistently and add the inspection command where story 6 is described.
- No Next.js code is planned, so no Next.js implementation guide is required for this story.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run `pnpm build`.
- When an isolated test database is configured, run `pnpm test:integration`.
- With PostgreSQL/pgvector running and a valid Voyage key, run `pnpm db:migrate`, `pnpm ingest`, `pnpm chunks:inspect`, and a second `pnpm ingest`; report exact results. If credentials or the isolated database are unavailable, report those checks as unavailable rather than passing.
- `pnpm eval` is not present and evaluation work is unrelated to this story, so it is not added or run.

## Acceptance criteria

1. A fresh checkout can start PostgreSQL/pgvector, apply committed migrations, and run `pnpm ingest` to persist all eight schema-valid Markdown documents and a non-zero chunk count.
2. Voyage AI remains the only embedding provider and is used with the existing 1,024-dimensional document/query behavior; no OpenAI dependency or configuration is introduced.
3. Existing ingestion remains batched, validated, transactional, and idempotent: unchanged documents are skipped and changed documents replace their chunks only after all new vectors validate.
4. `pnpm chunks:inspect` reads the database rather than reparsing files and emits every persisted chunk in stable source/index order with its UUID, source/title, category/version, index, section, token count, and exact synthetic content.
5. An empty database produces a successful zero-count inspection summary, while validation/database failures produce a controlled non-zero failure.
6. Inspection output and ordinary telemetry never include vectors, secrets, database credentials, SQL, provider responses, raw tickets, prompts, internal document IDs, or unrelated application rows.
7. No browser knowledge-base administration/inspection surface, provider migration, database migration, evaluation feature, or unrelated product behavior is added.
8. Unit tests stay deterministic and network-free; lint, strict type-checking, tests, build, and available integration/live-ingestion checks are reported exactly.

## Manual test checklist for handoff

1. Copy `.env.example` to `.env.local`; set `VOYAGE_API_KEY`, the existing Anthropic/model values needed for the app, and the local PostgreSQL URL.
2. Start PostgreSQL/pgvector and run `pnpm db:migrate`.
3. Run `pnpm chunks:inspect` before ingestion against an empty database; confirm it reports zero chunks without failing or fabricating records.
4. Run `pnpm ingest`; confirm the summary reports all eight documents and a non-zero created chunk count.
5. Run `pnpm chunks:inspect`; confirm each JSON chunk record has a UUID, stable source/title/category/version, sequential per-document index, heading path, positive token count, and exact Markdown chunk text.
6. Confirm inspection ordering is stable across repeated runs and search the output for `embedding`, `vector`, `apiKey`, and `databaseUrl`; none should be present.
7. Run `pnpm ingest` again without editing the corpus; confirm all eight documents are skipped and zero chunks are rewritten.
8. Change one synthetic Markdown document locally, re-run ingestion, and confirm only that source updates and inspection reflects its replacement chunks; restore the local edit afterward.
9. Temporarily stop PostgreSQL and run `pnpm chunks:inspect`; confirm a concise non-zero failure is printed without connection credentials or a stack/provider payload.
