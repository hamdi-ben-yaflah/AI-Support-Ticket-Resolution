# Add metadata-only AI tracing with OpenTelemetry and Langfuse

## Objective

Add end-to-end, privacy-preserving traces for ticket resolution so an operator can inspect classification, embedding, retrieval, resolution, validation, persistence, retries, and failures as one correlated execution. Use OpenTelemetry as the project-owned instrumentation boundary and Langfuse as the initial trace backend without making Langfuse part of domain or provider contracts.

## Decisions

- Keep Pino structured logs and PostgreSQL resolution/evaluation records as the operational and durable systems of record.
- Use Langfuse only as a fail-open diagnostic projection; an exporter outage must never fail, delay beyond a small bounded overhead, or change a ticket result.
- Export metadata only. Never export ticket text, summaries, prompts, model output, reply drafts, source content, provider response bodies, embeddings, session identifiers, cookies, or refund-review arguments.
- Instrument the existing provider-neutral pipeline manually instead of enabling provider auto-instrumentation, because manual spans give the project an enforceable metadata allowlist.
- Keep the existing application `traceId` as a correlation attribute and let OpenTelemetry generate its own trace and span identifiers.
- Follow OpenTelemetry GenAI attribute names where stable and useful, but expose them through a small project-owned tracing API so changes to developing semantic conventions or the backend do not leak into business logic.
- Make tracing optional. Missing Langfuse configuration uses a no-op implementation and does not affect local development, tests, ingestion, evaluation, or production requests.

## Scope

- Add server-only OpenTelemetry/Langfuse initialization and validated environment configuration.
- Add a small typed tracing facade with an in-memory test implementation and a production OpenTelemetry implementation.
- Trace the resolve API boundary, classification and resolution model calls, query embedding, evidence retrieval, grounding validation, and resolution persistence.
- Record safe retry, token, latency, validation, retrieval, and outcome metadata.
- Capture the Anthropic response `request-id` separately from the Anthropic message ID.
- Correlate existing Pino events with the active OpenTelemetry trace/span identifiers where available.
- Add deterministic tests for trace topology, safe attributes, redaction/export boundaries, failures, retries, and disabled configuration.
- Document local Langfuse configuration and verification.

## Non-goals

- Do not add an observability dashboard or trace viewer to this application.
- Do not replace Pino, PostgreSQL telemetry, persisted audit records, or the existing evaluation reports.
- Do not store raw ticket text, summaries, prompts, provider responses, generated replies, retrieved content, or embeddings in Langfuse.
- Do not add prompt management, remote prompt loading, online evaluation, model routing, provider fallback, sampling based on ticket content, or autonomous behavior.
- Do not change prompts, retrieval thresholds, model selection, retry policy, request deadlines, API response contracts, or UI behavior.
- Do not self-host Langfuse in this repository's Docker Compose stack; use Langfuse Cloud initially and retain OTLP-compatible portability.

## Trace model

Create this logical topology for a successful grounded resolution:

```text
support.ticket.resolve
├── support.ai.classification
├── support.retrieval
│   ├── support.embedding.query
│   └── support.vector_search
├── support.ai.resolution
├── support.grounding.validate
└── support.resolution.persist
```

Low-confidence and insufficient-evidence outcomes end the trace at the appropriate decision point. Failed spans record a normalized error code and status without raw exception messages or stack traces. Retries are span events on the logical provider operation so the operation duration continues to represent the full deadline-bounded call.

Use only allowlisted attributes, including:

- application trace ID, task, operation, prompt version, policy version, retrieval version, and deployment revision;
- provider, requested model, returned model, provider request ID, provider message ID, finish reason, attempt number, retry count, and bounded retry delay;
- input, output, cached-input, and cache-write token counts when supplied;
- total duration and provider-attempt duration;
- validation outcome and normalized error code;
- category, priority, confidence, selected action, abstention reason code, and citation count;
- embedding input type/count, dimensions, token count, and returned model;
- retrieval filter/fallback state, candidate/selected counts, configured thresholds, context-token count, and rounded similarity values;
- persistence outcome.

Explicitly exclude free-form summaries, reasons, drafts, evidence identifiers/content, raw error strings, session hashes, ticket hashes, and action arguments from trace attributes.

## Implementation plan

