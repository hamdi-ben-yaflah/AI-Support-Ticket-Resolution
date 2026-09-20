# AI solution security hardening

Status: approved by the user; implemented and verified locally.

## Objective and boundaries

Harden the existing synthetic support-ticket copilot against request abuse, accidental production exposure, cross-origin requests, and AI trust-boundary regressions. Preserve anonymous signed sessions, evidence ownership, human confirmation, and idempotent mock actions. No authentication system, extra AI provider, external service, or investigation-agent expansion.

This is a repository review, not a penetration test or certification. Production proxy settings, provider-account budgets, and exported live traces have not been inspected. Initial Git status and diff were clean.

## Findings

| Priority | Evidence | Implication |
| --- | --- | --- |
| High | `src/config/deployment.ts` permits `ENABLE_LIVE_EVALUATIONS=true` in production; `tests/config/deployment.test.ts` explicitly expects this. | An environment mistake exposes an unauthenticated evaluation surface, including paid runs and stored history, contrary to AGENTS.md. |
| High | `src/app/api/tickets/resolve/route.ts` calls providers without application rate or concurrency admission control. | Repeated anonymous requests can consume provider capacity and money. The deployment guide recommends edge rate limiting, but its live configuration is unverified. |
| Medium | Resolution and confirmation routes call `request.json()` before bounding bytes; evaluation checks bytes after `request.text()` reads the entire body. | The ticket's 10,000-character schema limit does not bound transport memory or request-read time. |
| Medium | POST routes do not enforce a trusted origin; resolution and confirmation do not require a JSON media type. | Missing defense in depth against cross-origin submissions. SameSite cookies already mitigate many CSRF scenarios; this is not a demonstrated confirmation bypass. |
| Medium | Resolution responses lack explicit private/no-store headers; security headers are delegated to deployment instructions. | Privacy and browser protections depend on deployment behavior that is not enforced in application configuration. |
| Medium | Grounding validation checks citation identity, uniqueness, and metadata, not semantic entailment. Existing adversarial golden cases mostly inject through the ticket. | Valid citations do not prove a safe or supported draft. Indirect injection and malicious model outputs need explicit regression coverage; prompt text alone is not an authorization boundary. |
| Review limitation | Classification summaries and action reasons are persisted model-generated strings; Zod validates shape, not confidentiality. | A model could copy sensitive ticket content into derived fields. The product remains synthetic-only; this plan does not certify arbitrary real-ticket handling or comprehensive PII removal. |

Existing controls to retain: HMAC-signed expiring HTTP-only cookies, timing-safe signature checks, session-scoped source/action queries, transactional action locking and replay, server-generated proposal IDs, schema validation, bounded provider attempts, metadata-only tracing, and plain-text rendering. The current investigation tool foundation already has allowlisting, provenance checks, result-size limits, and timeouts.

## Implementation plan

### 1. Enforce the local evaluation boundary

- Make all evaluation pages and APIs unconditionally unavailable when `NODE_ENV=production`, including when the enable flag is true. Preserve CLI evaluations.
- Require local loopback host access for the nonproduction evaluation surface, with exact host parsing, and reject cross-origin evaluation POSTs. Document binding the development server to loopback; a Host header is not network authentication.
- Update configuration and route tests, production container checks, and only affected documentation/fixtures. Keep ordinary deterministic browser tests on their existing development server.
- Acceptance: production requests return 404 before reading bodies, querying history, or calling providers under every enable-flag setting.

### 2. Bound and validate requests before expensive work

- Introduce a small server-only HTTP guard shared by resolution, confirmation, and evaluation POSTs. Keep request schemas in the domain/API layers.
- Require `application/json` with optional charset. Bound actual streamed bytes, cancel the reader on overflow, and impose a finite read deadline. Do not rely only on Content-Length.
- Proposed defaults: 64 KiB for tickets, 1 KiB for confirmations/evaluations, and a 5-second body-read deadline. Preserve the existing 10,000-character ticket limit, including normal Unicode input.
- Use strict ticket-object validation. Return safe ApiResult failures for invalid JSON, unsupported media type, oversize input, and timeout; never include rejected content.
- Add a server-only configured application origin for production. Validate Origin against this value, reject `null`, mismatches, and cross-site Fetch Metadata. Allow missing Origin only for non-browser clients without cross-site metadata; document that origin validation is not bot authentication. Do not trust arbitrary forwarded host headers.
- Apply private/no-store consistently to resolution success and failure responses and new rejection responses.
- Acceptance: rejected requests never invoke providers, persistence, or mock actions. Cover absent/incorrect Content-Length, Unicode byte counts, slow bodies, malformed JSON, and cross-origin requests.

