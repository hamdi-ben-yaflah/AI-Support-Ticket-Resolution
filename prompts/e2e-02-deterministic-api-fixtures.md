# Prompt 2: Add deterministic API fixtures

Implement the second item from `docs/e2e-browser-journeys.md`: add deterministic API fixtures for reply, refund-review, human-review, and failure responses.

## Dependencies

- Prompt 1 (`prompts/e2e-01-playwright-setup.md`) must be approved and implemented first.

## Scope

- Add synthetic, schema-validated fixtures for supported reply, refund-review, needs-human-review, retryable failure, source detail, and confirmation responses.
- Build fixtures through the existing Zod/domain schemas so contract drift fails during test setup.
- Add shared helpers for routing resolution, source, and confirmation requests while recording request counts and bodies.
- Keep regular tests network-free from Anthropic and Voyage AI.
- Do not add the P0 journey specs in this prompt.

## Acceptance criteria

- Fixtures contain no secrets, real customer data, raw provider responses, or live-provider calls.
- Helpers can assert request count, request body, and route-specific responses.
- Fixture construction fails clearly when the existing API/domain contract changes.
- Existing tests and type checks remain passing.

## Verification

- Run focused fixture/helper tests if added.
- Run the Playwright test command against the fixture harness.
- Run `pnpm verify`.
