# Prompt 4: Implement P1 browser journeys 6–14

Implement the fourth item from `docs/e2e-browser-journeys.md`: implement P1 journeys 6–14 after the P0 milestone is stable.

## Dependencies

- Prompts 1–3 must be approved and implemented first.

## Scope

Implement browser coverage for:

- ticket validation and boundary lengths;
- retry after a retryable resolution failure;
- retry of a temporarily unavailable citation source;
- source ownership across sessions;
- refund-confirmation ownership across sessions;
- opening the local evaluation lab;
- running an evaluation and downloading its JSON report;
- filtering failed evaluation cases;
- comparing compatible evaluation runs.

Keep local evaluation journeys deterministic with mocked reports. Use separate browser contexts or Playwright API requests for session ownership checks. Do not run the real 36-case evaluation or live providers in the regular PR suite.

## Acceptance criteria

- P1 journeys cover the specified success, failure, ownership, loading, filtering, and download assertions.
- Cross-session requests cannot read or mutate another session’s proposal/source.
- The normal suite remains network-free and deterministic.
- The live evaluation path is not accidentally enabled in ordinary browser tests.

## Verification

- Run focused P1 specs.
- Run the complete Playwright suite.
- Run `pnpm verify`.