### 3. Limit paid-work admission

- Add a small bounded process-local admission controller for the current single-instance deployment: a global request-rate cap, a global active-resolution cap, and a bounded per-verified-session rate bucket when a session exists.
- Proposed configurable defaults: 20 accepted resolutions/minute/process, 2 concurrent resolutions/process, and 5/minute/verified session. New or rotated cookies must still consume the global limits.
- Reject excess traffic before providers with 429 and Retry-After; release concurrency permits in finally on every completion/failure. Use bounded storage and expiry; do not retain raw IP addresses or ticket text.
- Update ApiResult contracts and UI error handling only as needed for controlled retry messaging.
- Provide concrete edge rate-limit/body-timeout guidance and provider-account spend-limit checks. State that process limits reset on restart, multiply across replicas, and do not guarantee a monetary ceiling. No Redis or distributed-rate-limit platform in this task.
- Acceptance: fake-clock tests exercise bursts, concurrent calls, failure cleanup, cookie rotation, storage bounds, and recovery without live providers.

### 4. Enforce browser protections

- Read the installed Next.js route-handler, headers, and CSP guides before editing Next.js files.
- Set nosniff, a conservative Referrer-Policy, frame denial, and a restrictive Permissions-Policy in application headers. Keep HSTS at the HTTPS edge and document verification.
- Add a nonce-based production CSP following the installed Next.js guide, with same-origin connections, no objects or framing, and no production unsafe-eval or unsafe-inline scripts. Account for the required dynamic rendering and test hydration and styles. Preserve development HMR with development-only allowances.
- Keep model output and knowledge content as escaped text. No HTML/Markdown renderer or external image fetching.
- Acceptance: production browser smoke confirms form submission, citation display, and confirmation UI remain functional; script-like model/source strings render inertly.

### 5. Add AI security regression evidence

- Add deterministic hostile-provider and hostile-evidence fixtures covering forged/duplicate citations, attempted tool-name/proposal-ID injection, confirmation bypass requests, delimiter spoofing, indirect knowledge instructions, and HTML/exfiltration links rendered as text.
- Verify application-enforced invariants: no mutation during resolution, invalid citations rejected, foreign sessions denied, and repeated confirmations return the stored result. Distinguish these tests from actual model resistance to injection.
- Add tests that logs and exported trace attributes exclude synthetic secret canaries, prompts, raw responses, and ticket bodies on failure and success. Enforce the existing trace attribute allowlist at runtime as well as through TypeScript; keep content capture disabled. No telemetry SDK upgrade is needed for this scope.
- Document semantic grounding, model-generated sensitive summaries, and sophisticated prompt injection as residual risks. Do not introduce a keyword filter or claim regexes solve prompt injection. Expanding to real customer data would require a separately approved data-minimization and retention design.
- Preserve the existing versioned golden dataset in this task. Live adversarial model evaluations require an explicit cost budget; deterministic mocks cannot establish real-model robustness.

## Verification after approval

1. Run focused new request/admission/production-gate tests and existing session, source, action, grounding, and trace suites.
2. Run `pnpm verify` (formatting, lint, types, migrations, coverage, operations build, production build).
3. Run `pnpm test:integration` when the explicit local integration database configuration is available; use existing ownership/idempotency database cases. Report any unavailable dependency rather than claim success.
4. Run `pnpm test:e2e` and a production-mode browser smoke for CSP and evaluation lockout.
5. Run `pnpm audit --prod --json` again if dependencies change. No dependency update is planned.
6. Do not run ingestion or paid evaluations for this change unless explicitly configured and budgeted; no knowledge content or embedding change is planned. If authorized, use the repository command `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json` and keep provider artifacts out of Git.

Manual acceptance steps after implementation:

1. Start the production build locally with `ENABLE_LIVE_EVALUATIONS=true`; open `/admin/evaluations` and request all three evaluation API routes. Expect 404, with no provider work.
2. With synthetic configured providers/data, resolve a normal ticket, inspect its source, confirm a mock proposal twice, and confirm both results match.
3. Open a fresh private browser session and attempt the first session's source/proposal IDs. Expect denial without data disclosure.
4. Send oversize JSON, a non-JSON body, and an untrusted Origin to each POST route. Expect the documented rejection status and no downstream work.
5. Using deterministic providers, exceed the configured resolution limits. Expect 429 and Retry-After, then successful recovery after the window; avoid paid load tests.
6. Inspect production response headers and the browser console. Verify CSP enforcement, no hydration failures, private/no-store API responses, and inert hostile fixture strings.
7. Inspect captured test logs/traces for synthetic canaries. Expect none in telemetry. Record that this does not certify arbitrary sensitive data removal from model-generated persisted summaries.

