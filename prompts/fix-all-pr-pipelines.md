# Fix all open PR pipelines

## Goal

Bring every currently open pull request in `hamdi-ben-yaflah/AI-Support-Ticket-Resolution` back to a trustworthy green CI state without changing product behavior or weakening security gates.

## Audit findings (2026-09-17)

- Open PR #1 (pgvector `0.8.1-pg17` → `0.8.6-pg17`) is based on an old `main`. Its quality and integration jobs failed before `pnpm` was on `PATH`; the current `main` workflow already contains the pnpm setup-order fix.
- Open PR #4 (GitHub Actions updates) is also based on an old `main`. Its container job failed on the old runtime image vulnerability set; the current `main` already contains the runtime-image remediation and the merged PR #5 run passes the container job.
- Open PR #3 groups compatible minor updates with unsupported toolchain majors. Its run fails during lint because `typescript-eslint@8.70.0` rejects TypeScript `7.0.2`; the PR also raises `@types/node` from 24 to 26 while the repository is pinned to Node 24.
- Dependency review failures on the stale PR runs are not reproduced on the merged PR #5 run; after rebasing, rerun the check against the current dependency graph rather than disabling the security job or changing its failure policy.
- The working tree is clean and the current branch is the already-merged V2 foundation branch; preserve all existing user work.

## Approved-scope implementation

1. Update `.github/dependabot.yml` so the npm group explicitly groups only minor and patch updates, and ignores major updates for `typescript` and `@types/node` until the runtime/tooling support is intentionally upgraded. Leave the GitHub Actions, Docker, and dependency-review workflows intact.
2. Refresh/rebase PR #1 and PR #4 onto the latest `main`, preserving their intended one-purpose dependency changes. Do not rewrite their unrelated content.
3. Refresh PR #3 onto the latest `main`, keep its compatible dependency updates, and restore the supported toolchain majors (`typescript` 5.x, `@types/node` 24.x). Regenerate only the lockfile metadata required by that manifest change.
4. Rerun all PR checks and inspect failed-step logs. If a check exposes a new, reproducible defect introduced by these dependency updates, make the smallest scoped correction and update this plan before expanding scope.

## Verification and acceptance

- Run locally: `pnpm verify`.
- For database-affecting checks, run `pnpm test:integration` with the repository’s configured PostgreSQL service when available.
- Confirm PR #1, #3, and #4 each have successful Quality, PostgreSQL integration, dependency review, CodeQL, and container checks; confirm publish/deploy remain skipped on pull requests.
- Confirm `git diff` contains only the Dependabot policy/lockfile changes intended by this plan and no raw secrets or unrelated application changes.
- Report exact commands, CI run URLs/results, and any manual GitHub steps required for branch refresh or re-running checks.

## Out of scope

- No application behavior, API contract, database schema, prompt, provider, or deployment changes.
- No removal, softening, or `continue-on-error` workaround for security checks.
- No automatic merge, production deployment, or closure of an open PR unless a superseding PR is explicitly created and the original is demonstrably obsolete.
