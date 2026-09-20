# AI security controls and verification

This application accepts synthetic tickets only. Session ownership and explicit confirmation protect mock actions; neither model instructions nor citation validity authorize execution. Citation checking establishes which evidence was retrieved, not whether every generated claim follows from it. A model may echo sensitive input into summaries or reasons stored in PostgreSQL. This release does not provide general PII removal, semantic proof of grounding, or a guarantee against prompt injection.

## Runtime configuration

Set `APP_ORIGIN` to the exact public origin, such as `https://support.example.com`, with no trailing slash or path. It is required in production; missing or invalid configuration causes POST requests to fail closed with a safe 500. Do not set an internal container hostname or trust a caller-supplied forwarded host. HTTP origins are allowed for local production-build tests; public deployment requires HTTPS.

| Control                           | Default                                 | Configuration                        |
| --------------------------------- | --------------------------------------- | ------------------------------------ |
| Resolution requests per process   | 20 per 60-second window                 | `RESOLUTION_RATE_PER_MINUTE`         |
| Active resolutions per process    | 2                                       | `RESOLUTION_MAX_CONCURRENT`          |
| Existing verified session         | 5 per 60-second window                  | `RESOLUTION_SESSION_RATE_PER_MINUTE` |
| Ticket JSON body                  | 64 KiB plus 10,000-character text limit | Fixed application boundary           |
| Confirmation/evaluation JSON body | 1 KiB                                   | Fixed application boundary           |
| Body read deadline                | 5 seconds                               | Fixed application boundary           |

Blank optional limit values use defaults. Admission includes failures once provider work is admitted. Capacity is released after success or failure. Anonymous/new-cookie requests remain subject to global rate and concurrency limits. Session buckets expire and storage is bounded. Exceeded capacity returns 429 with `Retry-After` and a safe retry message.

The application controller is process-local: counts reset on restart, multiply across replicas, and fixed windows can allow bursts across a boundary. It is a single-instance backstop, not a distributed quota or a monetary ceiling. Configure provider-account spending limits and alerts separately, verify their actual enforcement in the provider consoles, and keep a way to revoke or disable the keys. Do not test limits by sending paid load.

POSTs require JSON and reject cross-site Fetch Metadata, a mismatched Origin, and an opaque (`null`) Origin. An Origin-less client is allowed only without Fetch Metadata; this supports CLI clients and is not bot authentication. Cookies remain HTTP-only and signed, and source/action access remains session-scoped. All resolution results and failures use private/no-store.

The evaluation page and APIs always return 404 in production, even with `ENABLE_LIVE_EVALUATIONS=true`. For local use, bind explicitly:

```sh
pnpm dev --hostname 127.0.0.1
```

Only exact loopback authorities are accepted on nonproduction evaluation routes. Host validation is not authentication: keep the development listener private, do not publish it through a reverse proxy, and preserve local-only access. CLI evaluation remains available through the explicitly budgeted workflow.

## Edge controls

Apply the following example middleware to a dedicated router for `POST /api/tickets/resolve`, preserving the existing application service and HTTPS configuration:

```yaml
http:
  middlewares:
    support-resolution-rate:
      rateLimit:
        average: 10
        period: 1m
        burst: 3
    support-json-size:
      buffering:
        maxRequestBodyBytes: 65536
```

Attach `support-resolution-rate` before `support-json-size`; use the body-size middleware on other POST routers too (the application still enforces 1 KiB for confirmations). Keep health checks outside the rate-limited router. Traefik rate limiting uses a token bucket; tune the example to measured traffic. Use the connection's source address by default. If another trusted proxy is upstream, configure its trusted addresses and client-IP strategy deliberately; never use arbitrary client headers as the rate-limit key. See [Traefik RateLimit](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/) and [Buffering](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/).

Set the serving entry point's `transport.respondingTimeouts.readTimeout` to a finite value, for example `10s`, to cover request headers and bodies before application handling. This setting affects every router on that entry point; confirm compatibility with other hosted applications. Keep response timeouts long enough for the existing model request budgets. See [Traefik EntryPoints](https://doc.traefik.io/traefik/routing/entrypoints/).

Enable TLS and HTTP-to-HTTPS redirection; apply HSTS at the edge only after checking the domain/subdomain HTTPS policy. Do not replace the application's dynamic CSP with a static edge CSP: production uses fresh script/style nonces per HTML request and dynamic rendering. The browser policy restricts connections to the same origin, disallows framing and objects, and excludes unsafe-inline/unsafe-eval scripts. Development alone permits HMR allowances. Verify headers at the public edge as well as directly against the application.

## Verification without live AI calls

```sh
pnpm verify
pnpm test:e2e
pnpm exec playwright test --config playwright.security.config.ts
```

The security browser config uses the production build on `127.0.0.1:3104`, forces the evaluation flag on, clears provider credentials, disables Langfuse export, and mocks successful AI/source/action responses in the browser. It checks actual production response headers, fresh nonces, hydration, styles, inert malicious draft/source strings, real POST rejection responses, and evaluation lockout. Browser fixtures verify UI behavior; database integration verifies actual transactional ownership and idempotency:

```sh
TEST_DATABASE_URL=postgresql://<test-credentials>@127.0.0.1:<port>/<isolated_database_test> pnpm test:integration
```

Use only a disposable database ending in `_test`. The test command does not automatically load `.env.local`; load the explicitly configured test environment without printing credentials. Do not substitute the development or production database.

Manual acceptance:

1. Run the production build locally with `APP_ORIGIN=http://127.0.0.1:3104 ENABLE_LIVE_EVALUATIONS=true pnpm start --hostname 127.0.0.1 --port 3104`. Check `/admin/evaluations`, `/api/evaluations/runs`, `/api/evaluations/compare`, and POST `/api/evaluations/run`: all return 404.
2. Inspect the home-page headers and console: CSP has a fresh nonce each load, frame denial/nosniff/no-referrer are present, and no CSP/hydration errors occur. Submit a synthetic ticket only when provider use is explicitly budgeted; inspect citations and confirm the mock action twice. Both confirmations must return the same stored result.
3. In a new private browser session, request the first session's source and proposal identifiers. Expect 404 with no source or action disclosure.
4. Send `text/plain` (415), oversized JSON (413), and `Origin: https://untrusted.example` (403) to resolution and confirmation routes. Verify private/no-store on failures. Use the deterministic route tests for a stalled body (408), concurrency/rate limits (429), permit cleanup, and recovery without paid calls.
5. Run the hostile-evidence/model tests and inspect captured logs/exported test spans: synthetic ticket, prompt, response, and error canaries must be absent. Telemetry accepts only enumerated attribute names at runtime. This is not proof that arbitrary text in allowed metadata fields is confidential or that stored model summaries are sanitized.

Live adversarial evaluation is separate, requires an explicit cost budget, and is not performed by these commands. No prompt, provider adapter, golden dataset, or embedding change is part of this hardening release.
