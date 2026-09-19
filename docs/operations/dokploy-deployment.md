# Dokploy production deployment

This runbook provisions and operates the single-replica Support Ticket Resolution Copilot on a Dokploy VPS. GitHub Actions builds and verifies the image; Dokploy only pulls and runs it. Never build the repository or run live evaluation against the production database on the VPS.

## Production topology

- One Dokploy Application using `ghcr.io/<owner>/<repository>:main`.
- One separate Dokploy PostgreSQL service using `pgvector/pgvector:0.8.1-pg17`.
- One internal Dokploy network shared only by the application and database.
- One public HTTPS application domain routed by Traefik to port 3000.
- No public PostgreSQL, Docker API, Traefik dashboard, or raw Dokploy port.

The workflow also retains an immutable `${GITHUB_SHA}` image tag and the OCI digest. `main` is only the release channel Dokploy follows.

## 1. Provision PostgreSQL

1. Create a PostgreSQL service in the same Dokploy project/environment as the application.
2. Use `pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21`. Review and update the digest through a pull request when the pinned image changes.
3. Generate distinct high-entropy values for the database name, user, and password. Do not reuse repository examples.
4. Attach a named volume at `/var/lib/postgresql/data`.
5. Leave the external/public port empty. Connect through the internal service hostname only.
6. Set conservative CPU and memory reservations/limits based on the VPS size, leaving capacity for a start-first application replacement and PostgreSQL maintenance.
7. Start the service and verify `pg_isready` reports healthy from inside the Dokploy network.

The application `DATABASE_URL` has this shape and must exist only in Dokploy's encrypted configuration:

```text
postgresql://<user>:<percent-encoded-password>@<internal-postgres-host>:5432/<database>
```

Do not use the production URL in GitHub Actions. CI and live evaluation workflows create disposable databases.

## 2. Configure backups

Configure an encrypted, private S3-compatible destination in Dokploy, then:

1. In the PostgreSQL service's **Backup** tab, schedule a daily logical backup with a production-specific prefix.
2. Apply bucket-side encryption, object versioning, restricted credentials, and a retention policy appropriate to the data-recovery objective. A practical starting point is 14 daily and 8 weekly backups.
3. Click **Test**, confirm the object exists off-host, and configure failure notifications.
4. Separately configure **Web Server → Backups** for Dokploy's own database and `/etc/dokploy` state.
5. Quarterly, restore a selected production backup into a new isolated database, run `pnpm db:migrate` against it from a controlled operator environment, and verify document/run counts plus application readiness. Record the backup identifier, elapsed time, verifier, and result. Never test a restore over the live database.

Dokploy's database restore UI expects backups produced by Dokploy. A production restore is a deliberate incident action: stop writes, preserve the current database, restore into a new service where possible, validate, then switch `DATABASE_URL` and redeploy.

## 3. Configure GHCR and the application

1. Publish the first image by running the pipeline from `main`, or temporarily run only through the publish job before enabling deployment.
2. In Dokploy, add a GHCR registry credential. Prefer a dedicated read-only package token; scope it to this package and set an expiry where the GitHub account type supports it.
3. Create one Application with Docker Registry as its source.
4. Set the image to `ghcr.io/<lowercase-owner>/<lowercase-repository>:main`, registry `ghcr.io`, and container port `3000`.
5. Configure exactly one replica for this MVP.
6. Add the environment values in the next section. Keep `ENABLE_LIVE_EVALUATIONS=false` and `SKIP_KNOWLEDGE_INGESTION=false`.
7. Deploy once and confirm migrations and idempotent knowledge ingestion complete before the server begins listening.

The runtime image is non-root and contains the standalone Next.js server, committed migrations, synthetic Markdown knowledge, and compiled migration/ingestion entrypoints. It does not contain TypeScript tooling or development dependencies.

## 4. Dokploy application environment

Store values in Dokploy's encrypted environment or an integrated secret provider. Do not put them in GitHub workflow logs or repository files.

Required secrets:

- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`
- `DATABASE_URL`
- `SESSION_COOKIE_SECRET` (random, at least 32 characters)
- `LLM_MODEL`

Required production controls:

- `APP_ORIGIN=https://your-public-domain.example` (exact public origin; no path or trailing slash)
- `ENABLE_LIVE_EVALUATIONS=false` (production always disables HTTP evaluations, even if set to true)
- `SKIP_KNOWLEDGE_INGESTION=false`

Reviewed runtime configuration:

