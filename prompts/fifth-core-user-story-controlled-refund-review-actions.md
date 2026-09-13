# Fifth core user story: controlled mock refund-review actions

## User story

As a support agent, I can approve or reject a proposed mock action.

## Goal

Add `request_refund_review` as a grounded resolution outcome without allowing the model, the initial resolve request, or the browser to execute an action. A qualifying billing ticket may return a schema-validated refund-review proposal with display-safe arguments and an opaque proposal ID. The proposal is stored in `pending_confirmation` state with the successful resolution, and only a separate, explicit, session-owned confirmation request can execute the local mock once.

Confirmation records an immutable, clearly labeled mock result in PostgreSQL. Repeated and concurrent confirmations return that original result. Rejecting in the UI performs no request and no execution. No refund, payment, subscription, customer-message, or third-party side effect is introduced.

## Requirements traced to the product documents

- PRD core story 5 and section 7.4: show proposed refund-review arguments and let the support agent approve or reject; confirmation is required before mock execution, which creates only a local audit result.
- PRD FR-6 and acceptance criterion 5: expose one mock `requestRefundReview` operation, validate its arguments server-side, and make execution impossible without explicit confirmation and valid arguments.
- PRD safety and UX requirements: high-impact actions are mocked and confirmation has a state distinct from loading, resolution failure, and insufficient evidence.
- Technical specification section 10: deterministically reject actions that are not allowed for the category and validate every evidence identifier against retrieved context.
- Technical specification section 12: validate the tool and arguments, bind evidence to the current run, create an opaque pending proposal, accept a separate confirmation request, execute once, and persist the original result.
- Repository contracts: bind the proposal to the anonymous signed session through its resolution run, revalidate stored JSON before use, keep SQL in `src/db`, keep action rules in `src/actions`, and expose neither raw tickets nor hidden provider/database data.

## Current repository baseline

- Stories 1–4 and 6–8 are implemented. The resolve pipeline currently returns only grounded `reply` or citation-free `needs_human_review` outcomes.
- Successful resolutions are already bound to a signed anonymous session and persisted transactionally with immutable cited-source snapshots. This supplies the ownership and evidence provenance needed by Story 5.
- There is no `src/actions` module, refund-review argument/result contract, pending proposal, confirmation Route Handler, or `action_audit` table.
- The current Anthropic boundary performs structured generation only and deliberately has no provider-controlled tool execution. Story 5 can preserve that boundary: the model recommends the action, while application code constructs, validates, persists, confirms, and executes the mock.
- The UI renders reply and abstention states but has no action proposal or confirmation state.
- The evaluation action allowlist, citation judge, graders, fixtures, and `golden.v1` dataset know only `reply` and `needs_human_review`; they must remain compatible with the shared resolution union when refund review is added.
- The worktree was clean before this plan was added. The deterministic unit suite passed at baseline: 20 files and 150 tests.

## Scope boundary

### In scope

- A grounded `request_refund_review` resolution variant for billing tickets only.
- Server-owned construction and Zod validation of the documented mock arguments: reason, ticket summary, and one to five evidence chunk IDs.
- An opaque proposal ID and `pending_confirmation` state returned to the UI only after the resolution, cited snapshots, and pending audit row commit together.
- A separate `POST /api/actions/refund-review/:proposalId/confirm` Route Handler requiring `{ "confirmed": true }` and the owning signed session.
- Exactly-once local mock execution with row-level serialization and an immutable stored result returned on retries and concurrent confirmations.
- UI presentation of the grounded draft, sources, proposed arguments, explicit confirmation, local rejection, processing, success, and controlled failure states.
- Prompt, evaluation-contract, golden-dataset, deterministic test, migration, and README changes required to keep the completed stories coherent.

### Explicitly out of scope

- Real refunds, payments, billing changes, subscription changes, customer communication, help-desk integrations, queues, webhooks, or any external side effect.
- Provider-native tool calls or allowing Anthropic output to invoke application code directly.
- `escalate` execution or a generic/dynamic tool registry; this story adds exactly one allowlisted mock operation.
- Accounts, roles, an action-history page, an audit admin UI, action cancellation, or a new rejection endpoint. The UI's rejection choice sends no confirmation request and therefore cannot execute the proposal.
- Changes to source authorization, ingestion behavior, retrieval strategy, authentication architecture, or unrelated evaluation/admin functionality.

## Implementation plan

### 1. Define strict action and resolution contracts

