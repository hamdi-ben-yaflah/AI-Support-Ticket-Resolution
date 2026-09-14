# CI/CD pipeline for a Dokploy VPS

## Objective

Implement a production-oriented GitHub Actions pipeline that validates every change, exercises the PostgreSQL/pgvector integration boundary, builds and scans one immutable Next.js container, publishes it to GitHub Container Registry (GHCR), and deploys the verified image to the existing Dokploy VPS with health-gated rollback and post-deploy smoke checks.

Keep live Anthropic/Voyage evaluation separate from ordinary pull-request CI so stochastic, paid, or rate-limited provider calls cannot make routine development unreliable.

## Confirmed deployment decisions

- CI/CD platform: GitHub Actions.
- Artifact registry: GHCR.
- Runtime: a single Dokploy Application deployed from the published Docker image.
- Database: a separate Dokploy PostgreSQL service using the existing `pgvector/pgvector:0.8.1-pg17` image, a named persistent volume, and internal-only credentials.
- Production topology: one application replica for this MVP. This avoids multi-instance cache and initialization races while retaining Dokploy's start-first health-gated replacement.
- Production delivery: publish both an immutable commit-SHA tag and the moving `main` channel tag. Dokploy follows `main`; the exact SHA and OCI digest remain available for audit and manual rollback.
- Deployment authentication: an expiring, dedicated Dokploy API token stored only in a protected GitHub `production` environment.
- Live AI evaluation: manual and scheduled workflow on a disposable CI pgvector database, never on the production database and never on each pull request.

## Existing-repository findings

- There are currently no GitHub Actions, Dependabot configuration, production Dockerfile, health routes, or deployment runbook.
- Deterministic unit tests and isolated PostgreSQL integration tests already exist. Integration tests enforce a database name ending in `_test` and use fixed fake vectors.
- The versioned live evaluation harness already exits non-zero on threshold regression and writes a schema-validated, redacted JSON report.
- `/admin/evaluations` and its APIs are explicitly documented as unauthenticated and local-only. They must be unavailable in production before public deployment.
- The project documents Node.js 20, which is end-of-life as of March 2026. The pipeline and image will move to Node.js 24 LTS, subject to the existing suite passing.
- The Git worktree was clean when this plan was prepared.

## Implementation plan

### 1. Normalize repeatable repository checks

Update `package.json`, the lockfile, and the test/tool configuration to expose stable CI commands:

- Add `format` and `format:check` with Prettier, covering source, tests, scripts, configuration, workflows, Markdown, YAML, and JSON while excluding generated/build artifacts.
- Add explicit `typecheck`, `test:coverage`, `db:check`, `build:operations`, and composed `ci` scripts instead of embedding long commands only in workflow YAML.
- Add the Vitest V8 coverage provider and establish checked-in coverage thresholds from the measured baseline. The threshold must prevent coverage regression without inventing an unreachable percentage; report text and LCOV output.
- Keep unit and integration suites separate so integration failures clearly identify the database boundary.
- Add an `engines.node` constraint and a checked-in Node version file for Node.js 24 LTS; update `@types/node` only as required for runtime alignment.
- Add a migration consistency check using Drizzle's supported check/generate behavior, verified locally so CI fails when schema changes are not represented by committed migrations without creating persistent generated noise.

No provider credential will be required for formatting, linting, type checking, unit tests, integration tests, migration checks, or the ordinary production build.

### 2. Add production-safe application boundaries

Add narrowly scoped Next.js and database code with deterministic tests:

- `GET /api/health/live`: dependency-free liveness response containing only status and the non-secret build version.
- `GET /api/health/ready`: bounded database readiness check implemented through `src/db`, returning no connection or SQL details.
- A server-only deployment feature configuration that disables the evaluation page and all `/api/evaluations/**` routes when `ENABLE_LIVE_EVALUATIONS=false` (the production default). Disabled endpoints and the page return a non-revealing 404.
- Preserve local development behavior by documenting explicit enablement for the evaluation lab.
- Add route/config tests for healthy, unavailable-database, enabled-evaluation, and production-disabled cases.

This is the minimum application change needed to deploy safely; it does not add accounts, authentication, a new admin system, or a public evaluation surface.

### 3. Build one hardened, reproducible container

Add `Dockerfile`, `.dockerignore`, and the smallest required startup assets:

