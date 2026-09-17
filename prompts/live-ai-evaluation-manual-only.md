# Plan: Make live AI evaluation manual-only

## Objective

Ensure the GitHub Actions workflow that makes real Anthropic and Voyage AI calls can run only through an explicit manual dispatch, never from a cron schedule, push, pull request, deployment, or other automatic repository event.

## Scope

1. Remove the `schedule` trigger from `.github/workflows/ai-evaluation.yml` and retain only `workflow_dispatch`.
2. Keep the existing disposable pgvector service, provider-secret boundaries, concurrency guard, timeout, redacted artifact upload, and non-release-gate behavior unchanged.
3. Update the current README and V1 technical-spec wording from “manual/weekly” to “manual-only” so operator documentation matches the workflow.

## Out of scope

- No changes to evaluation code, datasets, prompts, models, retrieval, thresholds, secrets, artifact retention, or provider-call behavior after a manual run starts.
- No changes to the CI/production, CodeQL, Dependabot, backup, or other non-provider schedules.
- No live Anthropic or Voyage AI calls while implementing or verifying this trigger change.

## Verification

1. Inspect the workflow diff and confirm `workflow_dispatch` is its only event trigger.
2. Parse the workflow YAML through the repository formatting/configuration checks.
3. Run `pnpm exec prettier --check .github/workflows/ai-evaluation.yml README.md docs/ai-support-copilot-technical-spec.md prompts/live-ai-evaluation-manual-only.md`.
4. Run `pnpm verify` and confirm deterministic checks and the production build still pass without provider calls.
5. Confirm repository documentation no longer describes live AI evaluation as scheduled or weekly.

## Acceptance criteria

1. GitHub cannot start the live-provider evaluation workflow on a cron, push, pull request, deployment, or other automatic repository event.
2. An authorized operator can still start it explicitly with **Run workflow**.
3. The workflow continues to use an isolated database and upload only the existing redacted report.
4. No provider call is made during local verification.
