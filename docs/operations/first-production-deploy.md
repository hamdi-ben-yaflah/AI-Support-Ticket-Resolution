# First production deployment checklist

Use this checklist when you are ready to deploy the Support Ticket Resolution Copilot for the first time. It is intentionally ordered so that the final push to `main` happens only after Dokploy, PostgreSQL, GHCR, DNS, and GitHub are ready.

> **Important:** this repository currently uses `master`, but the delivery workflow deploys only from `main`. Do not run the branch rename and push in step 8 until every earlier step is complete. The first push to `main` triggers the production pipeline.

For backup, rollback, hardening, and incident procedures, keep the full [Dokploy production runbook](dokploy-deployment.md) nearby.

## 1. Collect the required values

Prepare these values without adding them to the repository:

- GitHub owner and repository name, in lowercase for the container image path.
- Production application domain, such as `support.example.com`.
- Dokploy HTTPS origin, such as `https://dokploy.example.com`.
- A strong PostgreSQL database name, username, and password.
- Anthropic and Voyage API keys.
- The Anthropic model identifier to use as `LLM_MODEL`.
- A random `SESSION_COOKIE_SECRET` containing at least 32 characters.
- A private S3-compatible backup destination and restricted credentials.

## 2. Provision PostgreSQL in Dokploy

In the same Dokploy project and environment that will contain the application:

1. Create a PostgreSQL service.
2. Set its image to:

   ```text
   pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
   ```

3. Configure the generated database name, username, and password.
4. Mount a named persistent volume at `/var/lib/postgresql/data`.
5. Do not publish a PostgreSQL port to the internet.
6. Start the service and record its internal Dokploy hostname.
7. Build the application connection string. Percent-encode special characters in the password:

   ```text
   postgresql://<user>:<percent-encoded-password>@<internal-postgres-host>:5432/<database>
   ```

8. Configure a daily encrypted S3-compatible backup, retention, and backup-failure notifications.
9. Use Dokploy's backup test and confirm that a backup object appears in the private bucket.

## 3. Prepare GHCR access for Dokploy

1. Create a dedicated GitHub credential that can read this repository's container package. Give it package-read access only where possible and set an expiry.
2. In Dokploy, add a registry credential for `ghcr.io` using that credential and its GitHub username.
3. The application image name will be:

   ```text
   ghcr.io/<lowercase-owner>/<lowercase-repository>:main
   ```

The first image does not exist until the GitHub pipeline reaches its publish job. Dokploy may be configured with the image name before that first publish.

## 4. Create the Dokploy application

1. Create one Dokploy Application with **Docker Registry** as its source.
2. Select the GHCR credential from step 3.
3. Enter the `:main` image name from step 3.
4. Set the container port to `3000`.
5. Set the replica count to exactly `1`.
6. Attach the application and PostgreSQL service to the same internal Dokploy network.
7. Add the production domain, enable TLS, and redirect HTTP to HTTPS.
8. Do not deploy yet if GHCR does not contain the image.

## 5. Configure the Dokploy application environment

Add these as encrypted values in Dokploy. Replace every placeholder; do not paste this block into a repository file with real values.

```dotenv
ANTHROPIC_API_KEY=<secret>
VOYAGE_API_KEY=<secret>
DATABASE_URL=<internal-postgresql-url-from-step-2>
SESSION_COOKIE_SECRET=<random-value-at-least-32-characters>
LLM_MODEL=<anthropic-model-id>

ENABLE_LIVE_EVALUATIONS=false
SKIP_KNOWLEDGE_INGESTION=false

AI_REQUEST_TIMEOUT_MS=15000
AI_MAX_RETRIES=2
LOG_LEVEL=info
RESOLUTION_MINIMUM_CONFIDENCE=0.65
EMBEDDING_MODEL=voyage-4
EMBEDDING_DIMENSIONS=1024
EMBEDDING_BATCH_SIZE=64
EMBEDDING_REQUEST_TIMEOUT_MS=20000
EMBEDDING_MAX_RETRIES=2
DATABASE_READINESS_TIMEOUT_MS=3000
RETRIEVAL_CANDIDATE_COUNT=8
RETRIEVAL_FINAL_COUNT=5
RETRIEVAL_MINIMUM_SIMILARITY=0.65
RETRIEVAL_MAXIMUM_CONTEXT_TOKENS=3500
RETRIEVAL_MINIMUM_EVIDENCE_COUNT=1
```

Do not override `APP_VERSION`, `NODE_ENV`, `HOSTNAME`, or `PORT`; the image supplies them.

## 6. Configure health-gated replacement

In the application's advanced cluster or Swarm settings, use the following health check:

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

Use this update policy:

```json
{
  "Parallelism": 1,
  "Delay": 10000000000,
  "Monitor": 60000000000,
  "FailureAction": "rollback",
  "Order": "start-first"
}
```

Also configure a 20–30 second termination grace period and enable `no-new-privileges`.

## 7. Configure the protected GitHub environment

