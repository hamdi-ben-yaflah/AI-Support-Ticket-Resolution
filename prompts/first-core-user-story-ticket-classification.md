# First core user story: ticket classification

## User story

As a support agent, I can submit a ticket and receive its category, priority, and concise summary.

## Goal

Deliver the smallest production-oriented vertical slice from the home-page form through a validated Next.js Route Handler and provider-neutral Anthropic classification service. The result must be schema-valid, traceable, safe to render, and explicit about loading and failure states.

This story will use the final `POST /api/tickets/resolve` URL. Its success payload is the classification subset of the future resolution contract: `ApiResult<Classification>`. Later stories can extend the data object with the drafted response, evidence, confidence explanation, and action while preserving these fields and the endpoint.

## In scope

- A ticket form with required ticket text and optional `standard` or `premium` customer tier.
- Client-side usability checks and authoritative server-side Zod validation.
- Schema-validated `billing`, `technical`, `account`, or `other` category output.
- Schema-validated `low`, `medium`, or `high` priority output.
- A non-empty summary of at most 300 characters.
- A confidence routing value between 0 and 1 in the API/domain result, ready for later abstention work.
- A provider-neutral generation boundary with one Anthropic implementation.
- A versioned classification prompt that treats ticket text as untrusted data.
- A trace ID in every API success and failure response.
- Structured, redacted model-call telemetry with no raw ticket or full prompt content.
- Distinct UI states for idle, invalid input, processing, success, and controlled failure.
- Deterministic, network-free tests.
- Local setup documentation and empty environment placeholders.

## Out of scope

- Knowledge-base documents, ingestion, embeddings, PostgreSQL, pgvector, and retrieval.
- Draft replies, citations, source inspection, evidence sufficiency, and abstention behavior.
- Refund-review proposals, confirmation, execution, and audit records.
- Signed sessions and persisted resolution runs; those become necessary when resolution/source ownership is introduced.
- Evaluation datasets and evaluation commands.
- Live-provider tests in the default test suite.
- Streaming, conversation history, external help-desk integrations, or real actions.

## Implementation plan

### 1. Establish the application layout and dependencies

- Move the starter App Router files from `app/` to `src/app/` so UI and HTTP boundaries follow the repository architecture from the first feature.
- Add only the dependencies needed by this story: Zod, the Anthropic TypeScript SDK, and a Pino-compatible logger.
- Add Vitest and focused React/DOM testing dependencies, a Vitest configuration, and a `pnpm test` script.
- Preserve strict TypeScript and Tailwind CSS 4; do not introduce a component library or another styling system.

### 2. Define shared, provider-neutral contracts

- Add `src/domain/ticket.ts` with `TicketInputSchema` and its inferred type. Trim text and enforce 10 to 10,000 characters; allow only the two documented customer tiers.
- Add `src/domain/classification.ts` with `ClassificationSchema` and its inferred type. Enforce the documented category/priority enums, a 1-to-300-character summary, and confidence from 0 to 1.
- Add `src/domain/api-result.ts` with Zod schemas and TypeScript types for the success/error envelope, including a UUID trace ID and a controlled error containing `code`, safe `message`, and `retryable`.
- Reuse these contracts at the UI, API, orchestration, and provider boundaries instead of duplicating handwritten checks.

### 3. Add server-only configuration and observability

- Add a server-only environment module that validates `ANTHROPIC_API_KEY`, `LLM_MODEL`, `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_RETRIES`, and `LOG_LEVEL` when the classifier is invoked.
- Add `.env.example` with empty secret/model placeholders and safe numeric defaults; keep real values in `.env.local`.
- Generate one UUID trace ID at the Route Handler boundary and propagate it through classification and logs.
- Add a structured logger with redaction for authorization, cookies, API keys, ticket text, and prompt/provider-response bodies.
- Emit a model-call event containing the trace ID, task, provider/model, prompt version, latency, usage, finish reason, validation result, and retry count. Never log the raw ticket, full prompt, or full provider response.

### 4. Implement the provider-neutral classification path

- Add the internal generation request/result contract and `LlmProvider` interface under `src/ai/` so domain and UI code never depend on Anthropic response types.
- Add `src/ai/prompts/classify.v1.ts` with an exported immutable prompt version and classification instructions. Define every category and priority, require concise neutral summaries, and delimit the ticket/customer tier as untrusted data whose embedded instructions must be ignored.
- Add an Anthropic adapter under `src/ai/providers/` that requests structured JSON, applies the overall timeout, maps provider status/refusal/truncation failures into internal errors, parses unknown output, and validates it with the supplied Zod schema before returning it.
- Retry only retryable rate-limit, server, or transient network failures, cap retries with `AI_MAX_RETRIES`, and keep every attempt within the request deadline. Do not retry schema-invalid output with a changed prompt.
- Add `classifyTicket` orchestration under `src/ai/pipeline/` to build the provider-neutral request with temperature zero (when supported), a bounded output limit, trace metadata, and the versioned prompt.