- `AI_REQUEST_TIMEOUT_MS=15000`
- `AI_MAX_RETRIES=2`
- `LOG_LEVEL=info`
- `RESOLUTION_MINIMUM_CONFIDENCE=0.65`
- `EMBEDDING_MODEL=voyage-4`
- `EMBEDDING_DIMENSIONS=1024`
- `EMBEDDING_BATCH_SIZE=64`
- `EMBEDDING_REQUEST_TIMEOUT_MS=20000`
- `EMBEDDING_MAX_RETRIES=2`
- `DATABASE_READINESS_TIMEOUT_MS=3000`
- `RETRIEVAL_CANDIDATE_COUNT=8`
- `RETRIEVAL_FINAL_COUNT=5`
- `RETRIEVAL_MINIMUM_SIMILARITY=0.65`
- `RETRIEVAL_MAXIMUM_CONTEXT_TOKENS=3500`
- `RETRIEVAL_MINIMUM_EVIDENCE_COUNT=1`

Optional Langfuse Cloud tracing:

- `LANGFUSE_ENABLED=true`
- `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` as encrypted values from one Langfuse project
- `LANGFUSE_BASE_URL` for the selected Langfuse region (omit to use the SDK default)
- `LANGFUSE_ENVIRONMENT=production`
- `LANGFUSE_RELEASE=<deployed-commit-sha>`

Leave all Langfuse values absent and `LANGFUSE_ENABLED=false` to disable export. Never configure
only one credential. Tracing is diagnostic and fail-open; PostgreSQL records and Pino logs remain
the operational systems of record. Follow the
[Langfuse observability runbook](langfuse-observability.md) to verify metadata boundaries and
investigate provider errors or latency.

Leave evaluation pricing unset in production. `APP_VERSION`, `NODE_ENV`, `HOSTNAME`, `PORT`, and the secure evaluation default are stamped or set by the image and should not be overridden. `SKIP_KNOWLEDGE_INGESTION=true` exists only for provider-free container smoke tests; setting it in production can leave the knowledge base stale.

## 5. Health-gated replacement and rollback

In **Application → Advanced → Cluster Settings → Swarm Settings**, use a liveness check equivalent to the image health check:

```json
{
  "Test": [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/api/health/live',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
  ],
  "Interval": 15000000000,
  "Timeout": 3000000000,
  "StartPeriod": 30000000000,
  "Retries": 4
}
```

Use this update configuration:

```json
{
  "Parallelism": 1,
  "Delay": 10000000000,
  "Monitor": 60000000000,
  "FailureAction": "rollback",
  "Order": "start-first"
}
```

Allow a 20–30 second termination grace period so Next.js can drain in-flight requests. Apply `no-new-privileges` in the application's advanced security settings.

The liveness route is dependency-free and identifies the build. Readiness checks PostgreSQL with a bounded probe. Swarm uses liveness for process replacement; GitHub deployment polling requires liveness to return the expected commit SHA and then requires readiness. Migration or ingestion failure occurs before the server starts, so the new task cannot become healthy.

Database migrations must be forward-compatible expand/contract changes. Application rollback does not reverse a migration.

## 6. Domain and edge controls

1. Add the production domain to the Application and route it to port 3000.
2. Enable automatic TLS and HTTP-to-HTTPS redirect.
3. Add a Traefik secure-headers middleware with HSTS only after HTTPS is confirmed for the domain and all intended subdomains.
4. Configure the resolution route rate limit and request body/read limits using [AI security controls](ai-security.md). The application defaults to 20 resolutions/minute and 2 active resolutions per process; edge limits remain necessary. Verify provider-account spending limits and alerts separately.
5. Confirm `/api/health/live` and `/api/health/ready` remain lightweight enough for monitors.
6. Verify `/admin/evaluations`, `/api/evaluations/run`, `/api/evaluations/runs`, and `/api/evaluations/compare` all return 404 publicly.

Do not expose the Dokploy dashboard on its raw port. Put it behind a private network/VPN or a separately protected HTTPS hostname. Keep the Traefik dashboard closed.

## 7. GitHub environments and settings

Create a protected `production` environment with required reviewers if available and restrict it to `main`.

Production environment secrets:

- `DOKPLOY_URL`: HTTPS origin of the Dokploy instance, without an API path.
- `DOKPLOY_APPLICATION_ID`: application identifier from Dokploy.
- `DOKPLOY_API_TOKEN`: dedicated, expiring token with only the required API/CLI access.

Production environment variable:

- `PRODUCTION_URL`: public HTTPS origin of the application.

Create a protected `ai-evaluation` environment. It is independent of production deployment.

AI evaluation secrets:

- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`

AI evaluation variable:

- `LLM_MODEL`

Protect `main` and require the Quality, PostgreSQL integration, Verify production container, and CodeQL checks that are supported by the repository's GitHub plan. Dependency Review is advisory because private repositories require GitHub Advanced Security. Require review for workflow changes and prevent force pushes. Provider secrets are never used by pull-request CI.

The deploy job calls Dokploy's HTTPS `POST /api/application.deploy` endpoint with `x-api-key`, waits for the public liveness payload to report `${GITHUB_SHA}`, then runs safe smoke checks. There is no SSH credential in GitHub.

## 8. Initial release verification

After configuration:

1. Open a pull request and confirm formatting, lint, types, migration consistency, coverage, Next.js build, PostgreSQL integration, container smoke, dependency audit, vulnerability scan, and CodeQL complete without provider secrets.
2. Merge to `main` and approve the `production` environment.
3. Confirm GHCR contains both `main` and the 40-character SHA tag at the same digest.
4. Confirm the deployed `GET /api/health/live` body contains that SHA and `GET /api/health/ready` is 200.
5. Confirm the home page is 200 and all evaluation surfaces listed above are 404.
6. Submit only a synthetic ticket and verify resolution, citations, and a mock action confirmation.
7. In a controlled maintenance exercise, deploy a revision whose health check fails, verify Swarm returns to the previous healthy digest, and remove the test revision afterward.
8. Complete and record the isolated restore drill described above.

## 9. Routine release and diagnosis

A routine release is a reviewed merge to `main`. The pipeline verifies one image, publishes that exact image under SHA and `main`, creates an SPDX SBOM, attempts GitHub build provenance when supported, triggers Dokploy, and proves the serving revision.

Trivy scans repository dependencies and the runtime image. Fixed high or critical vulnerabilities fail the pipeline; `ignore-unfixed` filters findings that have no upstream remediation. There is no checked-in vulnerability ignore file. Any future exception must be a reviewed, narrowly identified advisory with an owner, rationale, and expiry date.

If deployment does not converge:

1. Check the GitHub deploy job for trigger, timeout, revision mismatch, or smoke-step failure. Responses and secrets are intentionally not printed.
2. In Dokploy, inspect the new task's status and sanitized startup logs for migration, ingestion, database reachability, or provider availability events.
3. Confirm Dokploy can pull the `main` digest and the registry credential has not expired.
4. Confirm the app and PostgreSQL share the intended internal network and `DATABASE_URL` points to the internal hostname.
5. Confirm the public domain routes to port 3000 and the old deployment is still serving during a failed start-first update.

Never bypass readiness by starting the server before migrations/ingestion, and never print the environment to diagnose a deployment.

## 10. Manual rollback

Automatic rollback is handled by Swarm for an unhealthy replacement. For a manual rollback:

1. Identify the last known-good SHA and digest from the previous GitHub publish job or GHCR package history.
2. In Dokploy, change the Application image from `:main` to the immutable `:<full-sha>` tag (or use Dokploy's registry-based rollback UI), then deploy.
3. Verify liveness reports that exact SHA, readiness is 200, the home page is 200, and evaluation routes remain 404.
4. Keep the application pinned while the bad release is investigated. Restore `:main` only after `main` points to a corrected verified image.

Do not roll database migrations backward automatically. If an incompatible migration escaped review, treat it as a database incident and restore or repair using a separately reviewed procedure.

## 11. Rotation, retention, and host maintenance

- Rotate the Dokploy API token at least quarterly and before expiry: create a replacement, update the protected GitHub secret, run a deployment, then revoke the old token.
- Rotate provider, session, database, S3, and GHCR credentials on their own schedules and immediately after suspected exposure.
- Keep at least the last 20 successful SHA images and 30 days of releases. Delete only unreferenced older SHA tags after confirming they are outside the rollback window; never delete the active or last known-good digest.
- Configure deployment/server failure notifications and external uptime checks for liveness and readiness. Route structured container logs to existing external logging if available; this task adds no logging service.
- Enable passkeys or 2FA for every Dokploy operator.
- Use an Ubuntu/Debian LTS host with unattended security updates, SSH keys only, root login and password login disabled, and Fail2Ban or CrowdSec.
- Restrict the firewall to SSH (preferably through a trusted network), HTTP, and HTTPS. Account for Docker-published-port firewall behavior.
- Enable Docker `live-restore` and bounded `json-file` rotation; never expose the Docker socket over TCP.
- Review disk, database volume, backup, certificate, token, and image-retention status monthly.

Reference the current [Dokploy production hardening](https://docs.dokploy.com/docs/core/guides/production-hardening), [Going Production](https://docs.dokploy.com/docs/core/applications/going-production), [database backup](https://docs.dokploy.com/docs/core/databases/backups), [restore](https://docs.dokploy.com/docs/core/databases/restore), and [API](https://docs.dokploy.com/docs/api) documentation before changing production settings.