In GitHub, open **Repository → Settings → Environments → New environment**, then create an environment named exactly `production`.

Add these **environment secrets**:

| Name                     | Value                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `DOKPLOY_URL`            | Dokploy HTTPS origin without `/api` or a trailing slash, for example `https://dokploy.example.com` |
| `DOKPLOY_APPLICATION_ID` | The application identifier from Dokploy, not the project identifier                                |
| `DOKPLOY_API_TOKEN`      | A dedicated, expiring Dokploy API token                                                            |

Add this **environment variable**:

| Name             | Value                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `PRODUCTION_URL` | Public application HTTPS origin without a trailing slash, for example `https://support.example.com` |

Then:

1. Restrict the environment to the `main` branch.
2. Add required reviewers if your GitHub plan supports them.
3. Protect `main` and require the Quality, PostgreSQL integration, Verify production container, and CodeQL checks after they have appeared at least once.

The production deployment does not use the Anthropic or Voyage keys from GitHub. Those provider keys belong only in Dokploy and, separately, in the optional `ai-evaluation` GitHub environment.

## 8. Trigger the first deployment

Before continuing, verify all of the following:

- PostgreSQL is healthy and has a persistent volume.
- PostgreSQL has no public port.
- The application has its GHCR credential, internal database URL, runtime secrets, port, domain, health check, and rollback policy.
- The production DNS name resolves to Dokploy and HTTPS works.
- The GitHub `production` environment contains all three secrets and the `PRODUCTION_URL` variable.
- You are ready for a production deployment to begin immediately.

The CI/CD implementation is currently on local `master`, while the workflow listens to `main`. From a clean working tree, rename the branch and push it:

```bash
git status --short
git branch --show-current
git branch -m master main
git push -u origin main
```

The last command triggers **CI and production delivery** because it creates a push to `main`.

After the push:

1. In GitHub, change the repository's default branch from `master` to `main`.
2. Open **Actions → CI and production delivery** and select the new run.
3. Wait for Quality, PostgreSQL integration, and Verify production container to pass.
4. Confirm that Publish verified image publishes both `:<full-commit-sha>` and `:main` to GHCR.
5. If the Deploy production job is waiting, select **Review deployments**, choose `production`, and approve it.
6. Wait for Deploy production to pass. It calls Dokploy, waits for the exact commit revision, checks database readiness, and verifies that production evaluation routes are unavailable.
7. After verifying `main`, optionally delete the old remote `master` branch through GitHub. Do not delete it until the default branch and protections have been moved successfully.

## 9. Verify the live deployment

Set a local shell variable to the public application origin and record the deployed commit:

```bash
deployment_url=https://support.example.com
expected_revision=$(git rev-parse HEAD)
```

Check liveness and confirm that `version` equals `$expected_revision`:

```bash
curl --fail --silent --show-error "$deployment_url/api/health/live"
```

Expected shape:

```json
{ "status": "ok", "version": "<full-commit-sha>" }
```

Check readiness and the home page:

```bash
curl --fail --silent --show-error "$deployment_url/api/health/ready"
curl --fail --silent --show-error --output /dev/null "$deployment_url/"
```

Confirm that the local-only evaluation surfaces return `404`:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' "$deployment_url/admin/evaluations"
curl --silent --output /dev/null --write-out '%{http_code}\n' "$deployment_url/api/evaluations/runs"
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"concurrency":3}' \
  "$deployment_url/api/evaluations/run"
```

Submit only a synthetic ticket and verify that resolution, citations, and mock confirmation work. Never use real customer data.

## 10. Trigger later deployments

After `main` is the protected default branch, use a pull request for every routine release:

1. Create and push a feature branch.
2. Open a pull request into `main`.
3. Wait for required checks and review.
4. Merge the pull request.
5. Approve the protected `production` environment when prompted.

Every merge creates a push to `main`, which runs the same build, publish, deploy, revision check, and smoke-test sequence.

There is no manual **Run workflow** button for production delivery. To retry the same revision, open its **CI and production delivery** run and select **Re-run failed jobs** or **Re-run all jobs**. Deploying from the Dokploy dashboard pulls the current `:main` image but bypasses the GitHub verification gate, so reserve it for a deliberate operational recovery.

## 11. If deployment fails

1. Read the failed GitHub job and step first. The workflow deliberately does not print secret values or provider/database responses.
2. In Dokploy, inspect the replacement task's sanitized logs for migration, ingestion, database reachability, image-pull, or health-check failures.
3. Confirm that the GHCR token and Dokploy API token have not expired.
4. Confirm that `DATABASE_URL` uses the internal PostgreSQL hostname and that both services share the same network.
5. Confirm that the public domain routes to port 3000.
6. If necessary, select the last known-good immutable SHA image in Dokploy and deploy it manually. Do not roll database migrations backward automatically.

Follow the [full operations runbook](dokploy-deployment.md#9-routine-release-and-diagnosis) for detailed diagnosis, rollback, restore, credential rotation, image retention, and VPS hardening.
