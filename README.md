# AI Support Ticket Resolution Copilot

This repository implements the second core story: a support agent can submit synthetic ticket text and receive a validated classification plus a proposed reply grounded in eight repository-owned Markdown knowledge-base documents. Replies are drafts requiring human review; nothing is sent and no customer action is performed.

Anthropic is the only text-generation provider. Voyage AI is used only for 1,024-dimensional embeddings: ingestion uses `document` input type and ticket retrieval uses `query` input type. PostgreSQL with pgvector stores the documents and vectors; retrieval applies the classified category first and broadens only when evidence is insufficient.

## Prerequisites

- Node.js 20 or newer
- pnpm 11
- Podman with the `podman compose` provider (for local PostgreSQL/pgvector)
- Anthropic and Voyage AI API keys for live resolution and ingestion

## Local setup

```bash
pnpm install
cp .env.example .env.local
```

Set `ANTHROPIC_API_KEY`, `LLM_MODEL`, and `VOYAGE_API_KEY`. The local database URL and safe defaults are already documented in `.env.example`.

Start PostgreSQL with pgvector, apply the Drizzle migration, and ingest the synthetic corpus:

```bash
podman compose up -d
pnpm db:migrate
pnpm ingest
```

`pnpm ingest` validates front matter, semantic headings, deterministic hashes, chunk sizes, Voyage vectors, and database writes. Re-running it skips unchanged sources. Changed sources are embedded and validated before their chunks are replaced in one transaction. The command prints counts only; it never prints document content or vectors.

Start the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Use synthetic tickets only; ticket text is sent to Anthropic for classification and grounded drafting, and is never written to application telemetry.

## Commands

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm ingest
pnpm test:integration
```

Unit tests are deterministic and make no provider calls. Integration tests require an explicitly isolated PostgreSQL database whose name ends in `_test`, supplied as `TEST_DATABASE_URL`; they run the committed migration and use fixed fake vectors.

## Architecture

- `src/app`: server-rendered shell, narrow client resolution form, and the single `POST /api/tickets/resolve` Route Handler
- `src/domain`: Zod contracts for ticket input, classification, grounded replies, citations, metadata, and API errors
- `src/ai`: provider-neutral Anthropic generation boundary, versioned classification/resolution prompts, grounding validation, and resolution pipeline
- `src/embeddings`: provider-neutral embedding contract and server-only Voyage AI adapter with deadlines, retries, finite-vector/dimension validation, and redacted telemetry
- `src/ingestion`: front-matter parsing, Markdown AST semantic sectioning, token-aware chunking, deterministic hashes/indexes, and idempotent ingestion
- `src/retrieval`: category-first cosine retrieval, safe broad fallback, thresholds, deduplication, context budgets, and untrusted evidence delimiters
- `src/db`: Drizzle schema, PostgreSQL client, migration-backed persistence, cosine search, and document replacement queries
- `src/config`: lazy server-only environment validation

Provider SDK types and secrets stay server-side. The browser receives only the validated classification, proposed draft, compact citation metadata, controlled errors, and trace ID. Exact source-content inspection, sessions, actions, audits, resolution-run persistence, and evaluations are intentionally out of scope for this story.

## Manual verification

1. Copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY`, `LLM_MODEL`, and `VOYAGE_API_KEY`.
2. Run `podman compose up -d`, `pnpm db:migrate`, and `pnpm ingest`; confirm eight documents and a non-zero chunk count.
3. Run `pnpm ingest` again; confirm all eight documents are skipped.
4. Submit `I upgraded yesterday, but I was charged for both plans.`; confirm the UI shows billing classification, an unsent proposed reply, a duplicate-charge citation, and a trace ID.
5. Stop PostgreSQL and submit a valid ticket; confirm a retryable retrieval error appears without database details.
6. Raise `RETRIEVAL_MINIMUM_SIMILARITY` above all matches or submit an unsupported synthetic question; confirm no draft is shown and the controlled insufficient-evidence state appears.
7. Use keyboard navigation at narrow and wide viewports; verify labels, focus, loading announcements, draft labeling, citations, and failures remain usable.
