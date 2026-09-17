# Improve Voyage embedding error diagnostics

## Objective

Make terminal Voyage embedding failures actionable in structured application logs so operators can distinguish rate limiting, quota or billing restrictions, invalid configuration, and temporary provider failures without exposing secrets, embedding inputs, or raw provider responses.

## Scope

- Update the Voyage embedding adapter's terminal failure telemetry.
- Add deterministic unit coverage for the new diagnostic fields and redaction boundaries.
- Do not change provider selection, retry counts, request timeouts, ingestion behavior, startup gating, or user-facing error messages.

## Implementation plan

1. Add a small provider-error diagnostic mapper in `src/embeddings/providers/voyage.ts` that narrows the SDK's unknown response body and returns only allowlisted fields:
   - provider error name and HTTP status;
   - a bounded, sanitized provider error code and reason from recognized string fields such as `code`, `detail`, or `message`;
   - an allowlisted request identifier when Voyage supplies one;
   - bounded retry/rate-limit metadata from recognized response headers, without logging all response headers.
2. Sanitize diagnostic strings before logging by bounding their length and removing credential-shaped values. Never log the API key, authorization headers, request inputs, embeddings, arbitrary provider-body fields, or the raw response.
3. Use the mapper in the existing terminal `embedding_call` error event while preserving the current domain error mapping and retry behavior.
4. Extend `tests/embeddings/voyage.test.ts` to verify that:
   - a `429` records its safe provider reason and selected retry/request metadata;
   - nested or unrelated response-body fields are omitted;
   - credential-shaped content is redacted;
   - non-Voyage errors retain minimal diagnostics;
   - existing error mapping and retry behavior remain unchanged.

## Verification

Run:

```text
pnpm exec vitest run tests/embeddings/voyage.test.ts
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Then publish and redeploy through the existing pipeline. A failed Voyage ingestion should retain the existing `embedding_call` event while adding safe fields sufficient to identify the provider's stated `429` reason and correlate it with Voyage support.

## Acceptance criteria

- Terminal Voyage errors expose a safe, useful provider reason plus allowlisted request and retry metadata when supplied.
- Logs never contain the Voyage API key, authorization values, embedding inputs, vectors, arbitrary headers, or a raw/full provider response.
- Runtime retry, ingestion, and startup behavior is unchanged.
- Focused and full repository checks pass.