## References checked

- [OWASP prompt-injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): layered input/output defenses and human-controlled actions.
- [OWASP unbounded consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/): resource, request, and cost controls.
- [Langfuse tracing guidance](https://langfuse.com/docs/observability/best-practices): useful telemetry with sensitive data excluded; repository privacy rules take precedence over content-capture suggestions.
- Installed Next.js documentation: `node_modules/next/dist/docs/01-app/02-guides/data-security.md` and `content-security-policy.md`.

## Review commands and results

- `git status --short`, `git diff --stat`, and `git ls-files`: clean initial worktree; repository scope inspected.
- Targeted source, configuration, test, CI, and deployment-document reads: findings above confirmed in repository code; no live deployment inspected.
- `pnpm audit --prod --json`: passed; zero reported advisories across 253 audited dependencies. This is not proof of absence of vulnerabilities.
- `pnpm verify`: passed on the application baseline; all 222 tests across 35 files passed, as did formatting, lint, type checks, migration checks, operations build, and production build.
- `pnpm exec prettier --write prompts/ai-security-hardening.md`: formatted the proposed plan.
- The preceding results describe the pre-implementation review. Completed implementation checks are recorded below.


## Completed implementation and verification

Implemented the five approved work areas. Defaults match the plan: 64 KiB/1 KiB body limits, 5-second read deadline, 20 resolutions/minute/process, 2 active resolutions/process, and 5/minute/existing verified session. Production POSTs require a valid APP_ORIGIN. Production evaluation pages/APIs cannot be enabled with the environment flag. Nonproduction evaluation access additionally requires loopback authorities.

Nonce CSP requires dynamic rendering; the root layout now opts into request-time rendering. Production browser tests assert hydration, styles, fresh nonces, inert hostile strings, response headers, and evaluation lockout. The production security suite is included in the existing CI browser job, and the container smoke deliberately sets the evaluation enable flag to true while asserting 404 on all evaluation surfaces.

Trace attribute names are enforced at runtime and values pass bounded Zod validation. Actual OpenTelemetry span-processor tests confirm unknown content attributes and thrown error bodies are not emitted. Existing model-supplied extra authority fields are discarded by the pipeline; regression tests verify server-owned proposal IDs/tool names and pending confirmation rather than requiring a new provider behavior.

| Command | Final result |
| --- | --- |
| `pnpm verify` | Passed: formatting, lint, types, migration consistency, 271 tests in 40 files, coverage thresholds, operations build, production build. |
| `pnpm test:integration` with an isolated disposable test database | Passed: 7 tests in 3 files, including actual transactional ownership, idempotency, and stored-argument validation. |
| `pnpm test:e2e` | Passed: all 19 deterministic browser tests. |
| `pnpm exec playwright test --config playwright.security.config.ts` | Passed: all 8 production-mode browser tests, with provider keys cleared and Langfuse export disabled. |
| `git diff --check` | Passed. |

The original configured TEST_DATABASE_URL failed PostgreSQL authentication. Tests were rerun successfully using a new disposable pgvector container on loopback port 15439 and a database named support_security_test. The container was stopped and removed after verification; existing database services and local credentials were not modified. The regular browser suite exposed a pre-existing 50 ms loading-state fixture race; the affected fixture now waits for the assertion before returning its response, and the complete suite passed.

No dependencies were changed; the review's production dependency audit reported zero advisories. No paid evaluations, ingestion, real provider calls, live trace export, production deployment, or edge changes were performed. Public proxy configuration and provider-account budget enforcement remain operational checks. The browser tests verify mocked successful journeys; the integration suite separately verifies the actual database invariants.

Exact manual deployment acceptance steps and operational limitations are maintained in [AI security controls and verification](../docs/operations/ai-security.md). The local automated equivalents passed; manual acceptance against the public deployment has not been performed. Set APP_ORIGIN to the exact public HTTPS origin before deploying this change. Rate limits remain process-local, and model-derived stored text remains synthetic-only rather than comprehensively sanitized for real customer data.