1. Before writing framework integration code, read the relevant Next.js 16 instrumentation and OpenTelemetry guide under `node_modules/next/dist/docs/` and use the supported Node-runtime initialization hook.
2. Add the minimum current dependencies for the Langfuse TypeScript tracing/OTel integration and OpenTelemetry Node SDK. Commit the resulting `pnpm-lock.yaml` change without upgrading unrelated dependencies.
3. Add a strict server-only observability configuration schema with optional Langfuse public key, secret key, base URL, environment, release, and enabled flag. Update `.env.example` with empty placeholders and safe descriptions. Partial credentials must fail configuration validation; fully absent credentials must select no-op tracing.
4. Add a typed tracing facade under `src/observability` that:
   - starts active spans and records allowlisted scalar/array attributes and retry events;
   - exposes active OTel trace/span IDs for log correlation;
   - accepts normalized error codes rather than arbitrary `Error` objects;
   - has no methods for raw prompts, inputs, outputs, source content, or embeddings;
   - defaults to a no-op implementation and permits dependency injection in tests.
5. Initialize the OpenTelemetry Node SDK and Langfuse span processor once through the supported Next.js instrumentation hook. Configure asynchronous export, prevent instrumentation errors from escaping into application requests, and ensure CLI/test entry points remain no-op unless explicitly configured.
6. Wrap `POST /api/tickets/resolve` in the root `support.ticket.resolve` span. Record request validation, final API result code, retryability, and successful persistence as safe attributes while preserving the existing public UUID trace ID.
7. Add child spans around classification and resolution logical model calls. Record prompt/model metadata, token usage, finish reason, validation status, outcome, and retry events. Preserve existing structured logs and add OTel correlation IDs when a span is active.
8. Update the Anthropic adapter to obtain the actual response `request-id` through the SDK response accessor and return it separately from the message ID. Extend the provider-neutral result contract with distinct optional `providerRequestId` and `providerMessageId` fields. On provider errors, retain only allowlisted status/request/rate-limit metadata and normalized domain codes.
9. Add retrieval, query-embedding, vector-search, grounding-validation, and persistence child spans at their existing application boundaries. Keep vector values, ticket text, chunks, source content, SQL, and database connection data out of trace attributes.
10. Keep the current Pino events for compatibility. Add a small helper that enriches events with active OTel trace/span IDs without changing existing redaction rules or logging raw exceptions.
11. Add unit tests with an in-memory tracer/exporter to assert:
    - the successful, abstained, provider-error, retrieval-error, invalid-output, and persistence-error trace shapes;
    - parent/child relationships and application trace-ID correlation;
    - retry events and terminal status;
    - distinct Anthropic request and message identifiers;
    - disabled or unavailable exporting is fail-open;
    - ticket text, summaries, prompts, generated output, chunk content, embeddings, credentials, cookies, and raw provider errors never appear in exported names, attributes, events, or log-correlation payloads.
12. Update the README and deployment documentation with Langfuse Cloud setup, metadata-only guarantees, environment variables, backend disablement, trace lookup using the displayed application trace ID, and an operator checklist for provider failures and latency investigations.

## Verification

Run:

```text
pnpm exec vitest run tests/observability tests/ai/anthropic.test.ts tests/ai/classify-ticket.test.ts tests/ai/resolve-ticket.test.ts tests/retrieval/search.test.ts tests/embeddings/voyage.test.ts tests/app/resolve-route.test.ts
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

When provider credentials and a Langfuse test project are available:

1. Start the application with Langfuse tracing enabled and submit a synthetic duplicate-charge ticket.
2. Locate the trace using the UUID displayed by the UI.
3. Confirm the trace contains classification, retrieval/embedding, resolution, validation, and persistence spans with correct parentage and timing.
4. Confirm token counts, models, prompt versions, retrieval counts, action, and provider identifiers are present.
5. Inspect every span/event and confirm no ticket text, ticket summary, prompt, draft, source content, embedding, credential, cookie, session hash, or raw provider payload was exported.
6. Repeat with invalid Langfuse credentials or an unreachable endpoint and confirm ticket resolution still returns its normal result while the export failure remains bounded and non-fatal.
7. Trigger one controlled model-provider failure and confirm the trace records the normalized error, provider request ID when supplied, retry events, and terminal status without a raw error body.

## Acceptance criteria

- One application trace ID retrieves a complete, correctly nested ticket-resolution trace in Langfuse.
- Classification, embeddings, retrieval, resolution, validation, and persistence expose enough safe metadata to diagnose latency, retries, provider errors, invalid outputs, abstentions, and retrieval weakness.
- Anthropic request IDs and message IDs are represented accurately and separately.
- No prohibited ticket, prompt, output, source, vector, authentication, session, or raw-provider data is exported.
- Missing, misconfigured, slow, or unavailable tracing infrastructure cannot change the ticket response or provider retry/deadline behavior.
- Existing Pino logs, database persistence, evaluation reports, API contracts, and UI behavior remain intact.
- Focused tests and all required repository checks pass.
