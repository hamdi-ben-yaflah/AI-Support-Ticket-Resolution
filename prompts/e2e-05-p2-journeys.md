# Prompt 5: Implement P2 browser journeys 15–17

Implement the fifth item from `docs/e2e-browser-journeys.md`: implement P2 journeys 15–17 after P1 coverage is stable.

## Dependencies

- Prompts 1–4 must be approved and implemented first.

## Scope

Implement coverage for:

- hiding evaluation functionality when live evaluations are disabled;
- preventing duplicate resolution submissions;
- clearing stale results when ticket input changes.

Treat the deployment-disabled checks primarily as API/deployment coverage; add browser coverage only where it provides meaningful value. Assert request counts and disabled processing controls for duplicate submission behavior, and ensure only the latest ticket result remains visible after input changes.

## Acceptance criteria

- P2 journey behavior is covered without weakening existing safety or accessibility assertions.
- Duplicate clicks produce only one resolution request.
- Editing ticket text clears the previous proposal and returns the form to idle behavior.
- Disabled evaluation endpoints/pages remain unavailable under the configured deployment guard.

## Verification

- Run focused P2 specs and relevant route tests.
- Run the complete Playwright suite.
- Run `pnpm verify`.
