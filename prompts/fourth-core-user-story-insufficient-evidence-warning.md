# Fourth core user story: explicit insufficient-evidence abstention

## User story

As a support agent, I am warned when the available evidence is insufficient.

## Goal

Turn the existing internal insufficient-evidence failure into a successful, schema-validated abstention. A ticket that cannot be answered safely will retain its validated classification and confidence signal, return `action: "needs_human_review"` with a short safe reason, and render a prominent warning instead of a proposed reply.

Supported tickets will continue to return grounded replies with inspectable citations. Retrieval or provider infrastructure failures remain controlled errors; an unavailable dependency must not be mislabeled as insufficient evidence.

## Requirements traced to the product documents

- PRD success criterion and FR-5: unsupported, insufficient, or contradictory evidence returns `needs_human_review` rather than an invented answer.
- PRD sections 7.2 and 11: the result exposes a recommended action and explanation, and abstention remains visually distinct from loading, validation, and provider failures.
- PRD acceptance criterion 4: unanswerable cases visibly abstain.
- Technical specification sections 10 and 11: insufficient retrieval, contradictory or ambiguous context, and a low confidence routing signal can produce human review; supported replies still require deterministic citation validation.
- Technical specification section 14: insufficient evidence is a successful abstention, while retrieval unavailability is a retryable service error.
- Repository rules: all returned actions are schema-validated, raw ticket text and prompts remain out of storage and logs, and no unsupported policy is invented.

## Current repository baseline

- Stories 1–3 are implemented: ticket classification, knowledge ingestion/retrieval, grounded reply generation, exact cited-source inspection, anonymous signed-session ownership, and successful-run persistence.
- Retrieval already applies configurable similarity/count thresholds and throws an internal non-retryable `RetrievalError("insufficient_evidence")` when no selected evidence qualifies.
- The resolution pipeline currently requires a grounded reply with at least one citation. It does not represent an abstention result or allow zero cited sources.
- The resolve Route Handler currently maps insufficient evidence to a public `422 insufficient_evidence` failure, so the user sees “Resolution not available” rather than a successful recommended action.
- The resolution prompt can only produce a reply. It cannot explicitly report ambiguous or contradictory retrieved context.
- Every persisted run currently stores `{ type: "reply" }`, and the run/source schemas require at least one cited-source snapshot.
- The UI has a generic failure message for insufficient evidence and renders the same “Human review required” heading for every successful grounded reply, so supported proposals and explicit abstentions are not distinct states.
- The worktree was clean before this plan was added. No OpenAI embedding or other embedding-provider work is required for this story.

## Scope boundary

### In scope

- A provider-neutral, discriminated resolution contract for the two actions available in this story: `reply` and `needs_human_review`.
- A bounded short reason explaining the selected action.
- Deterministic abstention for below-threshold retrieval and low classification confidence.
- Model-selected abstention when retrieved evidence is ambiguous or contradictory.
- Persistence of successful abstentions without cited-source rows.
- A visually and semantically distinct abstention warning in the existing ticket-resolution UI.
- Deterministic domain, pipeline, Route Handler, UI, and isolated database tests.
- Configuration and README updates needed to explain the confidence routing threshold and successful-abstention behavior.

### Explicitly out of scope

- Story 5 refund-review proposals, approval/rejection controls, confirmation endpoints, execution, or `action_audit` records.
- `request_refund_review` or `escalate` action selection; this story exposes only the already-supported `reply` action and the new abstention action.
- Golden datasets, evaluation runners, threshold tuning claims, an evaluation UI, or measured abstention precision/recall; those belong to stories 7 and 8.
- Treating provider outages, retrieval/database outages, malformed requests, timeouts, or configuration failures as successful abstentions.
- Model/provider fallback, retries beyond the existing deadline, additional providers, autonomous tools, streaming, or conversation history.
- Knowledge-base changes, retrieval algorithm redesign, reranking, hybrid search, or unrelated UI/refactoring work.

## Implementation plan

### 1. Define the discriminated resolution outcome

- Replace the reply-only public proposal with a strict discriminated union keyed by `action`.
- The `reply` branch will contain the validated classification fields, `action: "reply"`, a bounded action rationale, and the existing non-empty grounded reply with citations.
- The `needs_human_review` branch will contain the validated classification fields, `action: "needs_human_review"`, and a bounded short explanation, while forbidding a draft reply and citations so the UI cannot accidentally present unsupported text.
- Add a provider-facing decision schema with the same two allowed actions. Keep provider response types inside the AI layer and continue composing the already-validated classification in application code rather than allowing the resolution call to rewrite it.
- Update run/action contracts so reply executions require matching cited snapshots, abstentions require exactly zero cited snapshots, and persisted actions allow only `reply` or `needs_human_review` with validated data.
- Remove `insufficient_evidence` from the browser-facing API error contract once every normal insufficient-evidence path returns the successful abstention union. Keep it as an internal retrieval control-flow code.