- Use a digest-pinned Node.js 24 Debian slim base and Corepack/pnpm with the repository's exact package-manager version.
- Use multi-stage dependency, build, operations-bundle, and runtime stages.
- Enable Next.js `output: "standalone"` and copy only the standalone server, static/public assets, versioned migrations, knowledge-base data, and bundled deployment operations into the runtime image.
- Compile the migration and existing idempotent ingestion entrypoints into production Node artifacts during the image build; do not ship TypeScript tooling or development dependencies in the runtime image.
- At container startup, apply committed Drizzle migrations, run idempotent knowledge ingestion, and then `exec` the Next.js standalone server. A failure in migration or ingestion prevents the new container from becoming healthy, leaving the previous Dokploy deployment serving traffic.
- Run the application as a non-root user, set production defaults, add an OCI health check, and expose only port 3000.
- Stamp the image with the commit SHA and standard OCI source/revision labels. Return that SHA from liveness so CD can prove which build is serving.
- Pin the production pgvector image by version and document digest pinning in Dokploy.

Migration policy will be documented as forward-compatible expand/contract changes. Application rollback does not reverse a database migration automatically.

### 4. Add the pull-request and main-branch pipeline

Create a GitHub Actions workflow with pinned action commit SHAs, least-privilege permissions, explicit timeouts, and concurrency cancellation:

1. **Quality job**
   - Checkout without persisted credentials.
   - Install Node.js 24 and the pinned pnpm version with dependency caching.
   - Run frozen-lockfile install, formatting check, ESLint, TypeScript, migration consistency, deterministic unit tests with coverage, and `next build`.
   - Upload coverage/test evidence on failure and success with bounded retention.

2. **Integration job**
   - Start a digest-pinned pgvector PostgreSQL service with a health check.
   - Use a dedicated `support_copilot_ci_test` database URL.
   - Apply committed migrations and run `pnpm test:integration` without provider keys.

3. **Container verification job**
   - Build the exact production Docker target without publishing on pull requests.
   - Start it against the CI database with deterministic/test-safe initialization where needed.
   - Probe liveness/readiness and run a minimal HTTP smoke test.
   - Scan the filesystem/image for high and critical known vulnerabilities, failing only on actionable findings according to a documented ignore policy.

4. **Publish job (`main` only)**
   - Authenticate to GHCR with the ephemeral `GITHUB_TOKEN` and only `packages: write` permission.
   - Build once with BuildKit cache and publish commit-SHA plus `main` tags for `linux/amd64`.
   - Generate an SPDX/CycloneDX SBOM and GitHub build-provenance attestation where repository visibility/features support it.
   - Pass the published digest to deployment; never rebuild inside the deployment job.

5. **Deploy job (`main` only)**
   - Depend on all required CI and image jobs.
   - Target the protected GitHub `production` environment so secrets are unavailable until any configured approval succeeds.
   - Trigger the configured Dokploy Application through its HTTPS API using `DOKPLOY_URL`, `DOKPLOY_APPLICATION_ID`, and an expiring `DOKPLOY_API_TOKEN`.
   - Poll the public health endpoint until it is ready and reports the expected commit SHA, with a hard timeout.
   - Run safe smoke checks for the home page, liveness/readiness, and production-disabled evaluation routes.
   - Fail visibly if deployment does not converge. Dokploy's Swarm health/update policy performs the automatic runtime rollback.

The workflow will avoid `pull_request_target`, untrusted PR secrets, mutable third-party action tags, privileged containers, and SSH access to the VPS.

### 5. Add a separate AI evaluation workflow

Create a manual/scheduled GitHub Actions workflow that:

- Runs weekly and through `workflow_dispatch`, never for ordinary pull requests or every push.
- Uses a protected `ai-evaluation` environment containing Anthropic and Voyage credentials.
- Starts a disposable pgvector service, migrates it, ingests the committed synthetic Markdown corpus, and runs `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`.
- Enforces a workflow timeout and the harness's existing concurrency/threshold behavior.
- Uploads the redacted JSON report even when thresholds fail, with short retention and no raw provider payloads.
- Records the dataset, prompt, model, retrieval, and image/source revision through the existing report plus workflow metadata.
- Initially remains independent of production deployment because the latest documented live run is rate-limit dominated. A future, separately approved change may promote a stable evaluation to a release gate.

### 6. Add supply-chain and dependency maintenance

- Add Dependabot updates for pnpm, GitHub Actions, and Docker on a grouped weekly schedule with sensible pull-request limits.
- Add CodeQL for JavaScript/TypeScript on pull requests, main, and a weekly schedule when GitHub code scanning is available for the repository.
- Add pull-request dependency review when repository visibility/licensing supports it; otherwise retain `pnpm audit`, Dependabot, and container scanning as the portable baseline.
- Set explicit workflow permissions per job and pin every third-party action to a reviewed full commit SHA with an adjacent version comment.
- Do not expose provider keys to dependency-update or fork pull requests.

### 7. Document Dokploy and VPS configuration

Add a deployment/operations runbook and update `README.md` with exact setup and verification steps:

- Create the Dokploy Postgres database with the pgvector image, named volume, strong generated credentials, no external port, resource limits, and a connection URL shared only over the internal Dokploy network.
- Configure encrypted S3-compatible scheduled database backups, retention, and a restore drill. Also back up Dokploy's own state separately.
- Create the Dokploy Application from GHCR, configure port 3000, the `main` image channel, secrets, a single replica, and the liveness health route.
- Apply Swarm update settings: start-first, parallelism 1, bounded monitor/start period, and `FailureAction: rollback`.
- Enable registry-based manual rollback and retain commit-SHA images according to a documented policy.
- Configure the domain through Traefik with HTTPS redirect, HSTS, secure headers, and a conservative rate limit tuned for slow AI requests.
- Keep the Dokploy dashboard and database ports off the public network; document 2FA/passkeys, firewall, SSH key-only access, root-login disablement, unattended security updates, Fail2Ban/CrowdSec, Docker log rotation, and `no-new-privileges`.
- Configure Dokploy deployment/server notifications and external uptime checks for liveness/readiness. External log shipping is recommended but not introduced as a new application dependency in this task.
- List every GitHub secret/variable and every Dokploy environment value without committing values.
- Document initial provisioning, routine release, failed-deploy diagnosis, rollback, database restore, token rotation, and image cleanup procedures.

Repository automation will be implemented and tested locally. Actual VPS/Dokploy mutations require the user's Dokploy URL, application/database setup, domain, S3 destination, and GitHub environment configuration and will be presented as explicit manual steps unless separately authorized and connected.

## Expected files

- `.github/workflows/pipeline.yml`
- `.github/workflows/ai-evaluation.yml`
- `.github/workflows/codeql.yml` (if supported as a separate workflow)
- `.github/dependabot.yml`
- `.dockerignore`
- `.node-version`
- `Dockerfile`
- container startup/operations build files under `scripts/`
- health Route Handlers under `src/app/api/health/`
- database readiness/migration helpers under `src/db/`
- production evaluation feature configuration under `src/config/`
- focused tests under `tests/app`, `tests/config`, and/or `tests/db`
- `docs/operations/dokploy-deployment.md`
- updates to `.env.example`, `next.config.ts`, `package.json`, `pnpm-lock.yaml`, Vitest configuration, `.gitignore`, and `README.md`

Exact filenames may be adjusted to match existing module boundaries, but no unrelated product feature or refactor will be included.

## Acceptance criteria

- Pull requests receive required, deterministic formatting, lint, type, unit/coverage, migration, integration, build, container smoke, and security results without provider secrets.
- A merge to `main` cannot publish or deploy unless all required checks pass.
- The published runtime image is non-root, contains no secrets or development toolchain, is identified by commit SHA/digest, and passes vulnerability and health checks.
- Production deployment uses the already-built image, a protected environment, an expiring Dokploy token, a readiness gate, and verifies the exact expected revision.
- A bad application release fails health checks and is eligible for Dokploy automatic rollback; prior SHA images remain available for manual rollback.
- Production PostgreSQL remains internal, persistent, pgvector-enabled, backed up off-host, and restorable by documented procedure.
- Live evaluation is manual/scheduled, cost-bounded, redacted, artifact-producing, and isolated from production and ordinary CI.
- The unauthenticated evaluation UI and APIs cannot be reached in production.
- No raw tickets, prompts, provider responses, credentials, database URLs, vectors, or evaluation content are added to workflow logs or committed artifacts.

## Verification after implementation

Run locally:

```bash
pnpm format:check
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm test:coverage
pnpm test:integration
pnpm db:check
pnpm build
docker build --target runtime -t support-copilot:ci .
```

Use a disposable pgvector database to start the container and verify liveness/readiness, revision reporting, production evaluation blocking, graceful shutdown, and idempotent migration/ingestion behavior. Validate all workflow YAML and scan the built container locally when the corresponding tools are available.

After the user configures GitHub and Dokploy, open a test pull request, merge it, observe the protected deployment, confirm the expected SHA from the live health endpoint, intentionally deploy a health-check-breaking test revision in a controlled exercise, verify automatic rollback, and perform a documented database restore drill.

## References reviewed

- Local Next.js 16 deployment, production checklist, self-hosting, and Vitest guides under `node_modules/next/dist/docs/`.
- Dokploy Going Production, Docker Registry/GHCR, Auto Deploy, Rollbacks, Database Backups/Restore, and Production Hardening documentation.
- GitHub Actions security hardening, protected environments, OIDC, artifact attestation, dependency review, and CodeQL documentation.
- Node.js release lifecycle: Node.js 20 is EOL; Node.js 24 is LTS on the current project date.