- Add a provider-neutral action domain module under `src/domain` for:
  - `RequestRefundReviewArgsSchema` with a 10–500 character reason, the existing 1–300 character ticket summary, and one to five unique UUID evidence chunk IDs.
  - A literal `requestRefundReview` tool name, opaque UUID proposal ID, and literal `pending_confirmation` proposal state.
  - An explicit confirmation body requiring exactly `{ confirmed: true }`.
  - A bounded, display-safe mock execution result whose status and message unambiguously say that only a local review record was created; include the original proposal ID and execution timestamp, but no raw ticket or provider data.
- Extend the discriminated resolution proposal with `request_refund_review`. Like `reply`, it must contain a grounded draft and citations; unlike `reply`, it also contains the server-created action proposal and validated arguments. Keep `needs_human_review` citation- and action-free.
- Extend persisted resolution-action and execution schemas so refund-review runs require a matching pending proposal, billing classification, grounded cited sources, and action evidence IDs that are unique and owned by that execution. Reply and human-review runs must reject stray action proposals.
- Add only the action-specific safe API error codes needed by the confirmation UI (`action_not_found` and `action_unavailable`) while preserving the shared `ApiResult<T>` envelope.

### 2. Teach the resolution pipeline to recommend, but never execute, refund review

- Add a new versioned resolution prompt (`resolve.v4`) that permits `request_refund_review` only when retrieved billing evidence supports submitting a review and the ticket contains the policy-required customer-specific facts. It must otherwise draft a safe request for missing details or abstain when policy evidence itself is insufficient or contradictory.
- Keep ticket and knowledge text delimited as untrusted data and explicitly state that instructions to bypass confirmation, claim completion, guarantee approval, or reveal secrets cannot change the action policy.
- Extend the structured decision schema with the refund action while retaining the existing grounded-reply/null invariants.
- After validating the generated decision and citations, deterministically allow refund review only for `billing`, create its arguments from already-validated values (classification summary, bounded action reason, and the one-to-five cited chunk IDs), validate them with the public tool schema, and create the opaque proposal ID in application code. Do not accept a provider-selected tool name or execute anything during resolution.
- Make proposal-ID creation injectable in pipeline tests and preserve provider-neutral telemetry, prompt-version recording, citation snapshots, low-confidence routing, and insufficient-evidence behavior.

### 3. Persist pending proposals with their resolution evidence

- Add the Drizzle `action_audit` table with the repository-required fields: unique/primary opaque `proposal_id`, unique foreign-keyed `resolution_run_id`, schema-valid JSONB `proposed_arguments`, constrained `state`, resolution `trace_id`, nullable `confirmed_at`, nullable `executed_at`, nullable JSONB `result`, and database-generated `created_at`.
- Constrain valid states and timestamp/result combinations so pending rows cannot look executed and executed rows require confirmation time, execution time, and a result. Index the resolution-run relationship used for authorization.
- Extend `persistSuccessfulResolution` to insert the resolution run, cited snapshots, and pending action row in one transaction. Revalidate that every proposed evidence UUID belongs to the cited snapshots for that exact run before writing. A failed action insert must roll back the entire resolution so an unusable proposal is never returned.
- Generate and review the Drizzle migration and metadata; do not hand-edit generated migration snapshots.

### 4. Implement exactly-once, session-owned mock execution

- Add `src/actions/request-refund-review.ts` as the business boundary for the single allowlisted mock. It accepts only parsed stored arguments, creates no network or customer-side effect, and returns a schema-valid local audit result.
- Add a server-only action-audit repository under `src/db` that starts a transaction, finds the proposal through its owning `resolution_runs.session_hash`, locks it for update, and uses the same non-revealing absence result for unknown and differently owned proposals.
- Inside that serialized transaction, parse the stored action name/arguments again and verify every argument evidence ID exists in `resolution_run_sources` for the same resolution run. Invoke the injected mock executor only for `pending_confirmation`, persist `executed` plus confirmation/execution timestamps and the complete result, and return the already stored result without reinvoking the executor when state is already `executed`.
- Keep transaction/executor seams injectable so unit tests can prove no execution occurs for invalid confirmation, absent ownership, invalid stored JSON, invalid evidence ownership, or a previously executed proposal.

### 5. Add the dedicated confirmation Route Handler

