# V2 Story 1, Milestone 1: deterministic tool foundation

## User story being started

As a support agent, I can submit a synthetic ticket and receive one terminal result without
managing the investigation steps myself.

## Delivery boundary

The V2 PRD requires a separate approved implementation plan for each release milestone. This plan
covers **Milestone 1: deterministic tool foundation**, the first prerequisite for the story. It
does not claim to complete the user story: the model-directed loop and terminal V2 result belong to
a subsequent Milestone 2 plan, and the timeline/evidence UI belongs to Milestone 3.

## Goal

Add a versioned, application-owned catalog of the five V2 read-only synthetic tools, validated
synthetic fixtures, strict argument/result boundaries, identifier provenance checks, bounded
dispatch, and deterministic network-free coverage. The result will be a server-only foundation
that a later bounded investigation loop can call without giving the model direct access to a
database, SDK, network client, mutation, or dynamically discovered operation.

## Requirements traced to the V2 PRD

- FR-1 through FR-5: one specialized workflow, an application-owned dispatcher, exactly five
  logical tools, strict input authorization, and minimized validated output.
- FR-6: tool-level deadlines must fit inside the future investigation deadline; this milestone
  establishes the per-tool cap but does not implement aggregate loop budgets.
- FR-12: contracts and dispatch remain provider-neutral.
- Section 11.1: version-controlled, schema-validated synthetic fixtures cover positive,
  not-found, ambiguous, and contradictory cases.
- Sections 12 and 13: adapters are server-only, use no arbitrary execution or SQL, reject
  enumeration, distinguish unavailable from not found, and remain deterministic for a fixture
  version.
- Milestone 1: fixtures, schemas, catalog, dispatcher, provenance, size limits, deadlines, and
  network-free adapter tests, with no agent loop or UI change.

## Current repository baseline

- `POST /api/tickets/resolve` currently runs the V1 classification, one knowledge retrieval, and
  one resolution generation path, then persists a validated result owned by the signed session.
- The existing provider-neutral `LlmProvider` exposes structured generation only. Anthropic SDK
  types remain in its adapter, and no provider-native tool execution exists.
- Knowledge retrieval already returns at most the configured final count (five by default),
  distinguishes insufficient evidence from source unavailability, and accepts injected fakes for
  deterministic tests.
- There are no V2 structured-source fixtures, investigation contracts, tool catalog, identifier
  provenance rules, or tool dispatcher.
- The worktree was clean before this plan was added. The baseline deterministic suite passes: 28
  test files and 190 tests.

## In scope

- Versioned synthetic customer, invoice, subscription, and service-status fixtures containing no
  real data.
- A provider-neutral tool catalog with exactly `searchKnowledge`, `getCustomerProfile`,
  `getInvoices`, `getSubscription`, and `getServiceStatus`.
- Strict Zod schemas for every request, mapped result, evidence record, status, and catalog entry.
- Exact identifier extraction/provenance from the submitted ticket and validated results from the
  same future run; no record enumeration or fuzzy identifier lookup.
- A server-only dispatcher that performs allowlist lookup, validation, authorization, deadline
  handling, result minimization, and final strict result validation before returning data.
- Read-only fixture adapters plus a knowledge-search adapter over the existing retriever.
- Stable fixture/catalog/schema version metadata needed by later persistence and evaluation work.
- Deterministic tests for validation, authorization, bounding, outages, prompt-injection-shaped
  data, and adapter non-invocation on rejected requests.
- Focused README documentation for the new internal foundation and its intentionally unavailable
  UI state.

## Explicitly out of scope

- The plan/act/observe/finish loop, investigation prompt, Anthropic generation changes, multi-turn
  model messages, or provider-native tool use.
- Aggregate tool-call, model-turn, token, context, retry, and 30-second run budgets; duplicate-call
  and non-progress termination; terminal-result validation; or missing-information generation.
- Any `POST /api/tickets/resolve` response change, UI change, timeline, investigation evidence
  route, or new user-visible behavior.
- Investigation/step/evidence database tables, migrations, persistence, action-confirmation
  changes, or changes to the V1 source route.
- V2 trajectory datasets, graders, evaluation history, or live provider evaluation.
- New dependencies, another provider, mutable tools, real integrations, arbitrary network access,
  dynamic tool discovery, SQL outside `src/db`, or unrelated refactoring.
- Final V2 observability topology. Tool observation nesting requires the Milestone 2 loop; this
  milestone will expose safe metadata from dispatch results without claiming a live trace audit.