### 5. Expose the Route Handler

- Add `src/app/api/tickets/resolve/route.ts` with `POST` only.
- Parse the request body as unknown, return `400` for malformed JSON or invalid ticket input, and do not call the provider when validation fails.
- Invoke the classification service and return `200` with `ApiResult<Classification>` on success.
- Map timeouts to `504`, exhausted rate-limit/provider-unavailable failures to `503`, refused/truncated/schema-invalid provider output to a controlled `502`, and unexpected/configuration failures to a safe `500` response.
- Include the same trace ID in the envelope and server logs for every outcome; do not leak SDK details, secrets, raw tickets, prompts, or provider responses.
- Structure the handler so tests can inject a deterministic fake classifier without networking or module-level environment mutation.

### 6. Build the support-agent UI

- Keep `src/app/page.tsx` as the server-rendered shell and isolate form state/event handlers in a focused Client Component.
- Replace the starter screen with a responsive, accessible ticket workspace using project-owned React components and Tailwind utilities.
- Provide a labeled textarea, optional customer-tier selector, character guidance, inline validation, and a submit button that is disabled for invalid or in-flight input.
- Submit JSON to `/api/tickets/resolve`, validate the returned envelope before rendering, prevent duplicate submissions, and allow a failed request to be retried deliberately.
- Show an explicit processing state and a result panel for category, priority, and summary. Label the output as an AI-generated proposal requiring human review; do not imply that a customer reply was sent or an action occurred.
- Show safe, distinct messages for invalid input, timeout, retryable provider failure, model-output validation failure, and unexpected failure, plus the trace ID for support/debugging.
- Update document metadata and global styles to match the product rather than the Create Next App starter.

### 7. Add deterministic coverage

- Unit-test ticket, classification, and API-envelope schemas at valid values and important boundaries.
- Unit-test prompt/request construction, including ticket-as-data delimiters, prompt version metadata, tier handling, and rejection of schema-invalid provider output.
- Test retry/deadline and provider-error mapping with fakes or mocked time; make no live Anthropic calls.
- Test the Route Handler for success, malformed JSON, invalid ticket/tier, timeout, unavailable provider, invalid model output, safe error bodies, and trace-ID propagation.
- Test the client form for empty/short input prevention, optional tier submission, loading/duplicate-submit behavior, successful result rendering, controlled error rendering, and trace-ID display.

### 8. Document and verify

- Replace the starter README instructions with the story-specific prerequisites, `pnpm` commands, environment setup, architecture boundary, and note that classification currently requires Anthropic credentials.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run `pnpm build` with non-secret build-safe configuration; document any runtime-only credential requirement.
- Manually verify one valid ticket for each category, both tier values, invalid text boundaries, a forced provider failure, and responsive keyboard-only form use.

## Acceptance criteria

1. From the home screen, a support agent can submit valid synthetic ticket text with or without a supported tier and see category, priority, and a concise summary.
2. Empty, whitespace-only, shorter-than-10-character, longer-than-10,000-character, and unsupported-tier requests are rejected without a provider call.
3. Every successful classification conforms to `ClassificationSchema`; schema-invalid, refused, or truncated output is never rendered as success.
4. Every HTTP response contains a UUID trace ID, and model-call telemetry contains required metadata without raw ticket text, prompts, secrets, or full provider responses.
5. Loading, validation, retryable provider failure, timeout, model validation failure, and success are distinguishable in the UI.
6. Anthropic SDK types remain inside the adapter; domain, pipeline, route response, and UI contracts are provider-neutral.
7. Tests are deterministic and network-free, and lint, strict type-checking, tests, and production build pass.
8. The implementation includes none of the explicitly deferred retrieval, response-generation, citation, action, persistence, session, or evaluation scope.

## Manual test checklist for handoff

1. Copy `.env.example` to `.env.local`, set a valid Anthropic API key and supported model, and start with `pnpm dev`.
2. Submit `I upgraded yesterday, but I was charged for both plans.` with `standard`; verify one result panel contains category, priority, and a summary plus a trace ID.
3. Repeat with `premium`; verify the request succeeds and no customer tier outside the allowlist can be sent through the UI or API.
4. Attempt blank, whitespace-only, nine-character, and over-10,000-character tickets; verify inline/API validation and no processing state that suggests a model call.
5. Submit a valid ticket and immediately try to submit again; verify only one request remains active.
6. Use invalid provider credentials or a test-only injected failure; verify a safe error and trace ID are shown with no secret, raw prompt, or provider payload.
7. Navigate and submit with a keyboard at narrow and wide viewport sizes; verify labels, focus, result announcement, and layout remain usable.
