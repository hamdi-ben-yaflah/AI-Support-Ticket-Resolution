# Prompt 1: Set up Playwright browser testing

Implement the first item from `docs/e2e-browser-journeys.md`: set up Playwright configuration, scripts, browser installation, and CI artifacts.

## Scope

- Add `@playwright/test` as a direct development dependency with pnpm.
- Add `playwright.config.ts` with a local Next.js web server, deterministic base URL, Chromium project, CI retries, first-retry traces, and usable reporters/artifact paths.
- Add package scripts for running browser tests and installing/checking browsers.
- Keep generated reports and browser artifacts out of source control through narrow ignore updates if required.
- Do not add journey specs or fixtures in this prompt.

## Acceptance criteria

- A clean checkout can install dependencies and start the app for Playwright.
- The configured browser test command discovers an empty or placeholder `e2e/` suite without configuration errors.
- CI retains a trace on the first retry and exposes test/report artifacts.
- Existing unit, integration, lint, typecheck, migration, operations-build, and Next build configuration remains intact.

## Verification

- Run the Playwright installation/check command.
- Run the configured browser test command.
- Run `pnpm verify`.