### 2. Add a deterministic confidence-routing policy

- Add a small server-only resolution policy configuration with a bounded `RESOLUTION_MINIMUM_CONFIDENCE` value and a documented conservative default.
- Pass the parsed policy into the provider-neutral resolution pipeline through dependency injection so unit tests do not mutate process environment.
- After classification, return a deterministic human-review execution when the confidence signal is below the threshold. Do not retrieve evidence or call the resolution model for that case.
- Treat the model confidence as a routing signal, not a calibrated probability, and document that the default must be tuned later by the evaluation stories.
- Record only the threshold/version and safe outcome metadata in structured telemetry; do not log the ticket or abstention free text.

### 3. Convert insufficient retrieval into a successful abstention

- Catch only the internal non-retryable retrieval `insufficient_evidence` result inside the resolution pipeline and build a schema-valid human-review execution with a stable, display-safe explanation.
- Skip grounded generation when retrieval has no qualifying evidence so the model cannot invent a reply without context.
- Continue propagating retrieval/database/embedding `unavailable` errors unchanged so the Route Handler returns the existing retryable service failure.
- Preserve classification model metadata, end-to-end latency, token counts, retry count, prompt-version metadata, and validation status for the successful abstention without pretending that a resolution-model call occurred.

### 4. Let grounded generation report ambiguity or contradiction

- Introduce `resolve.v2` rather than editing the existing prompt version in place.
- Instruct the provider to select `reply` only when the supplied chunks consistently and adequately support a safe draft, and to select `needs_human_review` with a concise reason when context is ambiguous, contradictory, irrelevant, or missing a required policy detail.
- Require the reply branch to preserve the existing safety rules and exact citations. Require the abstention branch to omit suggested response text and citations.
- Accept a schema-valid model abstention as a successful execution with no cited-source grants.
- Continue treating refused, truncated, schema-invalid, or structurally invalid provider output as the existing controlled provider/model errors. Continue treating unknown, mismatched, or duplicate citations as deterministic grounding-validation failures rather than showing an unverified reply.

### 5. Persist both successful outcomes safely

- Extend the resolution-run domain schema and JSON action type for `needs_human_review`, including the bounded reason, without adding story-5 action types.
- Allow an abstention execution and persisted run to have zero cited sources, while retaining the current one-to-eight matching source requirement for reply executions.
- Update the database writer to insert cited-source snapshots only when they exist; the resolution run and any reply snapshots remain transactional.
- Keep `result_status = "success"` for both schema-valid reply and abstention outcomes because abstention is an intentional successful resolution result, not an infrastructure failure.
- Preserve the current source authorization behavior: an abstention creates no source grants, and existing reply citations remain session-owned and immutable.
- Generate a Drizzle migration only if the final schema representation requires a database constraint change; do not create an empty or unrelated migration for JSON-only type changes.

### 6. Return abstention as a normal resolve response

- Update `POST /api/tickets/resolve` to validate and return `ApiResult<ResolutionProposal>` for either union branch with HTTP `200`.
- Derive the persisted action and cited snapshots from the validated discriminant instead of hard-coding `{ type: "reply" }`.
- Persist the abstention before responding and retain the existing signed anonymous session behavior, ticket hashing, trace propagation, safe persistence failure, and response validation.
- Remove the current `422 insufficient_evidence` mapping from the Route Handler. Preserve distinct status/code mappings for invalid input, provider/model failures, retrieval unavailability, timeout, configuration, and unexpected failures.
- Keep the public response allowlisted: no raw ticket text, prompts, provider responses, embeddings, similarity values, session material, or uncited documents.

### 7. Render an explicit evidence warning

- Branch the existing client state and rendering on the validated `action` discriminant.
- For `needs_human_review`, show a prominent accessible warning with the validated category, priority, confidence signal, short explanation, recommended next action, and trace ID.
- State plainly that evidence was insufficient and that no proposed reply or customer action was produced. Do not render an empty draft panel, citation list, or source-loading state.
- Do not issue source-detail requests for an abstention. Clear/abort source requests if a later abstention replaces a cited reply so stale excerpts cannot appear.
- For the `reply` branch, preserve the draft/not-sent label, exact source inspection, generated-versus-retrieved distinction, and source retry behavior, while changing the generic success heading so a supported draft is visually distinct from the human-review abstention state.
- Keep all browser responses runtime-validated and all provider-derived reason/draft text rendered as plain text.

### 8. Add deterministic coverage

