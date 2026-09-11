# Third core user story: exact source inspection

## User story

As a support agent, I can inspect the exact sources used to produce the proposal.

## Goal

Extend the grounded-reply slice so every citation beside a successful proposed reply can reveal the exact, display-safe knowledge chunk that supported it: document title, section, and verbatim chunk excerpt. Source content remains server-side until it is requested through a session-authorized endpoint, and a browser can read only chunks cited by one of its own successful resolution runs.

The existing `POST /api/tickets/resolve` response will continue to omit chunk bodies. A new `GET /api/sources/:chunkId` Route Handler will authorize access through an anonymous signed HTTP-only session cookie and a persisted resolution-to-citation mapping before returning a schema-validated source detail.

## Requirements traced to the product documents

- PRD section 7.3: each citation shows the document title, section, and supporting excerpt, with retrieved evidence visually distinct from generated text.
- PRD section 11: sources remain beside the proposed response instead of becoming a separate page or secondary workflow.
- PRD acceptance criterion 3: answerable cases cite viewable source chunks.
- Technical specification section 13: `GET /api/sources/:chunkId` returns display-safe metadata and content only when the chunk belongs to the requesting resolution context.
- Repository security rules: source lookup requires the owning signed session; unrelated documents, embeddings, prompts, provider responses, database details, and secrets never reach the browser.

## Current repository baseline