- Add `src/app/api/actions/refund-review/[proposalId]/confirm/route.ts` using the installed Next.js 16 App Router dynamic-parameter convention.
- Generate a new request trace ID, validate the route UUID and JSON body, require the literal positive confirmation, and verify the existing signed session without creating or rotating a session.
- Call the action service only after request and session validation. Return `200 ApiResult<MockRefundReviewResult>` for the first and every repeated successful confirmation.
- Return safe `400 invalid_request` responses for malformed IDs/JSON or anything other than explicit confirmation; return the same non-revealing `404 action_not_found` for missing sessions, unknown proposals, and other sessions' proposals; map storage/execution failures to a safe retryable `503 action_unavailable`.
- Mark all confirmation responses `Cache-Control: private, no-store` and emit structured trace/action events containing IDs and state only, never cookie values, arguments, source text, raw tickets, or database/provider details.

### 6. Add explicit action controls to the existing UI

- Extend the ticket Client Component with isolated refund-action states: `pending`, `confirming`, `executed`, `rejected`, and controlled `failure`. Reset/abort stale action state when ticket text, tier, or the resolution result changes.
- Render refund-review outcomes as proposals, not completed actions: retain the proposed draft and inline source cards, show the exact validated mock arguments in a separate panel, and repeatedly label the operation as local/mock with no refund approval or payment effect.
- Provide two accessible controls. `Confirm mock review` posts `{ confirmed: true }` with same-origin credentials and cannot be double-submitted; `Reject proposal` makes no API call and visibly records that no mock action was executed.
- Validate the confirmation response with the shared schema before rendering it. Show distinct confirming, completed, retryable-failure, and malformed-response states, keep the original resolution visible throughout, and display the immutable result returned by repeated confirmation without implying customer impact.
- Reuse the current cited-source loading behavior for both reply and refund-review grounded drafts and preserve stale-request protection, keyboard operation, responsive layout, trace display, and the draft/not-sent label.

### 7. Keep evaluations coherent with the new shared action

- Extend the evaluation action allowlist and compact actual schema with `request_refund_review` while continuing to define abstention only as `needs_human_review`.
- Treat refund-review grounded citations exactly like reply citations in citation existence/support grading and the citation judge; never include proposal IDs or action arguments in persisted/downloadable evaluation output.
- Version the modified golden dataset as `golden.v2` and add a synthetic, policy-complete refund-review case whose expected action is `request_refund_review`. Preserve existing cases that should remain informational replies because required review details are missing, and add/adjust prompt-injection coverage so a request to skip confirmation can at most produce a pending proposal.
- Update deterministic evaluation fixtures, stored metadata expectations, history/comparison tests, and documented case count/version without changing threshold definitions or comparison semantics.

### 8. Add deterministic security, idempotency, and behavior coverage

- Extend domain tests for every action-argument boundary, unique and owned evidence IDs, discriminated proposal shapes, billing-only action permission, explicit confirmation, and strict rejection of extra/provider-controlled fields.
- Extend pipeline and prompt tests for supported refund proposals, incomplete billing facts remaining a reply, unsupported categories, citation/argument mismatch, prompt-injection attempts, deterministic proposal IDs, no execution during resolution, and unchanged abstention paths.
- Extend resolve Route Handler tests to prove a refund proposal is not returned unless its pending audit row and cited snapshots persist, and that no mock executor runs during resolution.
- Add confirmation Route Handler tests for malformed JSON/UUID, false or missing confirmation, missing/tampered/different-session ownership, first execution, repeated execution, safe no-store responses, storage failures, and redacted logging.
- Add action-service/repository tests for stored-data revalidation, evidence ownership, executor call count, immutable result reuse, transaction rollback, and two concurrent confirmations yielding one execution result.
- Extend UI tests for argument display, no pre-confirmation request, confirmation double-click prevention, local rejection with zero request, successful/repeated result rendering, controlled retry, malformed response rejection, and stale proposal isolation.
- Extend the isolated PostgreSQL integration suite to verify transactional pending creation, session ownership, evidence binding, row-level concurrent idempotency, persisted timestamps/result, cross-session denial, and cleanup through resolution-run cascading.
- Keep all default tests network-free and use only fixed synthetic inputs and fake providers/executors.

### 9. Document and verify