- Extend domain-schema tests for valid reply and human-review branches, bounded reasons, forbidden hybrid shapes, unsupported actions, and the zero-source versus cited-source execution invariants.
- Extend pipeline tests for low-confidence short-circuiting, insufficient-retrieval abstention without generation, explicit model abstention for contradictory evidence, unchanged supported replies, unchanged retrieval unavailability, and unchanged invalid-citation rejection.
- Test that abstention metadata is accurate, non-negative, and redacted, including no false resolution-call telemetry when generation was skipped.
- Extend Route Handler tests for `200` abstention responses, persistence before response, persisted human-review action with zero sources, session-cookie behavior, and unchanged infrastructure/model error mappings.
- Extend UI tests for the distinct warning, reason and confidence display, absence of draft/citations, no source fetch, stale-source cancellation, and continued supported-reply behavior.
- Extend isolated PostgreSQL integration tests to persist an abstention with no source rows and verify that it grants no source access, while retaining reply transaction/ownership coverage.
- Keep all default tests network-free with injected fake providers/retrievers and synthetic ticket/evidence data.

### 9. Document and verify

- Update `.env.example` and README setup/architecture/security text for the confidence threshold, the two successful outcome shapes, and the distinction between abstention and dependency failure.
- Before implementation edits, read the installed Next.js 16 Route Handler and Server/Client Component guidance under `node_modules/next/dist/docs/` that applies to the changed API/UI files.
- Run `pnpm lint`.
- Run `pnpm exec tsc --noEmit`.
- Run `pnpm test`.
- Run `pnpm test:integration` with an explicitly isolated `_test` PostgreSQL database.
- Run `pnpm build`.
- Run `pnpm ingest` only if implementation changes touch ingestion/retrieval configuration or a fresh local end-to-end check needs seeded evidence; report unavailable live credentials instead of claiming success.

## Acceptance criteria

1. A ticket with no qualifying retrieved evidence returns HTTP `200` with a schema-valid `needs_human_review` result, a short safe reason, its validated classification/confidence, and no generated reply or citations.
2. A below-threshold classification confidence produces the same safe outcome without invoking retrieval or grounded generation.
3. When selected chunks are ambiguous or contradictory, the resolution model can return a schema-valid human-review result; it cannot attach a reply or citations to that branch.
4. Supported tickets still return `action: "reply"`, a grounded draft, and one to eight deterministically validated, session-owned citations.
5. Retrieval/database/embedding unavailability remains a retryable error, while malformed input, provider failures, timeouts, refusals, truncation, and invalid output retain their controlled mappings and are not mislabeled as insufficient evidence.
6. The UI visibly distinguishes a successful abstention from supported replies and operational failures, explains why human review is required, and never presents unsupported text as a draft.
7. The browser makes no source requests for abstentions, and stale source responses from an earlier proposal cannot appear after an abstention replaces it.
8. Successful abstentions are persisted with `result_status = "success"`, a validated `needs_human_review` action, redacted metadata, no raw ticket text, and no cited-source rows or source authorization grants.
9. Existing signed-session ownership, exact reply-source inspection, safe telemetry, provider boundaries, and no-real-action guarantees remain intact.
10. Domain, pipeline, Route Handler, UI, and isolated database tests are deterministic and network-free; lint, strict type-checking, tests, integration tests, and production build results are reported exactly.

## Manual test checklist for handoff

1. Configure the existing database/provider/session variables plus `RESOLUTION_MINIMUM_CONFIDENCE`, start PostgreSQL/pgvector, apply migrations if one was generated, seed the knowledge base, and start `pnpm dev`.
2. Submit the supported synthetic ticket `I upgraded yesterday, but I was charged for both plans.` and confirm it returns `action: reply`, a “Draft · not sent” response, and viewable exact source excerpts.
3. Submit a clearly out-of-domain synthetic ticket such as `What will the weather in Berlin be next weekend?` and confirm the request returns HTTP `200` with `action: needs_human_review`, a short insufficient-evidence explanation, and no draft or citations.
4. In browser developer tools, confirm the abstention response contains only the allowlisted resolution fields and trace ID, and that no `/api/sources/:chunkId` requests follow it.
5. Temporarily set the confidence threshold above a fake/test classification confidence and confirm the pipeline abstains before retrieval or grounded generation; restore the documented value afterward.
6. Exercise a synthetic contradictory-evidence fixture through the deterministic test setup and confirm it renders the same human-review state without unsupported reply text.
7. Stop PostgreSQL or force the retrieval dependency to fail and confirm the UI shows a retryable retrieval-unavailable failure, not an insufficient-evidence abstention.
8. Resolve a cited ticket with delayed source requests, then submit an abstaining ticket and confirm no stale evidence appears beneath the warning.
9. Inspect the isolated database after an abstention and confirm the run stores the action and redacted metadata but no raw ticket and no `resolution_run_sources` rows.
10. Navigate the warning and supported result at narrow and wide widths with a keyboard/screen-reader flow and confirm the action, reason, confidence, and trace are announced clearly.
