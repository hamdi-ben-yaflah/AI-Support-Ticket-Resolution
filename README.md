# AI Support Ticket Resolution Copilot

This repository implements the first three core stories: a support agent can submit synthetic ticket text, receive a validated classification and grounded proposed reply, and inspect the exact cited knowledge chunks beside that draft. Replies require human review; nothing is sent and no customer action is performed.

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

Set `ANTHROPIC_API_KEY`, `LLM_MODEL`, `VOYAGE_API_KEY`, and a random `SESSION_COOKIE_SECRET` of at least 32 characters. The local database URL and safe defaults are already documented in `.env.example`.

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

Open [http://localhost:3000](http://localhost:3000). Use synthetic tickets only; ticket text is sent to Anthropic for classification and grounded drafting, and is never written to application telemetry or storage. Successful runs retain only a keyed ticket hash, redacted model metadata, the validated classification/action, and immutable snapshots of cited chunks.

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

- `src/app`: server-rendered shell, narrow client resolution form, `POST /api/tickets/resolve`, and session-authorized `GET /api/sources/:chunkId` Route Handlers
- `src/domain`: Zod contracts for ticket input, classification, grounded replies, citations, metadata, and API errors
- `src/ai`: provider-neutral Anthropic generation boundary, versioned classification/resolution prompts, grounding validation, and resolution pipeline
- `src/embeddings`: provider-neutral embedding contract and server-only Voyage AI adapter with deadlines, retries, finite-vector/dimension validation, and redacted telemetry
- `src/ingestion`: front-matter parsing, Markdown AST semantic sectioning, token-aware chunking, deterministic hashes/indexes, and idempotent ingestion
- `src/retrieval`: category-first cosine retrieval, safe broad fallback, thresholds, deduplication, context budgets, and untrusted evidence delimiters
- `src/db`: Drizzle schema, PostgreSQL client, migration-backed persistence, cosine search, document replacement, successful resolution runs, and immutable cited-source snapshots
- `src/config`: lazy server-only environment validation
- `src/auth`: anonymous signed HTTP-only session creation/verification and keyed one-way session/ticket hashes

Provider SDK types and secrets stay server-side. The resolve response contains only the validated classification, proposed draft, compact citation metadata, controlled errors, and trace ID. Exact chunk content remains server-side until the browser requests a cited chunk with its signed anonymous session cookie. The source endpoint returns only chunk ID, stable source ID, document title, section, and the immutable cited excerpt; missing, tampered, expired, cross-session, uncited, and unknown access is denied with the same non-revealing response. Source responses are private and non-cacheable. Accounts, actions, audits, and evaluations remain out of scope.

## Manual verification

1. Copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY`, `LLM_MODEL`, `VOYAGE_API_KEY`, and a random `SESSION_COOKIE_SECRET` of at least 32 characters.
2. Run `podman compose up -d`, `pnpm db:migrate`, and `pnpm ingest`; confirm eight documents and a non-zero chunk count.
3. Run `pnpm ingest` again; confirm all eight documents are skipped.
4. Submit `I upgraded yesterday, but I was charged for both plans.`; confirm the UI shows billing classification, an unsent proposed reply, a duplicate-charge citation, exact retrieved evidence, and a trace ID.
5. In browser developer tools, confirm the resolve JSON omits chunk content and each cited-source request is a same-origin `GET` with `Cache-Control: private, no-store`.
6. Open a cited-source URL in a private session, then remove or tamper with the normal session cookie; confirm both attempts receive the same not-found response as an unknown UUID.
7. Stop PostgreSQL and submit a valid ticket; confirm a retryable controlled failure appears without database details and no proposal is returned without its source authorization record.
8. Raise `RETRIEVAL_MINIMUM_SIMILARITY` above all matches or submit an unsupported synthetic question; confirm no draft is shown and the controlled insufficient-evidence state appears.
9. Use keyboard navigation at narrow and wide viewports; verify labels, focus, source loading/retry announcements, draft labeling, citations, and failures remain usable.
