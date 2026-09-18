# Prompt 7: Add an explicitly marked live-provider smoke test

Implement the seventh item from `docs/e2e-browser-journeys.md` only if a live-provider smoke test is requested and separately budgeted.

## Dependencies

- Prompts 1–6 must be approved and implemented first.
- Explicit approval, provider credentials, a cost budget, and a non-PR execution policy are required.

## Scope

- Add a separately marked smoke test for the real provider path, if needed.
- Gate execution behind an explicit environment flag and require the configured cost/budget guard.
- Keep it out of the regular Playwright, PR, and `pnpm verify` suites.
- Do not add fallback providers, provider routing, or production behavior.

## Acceptance criteria

- The smoke test cannot run accidentally in the regular suite.
- Its command, required environment, cost implications, and cleanup expectations are documented.
- It records only safe test artifacts and synthetic ticket content.
- Failure does not weaken or mask deterministic browser coverage.
