# Langfuse metadata-only observability

Langfuse is an optional diagnostic projection of project-owned OpenTelemetry spans. Pino logs and
PostgreSQL resolution/evaluation records remain the operational and durable systems of record.
Tracing is not required for local development, ingestion, evaluation, tests, or ticket resolution.

## Configuration

Create a Langfuse Cloud project in the appropriate data region and add these values to
`.env.local` or the deployment secret manager:

```dotenv
LANGFUSE_ENABLED=true
LANGFUSE_PUBLIC_KEY=<project-public-key>
LANGFUSE_SECRET_KEY=<project-secret-key>
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_ENVIRONMENT=development
LANGFUSE_RELEASE=<deployment-revision>
```

The base URL, environment, and release are optional. Both credentials are required together.
Set `LANGFUSE_ENABLED=false` and remove both credentials to disable export. Never print these
values or copy them into tickets, logs, traces, screenshots, or committed files.

The Node exporter batches spans asynchronously with a two-second request timeout. Initialization
and export failures do not alter the ticket response, retry budget, or request deadline. CLI and
test entry points do not initialize the exporter.

## Verify a trace

1. Start the application with tracing enabled and submit a synthetic ticket.
2. Copy the application trace UUID displayed in the result.
3. In Langfuse, filter span metadata for `support.trace_id` equal to that UUID.
4. Confirm `support.ticket.resolve` contains child spans for classification, retrieval, resolution,
   grounding validation, and persistence. Retrieval contains query-embedding and vector-search
   children.
5. Confirm models, prompt/policy/retrieval versions, token counts, retries, finish reason,
   validation state, retrieval counts, rounded similarities, action, and timing are present when
   applicable.
6. Inspect span names, attributes, and events. They must not contain ticket text, summaries,
   prompts, drafts, claims, source IDs/content, chunk IDs, embeddings, session/ticket hashes,
   cookies, action arguments, credentials, raw provider errors, exception messages, or stacks.
7. Repeat with tracing disabled and with an unreachable test endpoint. Ticket behavior must remain
   unchanged.

## Provider failure checklist

- Filter by `support.trace_id`, then inspect the failed classification, embedding, or resolution
  span.
- Use `error.type`, provider/model, provider request ID, finish reason, retry count, and
  `support.retry` events. Anthropic request IDs and message IDs are stored separately.
- Correlate with Pino events using `otelTraceId` and `otelSpanId`; do not add raw errors to either
  system.
- Treat missing spans as a tracing/export issue only after checking the durable resolution record
  and application logs.

## Latency checklist

- Start with `support.ticket.resolve` total duration.
- Compare classification and resolution provider durations with query embedding and vector search.
- Check retry events and bounded delay before attributing latency to a single provider attempt.
- For retrieval, compare candidate/selected counts, fallback state, context-token count, threshold,
  and rounded similarities.
- Exporter latency is not on the request path; do not change model deadlines or retrieval policy to
  compensate for a Langfuse outage.
