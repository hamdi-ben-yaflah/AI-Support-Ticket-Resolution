# AI Support Ticket Resolution Copilot

This repository currently implements the first core user story: a support agent can submit a synthetic ticket and receive a schema-validated category, priority, summary, and confidence routing signal. Every API response includes a trace ID, and the UI labels model output as a proposal requiring human review.

No reply is sent and no customer action is performed. Retrieval, citations, persistence, signed sessions, refund-review actions, and evaluations are intentionally deferred.

## Prerequisites

- Node.js 20 or newer
- pnpm 11
- An Anthropic API key and a Claude model that supports structured outputs

## Local setup

Install dependencies and create local environment configuration:

```bash
pnpm install
cp .env.example .env.local
```

Set `ANTHROPIC_API_KEY` and `LLM_MODEL` in `.env.local`. The remaining settings have safe local defaults:

```dotenv
ANTHROPIC_API_KEY=
LLM_MODEL=
AI_REQUEST_TIMEOUT_MS=15000
AI_MAX_RETRIES=2
LOG_LEVEL=info
```

Start the application:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Use synthetic tickets only; the submitted text is sent to Anthropic.

## Commands

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Tests are deterministic and make no network requests. The production build does not require credentials because provider configuration is validated only when the classification endpoint is invoked.

When `LLM_MODEL=claude-sonnet-5`, the Anthropic adapter omits explicit sampling parameters because that model rejects non-default `temperature`, `top_p`, and `top_k` values. Models that support temperature controls continue to receive the pipeline's requested value.

## Current architecture

- `src/app`: server-rendered shell, client form, and `POST /api/tickets/resolve`
- `src/domain`: shared Zod and TypeScript boundary contracts
- `src/ai/prompts`: versioned, injection-aware prompt source
- `src/ai/pipeline`: provider-neutral classification orchestration and telemetry
- `src/ai/providers`: Anthropic SDK translation, deadlines, retries, and output validation
- `src/config`: lazy server-only environment validation
- `src/observability`: structured Pino logging with sensitive-field redaction

Anthropic SDK types remain inside the provider adapter. Ticket text, prompts, and full provider responses are excluded from application telemetry.

## Manual verification

1. Submit `I upgraded yesterday, but I was charged for both plans.` with `standard`; confirm one proposal shows category, priority, summary, confidence signal, and trace ID.
2. Repeat with `premium`, then with no tier; confirm all supported choices submit successfully.
3. Try blank text, whitespace, nine characters, and more than 10,000 characters; confirm the UI blocks submission. Send the same invalid shapes directly to the API and confirm HTTP 400.
4. Submit a valid ticket and immediately attempt a second submission; confirm only one request remains active.
5. Temporarily use invalid provider credentials; confirm a controlled error and trace ID appear without credentials, raw prompts, or provider payloads.
6. Test keyboard-only operation at narrow and wide viewport sizes; confirm every field is labeled, focus is visible, and status/result announcements are readable.