## Implementation plan

### 1. Define versioned investigation and evidence contracts

- Add provider-neutral domain contracts for the five canonical tool names, safe purpose codes,
  tool statuses (`succeeded`, `not_found`, `invalid_request`, `unavailable`), validation outcome,
  and display-safe evidence records.
- Give each structured evidence record a stable fixture evidence key and a source type. Keep this
  separate from the per-investigation opaque evidence snapshot ID that Milestone 2 will create.
- Add strict, bounded request schemas:
  - `searchKnowledge`: bounded query plus optional existing category enum.
  - `getCustomerProfile`: one canonical synthetic customer ID.
  - `getInvoices`: exactly one lookup mode—one referenced customer ID or one to five referenced
    invoice IDs.
  - `getSubscription`: one referenced customer ID.
  - `getServiceStatus`: one enumerated synthetic service/component ID.
- Add strict result schemas with only scenario-required display fields, at most five records where
  applicable, bounded strings, and no raw fixture payload or internal database data.
- Export explicit `tool-catalog.v1`, `tool-schema.v1`, and `synthetic-sources.v1` constants so later
  runs and evaluations can record compatible versions without relying on filenames.

### 2. Add and validate synthetic source fixtures

- Add reviewable JSON fixtures under a dedicated `data/synthetic-sources/v1/` directory for
  customers, invoices, subscriptions, service state/incidents, and a manifest declaring the
  fixture version.
- Use stable human-readable synthetic IDs and deterministic relationships. Include the minimum
  records needed to represent duplicate settled invoices, incomplete/not-found lookups,
  subscription changes, known/no-known incidents, and contradictory fixture truth.
- Keep fixture-only fields distinct from display-safe result fields so explicit mapping proves
  minimization. Include adversarial instruction-shaped text only in a field that mapping excludes,
  allowing tests to prove it cannot enter tool output.
- Add a server-only loader that statically imports and parses the complete fixture set with strict
  Zod schemas, rejects duplicate IDs and broken references, and returns immutable indexed data.
  Do not depend on runtime file-system paths, seed PostgreSQL, or add another data store for these
  small V2 fixtures.

### 3. Establish identifier provenance and authorization

- Add deterministic extraction for only the documented synthetic identifier formats and
  enumerated service IDs explicitly present in ticket text. The extractor must not infer, fuzzily
  match, or enumerate identifiers.
- Represent provenance as an immutable per-run set partitioned by identifier kind, with helpers to
  add identifiers only from a validated tool result from that same run.
- Authorize each structured lookup against that provenance before adapter invocation. Reject
  mismatched identifier kinds, unknown IDs, unsupported combinations, and attempts to use an ID
  that appeared only in an untrusted non-identifier value.
- Keep knowledge queries exempt from record-ID provenance while still applying their own length,
  category, and result bounds.

### 4. Implement read-only tool services and the fixed catalog

- Add small server-only services for exact customer, invoice, subscription, and service-status
  lookup over the validated fixture index. Return deterministic `not_found` results rather than
  broad lists, and cap invoice results at five.
- Wrap the existing `EvidenceRetriever` for `searchKnowledge`, injecting it behind an internal
  interface. Map `insufficient_evidence` to a clean `not_found` tool result and preserve
  infrastructure failure as `unavailable`; never expose retrieval/provider/database details.
- Map adapter data explicitly into display-safe result objects, then validate the mapped object
  against the strict result schema. Do not pass raw fixture or retrieval objects through.
- Define the catalog statically in source with canonical name, purpose, request schema, result
  schema, and handler. Do not accept a URL, implementation, query language, or runtime-defined
  schema from a caller.

### 5. Add the bounded dispatcher and tool failure contract

- Accept a decision as `unknown`, resolve only an exact catalog name, parse arguments with the
  selected strict schema, authorize identifiers, and invoke the handler only after all checks pass.
- Add an injectable monotonic clock/timeout boundary and `AbortSignal` propagation. Add
  `INVESTIGATION_TOOL_TIMEOUT_MS` with a 3,000 ms default and a schema-enforced 10,000 ms maximum,
  keeping every tool deadline below the future V2 30-second hard request cap.
- Return a typed, bounded attempt result containing only canonical tool name, safe purpose, status,
  duration, validation outcome, result count, and evidence keys. Keep telemetry-ready metadata
  separate from the validated display/model result, and include no raw arguments, raw results,
  exception text, or source identifiers in that metadata.