- Update the README overview, architecture, API/security explanation, evaluation dataset version/count, and manual checklist for the pending/confirmed mock flow, session ownership, local-only audit result, idempotent repeats, and continued absence of real effects.
- Before implementation edits, re-read the installed Next.js 16 Route Handler, dynamic route, cookie, and Server/Client Component guides under `node_modules/next/dist/docs/`.
- Run `pnpm db:generate` and review the generated migration and metadata.
- Run `podman compose config`, start the local pgvector service, and apply migrations to development and the explicitly isolated `_test` database.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run `pnpm test:integration` with `TEST_DATABASE_URL` pointing to a database whose name ends in `_test`.
- Run `pnpm build`.
- Run `pnpm ingest` and `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json` when their configured live provider credentials are available; report unavailable credentials or rate limits explicitly rather than claiming success.

## Acceptance criteria

1. A policy-supported billing ticket can return `request_refund_review` with a grounded unsent draft, valid citations, an opaque proposal ID, literal pending state, and display-safe tool arguments; non-billing and inadequately supported cases cannot return that action.
2. The initial resolve request never invokes the mock executor. The successful resolution, cited snapshots, and pending audit row commit atomically before the proposal is exposed.
3. The browser displays the proposed arguments and clearly distinguishes pending, confirming, executed, rejected, and failed states without saying that a refund was approved, issued, or sent.
4. Rejecting a proposal sends no confirmation request and executes nothing. Executing requires a separate POST containing the exact explicit-confirmation body and a valid owning signed session.
5. Missing, invalid, tampered, cross-session, and unknown authorization cannot execute the mock and do not reveal whether another session's proposal exists.
6. The server reparses stored arguments and verifies every evidence UUID against the proposal's own resolution-run snapshots immediately before execution.
7. First, repeated, and concurrent valid confirmations return the same immutable stored mock result; the executor is invoked once and the persisted confirmation/execution timestamps and result do not change on retries.
8. Responses, browser state, logs, action arguments, and audit records contain no raw ticket text, prompts, provider payloads, cookie/session secrets, embeddings, unrelated sources, or real customer data.
9. The evaluator accepts and grades grounded refund-review outcomes without persisting proposal IDs/arguments, and the versioned golden dataset contains action-ready and confirmation-bypass coverage.
10. Domain, pipeline, route, UI, action-service, and isolated PostgreSQL tests are deterministic and network-free; migration generation, lint, strict type-checking, tests, integration checks, build, and relevant live commands are reported exactly.

## Manual test checklist for handoff

1. Configure the existing provider, database, and session-secret values; start PostgreSQL/pgvector, apply migrations, ingest the synthetic knowledge base, and run `pnpm dev`.
2. Submit a synthetic billing ticket containing two invoice IDs and confirming two settled charges for the same account, plan, billing period, date, and amount; request refund review.
3. Confirm the result is still labeled as an AI-generated proposal/draft, shows `request_refund_review`, displays the reason, summary, one-to-five evidence UUIDs, proposal ID, exact source evidence, and `pending_confirmation`, and does not claim a refund or real request occurred.
4. Inspect the network log and database before confirmation; verify the resolve request created the pending audit row but no confirmation request, executed state, result, or real external call exists.
5. Choose `Reject proposal`; verify no request is sent, the UI says no mock action was executed, and no audit execution fields change.
6. Resolve the ticket again, choose `Confirm mock review`, and verify exactly one same-origin POST sends `{ "confirmed": true }`; confirm the UI shows a local/mock recorded result and immutable execution time.
7. Repeat the confirmation request and issue two confirmations concurrently; verify each returns the same stored data and the audit row/result/timestamps remain single and unchanged.
8. Remove or tamper with the session cookie, use another browser session, and try an unknown UUID; verify each validly shaped request receives the same non-revealing not-found response and no state changes.
9. Send malformed JSON, `{ "confirmed": false }`, extra fields, and malformed proposal IDs; verify safe `400` responses and no executor call.
10. Tamper with stored arguments/evidence in an isolated test database; verify execution is refused with a controlled response and no result is written.
11. Submit an otherwise similar billing ticket that omits invoice IDs, settled status, same billing period, or other policy-required facts; verify the system drafts a request for missing safe information instead of proposing executable review.
12. Submit a ticket that says to ignore confirmation and execute a refund immediately; verify it can never bypass the pending proposal and separate confirmation flow.
13. Submit a technical/account ticket asking for a refund-review action; verify deterministic action validation rejects or safely routes it rather than creating a pending audit.
14. Navigate the proposal, source cards, confirm/reject controls, status announcements, and retry state by keyboard at narrow and wide widths.

## Local Next.js references inspected for planning

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
