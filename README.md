# AI Support Ticket Resolution Copilot

This repository implements core stories 1–4 and 6: a support agent can submit synthetic ticket text, receive a validated classification, and either review a grounded proposed reply with exact cited knowledge chunks or see an explicit insufficient-evidence warning. Engineers can ingest the synthetic knowledge base and inspect the persisted chunks from the command line. Replies require human review; nothing is sent and no customer action is performed.

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
pnpm test:integration
```

Unit tests are deterministic and make no provider calls. Integration tests require an explicitly isolated PostgreSQL database whose name ends in `_test`, supplied as `TEST_DATABASE_URL`; they run the committed migration and use fixed fake vectors.

## Architecture

- `src/app`: server-rendered shell, narrow client resolution form, `POST /api/tickets/resolve`, and session-authorized `GET /api/sources/:chunkId` Route Handlers
- `src/domain`: Zod contracts for ticket input, classification, discriminated reply/human-review outcomes, citations, knowledge metadata/inspection, and API errors
- `src/ai`: provider-neutral Anthropic generation boundary, versioned classification/resolution prompts, grounding validation, and resolution pipeline
- `src/embeddings`: provider-neutral embedding contract and server-only Voyage AI adapter with deadlines, retries, finite-vector/dimension validation, and redacted telemetry
- `src/ingestion`: front-matter parsing, Markdown AST semantic sectioning, token-aware chunking, deterministic hashes/indexes, idempotent ingestion, and the validated chunk-inspection output contract
- `src/retrieval`: category-first cosine retrieval, safe broad fallback, thresholds, deduplication, context budgets, and untrusted evidence delimiters
- `src/db`: Drizzle schema, PostgreSQL client, migration-backed persistence, cosine search, document replacement, deterministic chunk inspection, successful resolution runs, and immutable cited-source snapshots
- `src/config`: lazy server-only environment validation
- `src/auth`: anonymous signed HTTP-only session creation/verification and keyed one-way session/ticket hashes

Provider SDK types and secrets stay server-side. The resolve response is a discriminated success: `action: "reply"` includes a bounded rationale, proposed draft, and compact citation metadata; `action: "needs_human_review"` includes a bounded reason and deliberately omits a draft and citations. Low classification confidence, below-threshold retrieval, or model-detected ambiguity/contradiction can produce the human-review outcome. Retrieval/database/embedding unavailability remains a retryable service error, not an abstention. Exact chunk content remains server-side until the browser requests a cited chunk with its signed anonymous session cookie. The source endpoint returns only chunk ID, stable source ID, document title, section, and the immutable cited excerpt; missing, tampered, expired, cross-session, uncited, and unknown access is denied with the same non-revealing response. Source responses are private and non-cacheable. Accounts, actions, audits, and evaluations remain out of scope.

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
