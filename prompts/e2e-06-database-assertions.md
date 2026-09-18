# Prompt 6: Add targeted database assertions

Implement the sixth item from `docs/e2e-browser-journeys.md`: add database assertions only to ownership, persistence, and idempotency tests.

## Dependencies

- Prompts 1–5 must be approved and implemented first.
- A dedicated test PostgreSQL database and its safe test configuration must be available before implementation.

## Scope

- Extend only the relevant browser journeys with database checks for session ownership, persisted action state, and single logical audit result.
- Use the repository’s existing Drizzle data-access layer and test database conventions; do not issue SQL from browser specs.
- Isolate or clean test data safely between tests.
- Preserve synthetic data and avoid asserting on raw ticket text or provider payloads.

## Acceptance criteria

- Ownership tests prove the foreign session cannot access or mutate the original resolution/action.
- Confirmation and repeated confirmation produce one logical persisted audit result.
- Database assertions are absent from unrelated presentation-only journeys.
- The suite fails clearly when the dedicated test database is unavailable rather than silently targeting a non-test database.

## Verification

- Run the targeted database-backed browser tests with the dedicated test database.
- Run the existing integration suite.
- Run `pnpm verify`.