- Distinguish invalid/unauthorized requests, clean not-found data, and source unavailability.
  Unexpected or schema-invalid mapped results fail closed as a typed internal tool-source error.
- Leave attempt counting, duplicate fingerprints, accumulated-evidence comparison (including the
  `addedEvidence` flag), and loop termination to Milestone 2; the dispatcher must be stateless and
  safe to compose into that loop.

### 6. Add deterministic coverage

- Test each fixture schema and cross-record invariant, including duplicate/broken IDs and the
  positive, not-found, ambiguous, contradictory, and adversarial records required by the PRD.
- Test every argument boundary: unknown keys, oversized strings/lists, invalid enums/formats,
  invalid invoice lookup combinations, unsupported tool names, and identifier-kind spoofing.
- Prove invalid or unauthorized attempts never call an adapter and cannot enumerate records.
- Test exact fixture lookups, five-record caps, stable ordering, clean not-found behavior,
  explicit result-field minimization, strict mapped-result rejection, timeout/abort behavior, and
  unavailable-source mapping.
- Test `searchKnowledge` with an injected retriever only: successful bounded evidence, insufficient
  evidence mapped to not found, and infrastructure failure kept distinct. Make no Voyage,
  Anthropic, or database network calls.
- Add a regression assertion that serialized dispatcher output excludes ticket text, raw
  instruction-shaped fixture content, raw arguments, exception messages, and unrelated records.

### 7. Document and verify the milestone

- Update README architecture/status documentation to list the V2 deterministic tool foundation,
  fixture version, five-tool allowlist, synthetic/read-only guarantee, and the fact that the V1
  resolve path remains active until a separately approved Milestone 2 implementation.
- Run `pnpm verify`.
- Review the final Git diff to confirm that it contains only this approved milestone, its tests,
  and documentation; no API/UI/provider/database/evaluation changes should appear.

## Acceptance criteria

1. The catalog exposes exactly the five V2 read-only tool names and rejects every other name before
   any adapter is invoked.
2. Every tool argument is strictly schema-valid, bounded, and authorized from explicit ticket or
   same-run result provenance before dispatch; invalid requests cannot enumerate data.
3. Every tool output is explicitly minimized, strictly validated, bounded, versioned, and safe to
   place in later model context; raw fixture/retrieval payloads do not cross the mapping boundary.
4. Customer, invoice, subscription, and service lookups are deterministic for
   `synthetic-sources.v1`, read only, and distinguish `not_found` from `unavailable`.
5. Knowledge search reuses the existing retrieval boundary, returns no more than five validated
   evidence records, maps insufficient evidence to not found, and preserves infrastructure errors.
6. Per-tool deadlines and cancellation are enforced below the V2 hard request cap, with no work
   intentionally continuing after cancellation.
7. The fixture set is synthetic, schema-valid, internally consistent, and covers the PRD's
   positive, not-found, ambiguous, contradictory, and adversarial foundation cases.
8. Deterministic tests make no live provider/database calls and prove that rejected requests do not
   reach adapters and prohibited/raw data does not appear in dispatcher results.
9. The existing V1 route, UI, persistence, action confirmation, and evaluation behavior remain
   unchanged, and `pnpm verify` passes.
10. Documentation states that this milestone starts Story 1 but does not yet provide the bounded
    investigation or a V2 terminal result.

## Manual verification checklist for handoff

1. Run the focused investigation-tool test files and confirm all five catalog entries, fixture
   lookups, provenance rejection, timeout behavior, and knowledge-search mappings pass without
   credentials or network access.
2. Inspect `data/synthetic-sources/v1/` and confirm every record is visibly synthetic, stable, and
   free of secrets, real customer data, and full payment credentials.
3. Start the existing application with `pnpm dev`, submit a current V1 synthetic ticket, and
   confirm the UI/API behavior is unchanged; no investigation timeline or V2 claim should appear.
4. Run `git diff --check` and inspect `git diff --stat` to confirm there are no generated,
   provider, route, UI, database, or unrelated dependency changes.

## Follow-up plan required to complete Story 1

After this milestone is implemented and accepted, create a separate plan for **Milestone 2:
bounded investigation core**. That plan will consult the current Anthropic structured-output and
multi-turn message documentation before changing generation code, define the versioned agent
decision/terminal schemas and prompt, add aggregate budgets and deterministic termination, persist
the investigation atomically, and switch the existing resolve service to return one validated V2
terminal result. Milestone 3 will separately own the timeline/evidence presentation.