- Story 2 is implemented: Markdown ingestion, PostgreSQL/pgvector storage, category-aware retrieval, Anthropic grounded generation, deterministic citation validation, and compact citation metadata in the UI.
- `RetrievedEvidence` already contains the exact chunk body used by generation, but the successful API envelope intentionally exposes only `chunkId`, `sourceId`, `section`, and the generated support claim.
- The UI currently renders the stable source ID, section, and generated claim. It has no source-detail state or source request.
- There is no anonymous session, source endpoint, persisted resolution run, or persisted run-to-source ownership mapping.
- `documents` stores the display title; `document_chunks` stores the exact section/content. Ingestion replaces a changed document's chunk rows, so source inspection must retain the exact cited snapshot rather than depend on mutable current corpus state.
- The worktree was clean when this plan was prepared.
- Baseline verification passed: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test` (81 tests), and `pnpm build`.

## Scope boundary

### In scope

- A display-safe, schema-validated source-detail contract containing only chunk ID, stable source ID, document title, section, and exact cited chunk content.
- Anonymous signed HTTP-only session creation/reuse at the resolve Route Handler.
- One-way hashes for the session identifier and ticket text; neither raw value is persisted with a resolution run.
- Successful resolution-run persistence and an immutable snapshot of only the chunks actually cited by the validated proposal.
- `GET /api/sources/:chunkId` with UUID validation, signed-session ownership enforcement, safe error mapping, and non-cacheable responses.
- Inline source loading and presentation beside the proposed reply, with retrieved excerpts clearly separated from the model-generated draft and claim.
- Deterministic unit, Route Handler, UI, and isolated PostgreSQL integration coverage.
- Documentation and environment updates for the cookie-signing requirement and source-inspection flow.

### Explicitly out of scope

- User accounts, login, roles, organizations, or enterprise authentication.
- A source browser, corpus search page, knowledge-base admin UI, full-document endpoint, arbitrary document access, or source downloads.
- Exposing all retrieved candidates; only citations retained by deterministic grounding validation are inspectable.
- Returning chunk bodies from `POST /api/tickets/resolve`, putting source content in a client-readable cookie/token, or rendering Markdown as trusted HTML.
- Recommended-action UI, refund-review proposal/confirmation/execution, `action_audit`, or any real external action.
- Story-4 abstention changes, evaluations, streaming, conversation history, and unrelated refactors or dependency upgrades.
- Persisting failed runs beyond the existing redacted telemetry; this story persists successful runs because they are the authorization context for viewable citations.

## Implementation plan

### 1. Define provider-neutral source, session, and run contracts

- Add a source-detail Zod schema under `src/domain` for `chunkId`, stable `sourceId`, document `title`, `section`, and bounded non-empty `content`. This is the complete allowlist for the source endpoint response.
- Add internal schemas/types for a successful resolution execution and persisted run metadata. Keep provider SDK types out of domain, database, route, and UI code.
- Represent the current successful proposal kind as the schema-valid internal action `reply`; do not add an action control or claim that the reply was sent.
- Extend the controlled API error allowlist only as needed for source access, using safe codes such as `source_not_found` and `source_unavailable` without exposing whether another session owns a chunk.

### 2. Add anonymous signed-session support

- Add a lazy server-only session configuration module with an empty `SESSION_COOKIE_SECRET` placeholder in `.env.example`, a minimum secret-strength check, a fixed cookie name/version, and a bounded lifetime.
- Implement a small server-only session utility using Node crypto: generate a random opaque session ID, HMAC-sign the cookie value, verify signatures with constant-time comparison, and derive a one-way session hash for persistence.
- Treat malformed, unknown-version, or tampered cookies as invalid. The resolve route may rotate them by issuing a fresh session; the source route must never create access for an invalid/missing session.
- Set the cookie only from the Route Handler response with `HttpOnly`, `SameSite=Lax`, `Path=/`, a bounded `Max-Age`, and `Secure` outside local development. Never return the session ID or signature in JSON or logs.
- Derive `ticket_hash` with a keyed one-way digest so raw ticket text is never persisted and low-entropy ticket content is not exposed to a simple offline hash lookup.

### 3. Persist the successful resolution and exact cited-source snapshots

- Extend the Drizzle schema with `resolution_runs` using the repository contract: generated ID/timestamp, unique trace ID, session hash, ticket hash, prompt versions, provider/model, successful result status, schema-valid classification, internal `reply` action, non-negative latency/token/retry telemetry, and validation status. Add database constraints and indexes needed by the ownership lookup.
- Add a focused `resolution_run_sources` table keyed by resolution run and citation position. Store the cited `chunkId`, stable source ID, document title, section, and exact chunk content as an immutable snapshot, with uniqueness preventing duplicate chunks in one run.
- Snapshot cited source text rather than retain a foreign key to mutable `document_chunks`: re-ingestion can replace/delete chunk rows, but an agent must still inspect the exact evidence used for the already-produced proposal.
- Add a new generated Drizzle migration and inspect it for the expected constraints, indexes, foreign keys, and no unrelated schema changes.
- Keep all inserts and lookups in focused `src/db` modules. Persist the run and all cited snapshots in one transaction; validate JSON and source values before writing. If persistence fails, return a controlled retryable failure and do not return a proposal whose sources cannot be inspected.
- Add a source lookup that joins the owned run context by session hash and cited chunk ID, returning only the source-detail allowlist. When several owned runs cite the same ID, return the newest matching snapshot deterministically.

### 4. Preserve source provenance through the resolution pipeline

- Add the document title to the provider-neutral retrieval result by joining `documents` in the existing database search. Keep the title out of the model-generated citation contract and continue validating citation IDs, source IDs, and sections against retrieved evidence.
- Keep the resolution prompt/context unchanged unless required for the title field; the model does not need to generate or authenticate document titles.
- Refactor the internal configured resolver result so the Route Handler receives the public proposal plus only the validated cited evidence snapshots and provider-neutral run metadata needed for persistence.
- Capture prompt versions, provider/model, aggregate non-negative token usage/retries, validation state, and end-to-end latency without logging or persisting raw ticket text, prompts, provider responses, embeddings, or uncited chunk bodies.
- Filter retrieved evidence by the validated citation list before persistence. Preserve citation order and reject any impossible missing/duplicate mapping rather than broadening authorization to every retrieved candidate.

### 5. Bind successful resolution responses to the session

- Update `POST /api/tickets/resolve` to validate/reuse or create the anonymous session before invoking the resolver, then atomically persist the successful run and cited snapshots before returning the existing `ApiResult<ResolutionProposal>`.
- Preserve the current request validation, route-generated trace ID, dependency-injection pattern, provider/retrieval error mappings, and response schema.
- Attach the signed session cookie to the successful response without adding source content or authorization material to the JSON body.
- Map session configuration and persistence failures to safe controlled responses. Do not expose a successful proposal if its source authorization context was not saved.

### 6. Add the authorized source Route Handler

- Add `src/app/api/sources/[chunkId]/route.ts` with `GET` only, following the installed Next.js 16 dynamic Route Handler and async parameter conventions.
- Generate a trace ID for every response, validate `chunkId` as a UUID, verify the signed request cookie, hash the session ID, and call the database ownership lookup.
- Return `200 ApiResult<SourceDetail>` only when that session owns a successful run that cited the requested chunk.
- Use the same non-revealing `404 source_not_found` response for an absent chunk, a chunk cited only by another session, and a missing/invalid/tampered session. Return a safe retryable `503 source_unavailable` for database failures and `400 invalid_request` for a malformed route parameter.
- Mark success and error responses `Cache-Control: private, no-store`; never return embeddings, similarity scores, token counts, document paths, arbitrary metadata, session identifiers, or unrelated chunks.
- Keep the handler dependency-injectable so authorization and response mapping tests require neither a live database nor environment mutation.

### 7. Render exact evidence inline beside the draft

- Extend the existing Client Component with per-citation source states (`loading`, `ready`, and controlled `failure`) keyed by chunk ID.
- After a validated proposal succeeds, fetch each cited source from `/api/sources/:chunkId` with same-origin credentials. Validate every response with the shared source API schema before rendering; ignore/abort stale source requests when a new ticket replaces the result.
- Keep source cards inside the existing “Knowledge citations” area. Show document title, section, the exact supporting excerpt as plain pre-wrapped text, and the model-generated supported claim under a separate label so retrieved evidence and generated text cannot be confused.
- Provide an accessible loading announcement and a per-source retry control for temporary failures. A source failure must not erase the already-validated proposal or silently substitute the generated claim for source text.
- Preserve keyboard operation, responsive layout, duplicate resolve-submit prevention, draft/not-sent labeling, trace display, and current controlled resolution failures.

### 8. Add deterministic security and behavior coverage

- Unit-test source-detail/run schemas, session signing and verification, constant-shape tamper rejection, cookie attributes, ticket/session hashing, and absence of raw inputs from persisted records.
- Extend retrieval and resolution tests for document titles, cited-only snapshot selection, stable citation order, and rejection of missing or duplicate provenance.
- Extend resolve Route Handler tests for new/reused/invalid-cookie behavior, successful persistence before response, `Set-Cookie` safety attributes, cited-only grants, safe persistence/configuration failure, and unchanged public proposal payload.
- Add source Route Handler tests for owned success, malformed UUID, missing/invalid/tampered cookie, another session's chunk, unknown chunk, database failure, trace propagation, no-store caching, and strict omission of non-display fields.
- Extend UI tests for parallel cited-source requests, loading state, title/section/exact excerpt rendering, generated-versus-retrieved labels, malformed source responses, per-source retry, stale-request protection, and keeping the proposal visible when one source fails.
- Extend the isolated PostgreSQL integration suite to verify transactional run/source creation, owned lookup, cross-session denial, cited-only access, duplicate protection, and immutable source snapshots after the live knowledge document/chunk is replaced.
- Keep all automated tests network-free with fake model/embedding providers and synthetic source text.

### 9. Document and verify

- Update the README architecture and security sections to describe the two Route Handlers, anonymous signed-session ownership, successful resolution/source snapshot persistence, exact source display, cookie-secret setup, and the continued prohibition on raw ticket persistence and uncited source access.
- Before implementation edits, re-read the installed Next.js 16 Route Handler, dynamic route, cookie, and Server/Client Component guides under `node_modules/next/dist/docs/`.
- Run `pnpm db:generate` and review the generated migration.
- Run `docker compose config` and start the local pgvector service.
- Apply the migration to development and the explicitly isolated `_test` database.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run `pnpm test:integration` with the isolated test database.
- Run `pnpm ingest` and report its safe counts; if live embedding credentials are unavailable, report that explicitly rather than claiming the check passed.
- Run `pnpm build` with build-safe lazy server configuration.

## Acceptance criteria

1. After a successful supported ticket resolution, every citation beside the proposed reply loads a schema-validated source card containing the exact cited chunk's document title, section, and text excerpt.
2. Retrieved excerpts are visibly labeled and distinct from both the model-generated draft and its generated support claim; all are rendered as text, not trusted HTML.
3. The resolve response and browser-visible cookie data contain no chunk body, session identifier, cookie secret, prompt, provider response, embedding, or unrelated document metadata.
4. A source request succeeds only with a valid signed session that owns a successful resolution run citing that chunk. Missing, tampered, expired, different-session, unknown, and uncited access all fail without revealing whether the chunk exists.
5. Only citation IDs retained by deterministic grounding validation are persisted/authorized; retrieved-but-uncited and unrelated chunks are inaccessible.
6. The exact cited snapshot remains viewable after later knowledge-base ingestion replaces the current document chunks.
7. A successful proposal is not returned unless its run and cited snapshots were saved transactionally, and persistence/database failures produce controlled safe responses.
8. Raw ticket text is never persisted; the run stores only a keyed one-way ticket hash and required schema-valid, non-negative metadata.
9. Session and source infrastructure remains server-only, source responses are private/no-store, logs stay redacted, and no new account/authentication or external-action scope is introduced.
10. Unit, Route Handler, UI, and isolated PostgreSQL integration tests are deterministic and network-free; lint, strict type-checking, tests, relevant ingestion/integration checks, and production build results are reported exactly.

## Manual test checklist for handoff

1. Configure `SESSION_COOKIE_SECRET`, the existing provider/database values, start PostgreSQL/pgvector, apply migrations, run ingestion, and start `pnpm dev`.
2. In a fresh browser session, submit `I upgraded yesterday, but I was charged for both plans.` and confirm the proposed reply remains marked “Draft · not sent.”
3. Confirm every knowledge citation beside the draft resolves to a card with a human-readable document title, the cited section, and the exact supporting chunk excerpt, visually separate from the generated claim.
4. In browser developer tools, confirm the resolve JSON contains citation metadata but no source content, and each source request is a same-origin `GET /api/sources/<uuid>` returning `Cache-Control: private, no-store`.
5. Copy a cited source URL into a separate private/incognito session; confirm it returns the same non-revealing not-found response as an unknown UUID and does not expose the source.
6. Tamper with or remove the anonymous session cookie and retry the source URL; confirm access is denied and no replacement access is minted by the GET request.
7. Force a temporary source database failure after a proposal is shown; confirm the proposal stays visible, the source card reports a controlled failure, and its retry works after recovery.
8. Resolve a second ticket while the first ticket's source requests are delayed; confirm stale excerpts cannot appear under the new proposal.
9. Re-ingest a changed synthetic knowledge document after producing a proposal; confirm the earlier cited source still displays its original stored excerpt.
10. Navigate the source cards and retry controls with a keyboard at narrow and wide widths; confirm loading/failure announcements and text remain readable.

## Local Next.js references inspected for planning

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
