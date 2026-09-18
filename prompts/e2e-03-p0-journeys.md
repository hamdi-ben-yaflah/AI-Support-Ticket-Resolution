# Prompt 3: Implement P0 browser journeys 1–5

Implement the third item from `docs/e2e-browser-journeys.md`: implement P0 journeys 1–5 using the deterministic fixtures.

## Dependencies

- Prompt 1 (`prompts/e2e-01-playwright-setup.md`).
- Prompt 2 (`prompts/e2e-02-deterministic-api-fixtures.md`).

## Scope

Add the first five journey specs:

1. `resolve-ticket-displays-grounded-draft-and-citations`
2. `abstains-with-human-review-when-evidence-is-insufficient`
3. `rejects-refund-review-without-confirmation`
4. `confirms-refund-review-and-records-local-mock-result`
5. `repeated-refund-confirmation-is-idempotent`

Cover the document’s positive and negative assertions, including loading states, accessible rendered fields, selected customer tier, exactly-one resolution request, citation ownership in displayed source content, explicit confirmation, rejection without confirmation, and idempotent repeat behavior.

Use accessible locators first. Add `data-testid` only where a stable semantic locator is not practical. Do not change product behavior unless a journey exposes a defect required to satisfy the approved acceptance criteria.

## Acceptance criteria

- All five P0 specs pass deterministically without provider network access.
- The abstention journey proves no reply, citation, source request, or refund control is shown.
- Refund rejection proves no confirmation request or audit result is created through the test boundary.
- Confirmation proves the request body is exactly `{ "confirmed": true }` and renders local-mock-only status.
- Repeat confirmation proves the original proposal/result is reused.

## Verification

- Run the five focused Playwright specs.
- Run the complete Playwright suite.
- Run `pnpm verify`.
