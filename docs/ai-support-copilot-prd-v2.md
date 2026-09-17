# Product Requirements Document: V2 Bounded Ticket-Investigation Agent

**Status:** Proposed V2 product contract; implementation not started  
**Relationship to V1:** Additive successor to `ai-support-copilot-prd.md`  
**Product type:** Portfolio-ready web application  
**Primary implementation language:** TypeScript

## 1. Document purpose and relationship to V1

This document defines V2 of AI Support Ticket Resolution Copilot. The implemented V1 product and
its PRD remain unchanged as the historical baseline. V2 intentionally supersedes only these V1
limitations:

- V1 follows one application-selected classification, retrieval, and resolution path. V2 may let
  one model-directed investigation choose among a fixed set of read-only synthetic tools.
- V1 exposes retrieved knowledge and a final proposal but not a multi-step investigation
  trajectory. V2 adds a display-safe investigation timeline and evidence inspection.
- V1 represents missing evidence as either a reply or human review. V2 adds a distinct structured
  `missing_information` terminal outcome while retaining `reply`, `request_refund_review`, and
  `needs_human_review` as the only recommended actions.

All other V1 safety boundaries remain in force unless this document explicitly changes them. In
particular, V2 remains a proposal system for synthetic tickets. It does not send replies, execute
real operations, or give the model direct access to tools, SQL, secrets, or external systems.

This is a product contract, not a technical specification. Concrete schemas, migrations, prompt
text, and module boundaries require a separately approved implementation plan.

## 2. Product summary

V2 helps a support agent investigate a synthetic ticket whose resolution depends on more than one
source. A single specialized investigation agent can request information from a small,
application-owned allowlist of read-only synthetic tools. The application validates and executes
each request, returns bounded untrusted results to the model, and deterministically stops the run
when it reaches a valid terminal outcome or a safety budget.

The user receives:

- The existing category, priority, summary, and confidence signal.
- A proposed reply, a proposed mock refund-review action, a structured request for missing
  information, or a human-review recommendation.
- A concise investigation timeline showing which approved sources were checked and what each
  check established.
- Inspectable evidence for every factual claim that depends on synthetic records or knowledge.
- An explicit explanation when the investigation stopped because evidence, progress, or budget was
  insufficient.

The workflow is bounded orchestration, not general-purpose autonomy. The application owns the
loop, tool catalog, validation, dispatch, budgets, termination rules, persistence, and mutation
boundary. The model can propose only the next allowlisted read operation or a terminal result.

## 3. Problem statement

The V1 pipeline is appropriate when a ticket can be resolved from one semantic knowledge search.
It is insufficient for demo cases that require joining facts across sources. Examples include:

- Confirming whether two invoice records are both settled duplicates before proposing a refund
  review.
- Checking the current subscription state before explaining upgrade or downgrade behavior.
- Distinguishing a local troubleshooting problem from a known service incident.
- Determining which required facts are absent before asking the customer focused questions.

A one-shot prompt can guess which facts exist, over-fetch unrelated data, or conflate missing data
with an unavailable system. A general autonomous agent would make those risks harder to bound and
test. V2 needs a narrow middle ground: model-directed source selection inside deterministic
application limits, with inspectable evidence and human control.

## 4. Goals and success criteria

### 4.1 Goals

1. Resolve synthetic multi-source tickets with one bounded investigation workflow.
2. Let the model choose useful read-only checks without granting it execution authority.
3. Make the investigation understandable without exposing hidden reasoning, prompts, or unsafe raw
   data.
4. Distinguish answerable cases, customer-fixable missing information, unsupported cases, and
   operational failures.
5. Preserve citation provenance and explicit human confirmation for every mock mutation.
6. Measure final-answer quality and trajectory quality with a repeatable offline evaluation suite.
7. Record enough redacted telemetry to diagnose tool choice, latency, cost, validation, and
   termination behavior.

### 4.2 Initial quality targets

These are release targets, not claims about an unimplemented or unevaluated system:

| Metric                                               | Initial target   |
| ---------------------------------------------------- | ---------------- |
| Terminal result schema validity                      | 100%             |
| Allowlist and investigation-budget compliance        | 100%             |
| Tool argument validity before dispatch               | 100%             |
| Appropriate tool choice on labeled decision steps    | at least 90%     |
| Final outcome accuracy                               | at least 90%     |
| Citation provenance                                  | 100%             |
| Citation support on grounded claims                  | at least 90%     |
| Missing-information classification accuracy          | at least 85%     |
| Correct deterministic termination                    | 100%             |
| Unauthorized or unconfirmed mock mutations           | 0                |
| P95 end-to-end latency in the documented environment | under 20 seconds |

Latency, token use, retry count, tool-call count, and estimated cost must always be measured and
reported. Cost remains unavailable rather than guessed when reviewed pricing is not configured.

## 5. Non-goals

V2 will not:

- Add multiple agents, delegated subagents, agent-to-agent communication, or role-based agent
  teams.
- Add a general-purpose autonomous loop, background continuation, self-modifying prompt, online
  learning, or open-ended planning.
- Let the model browse the web, discover tools dynamically, call arbitrary URLs, run code, issue
  SQL, access the file system, or read environment variables or secrets.
- Connect to a real customer, billing, payment, subscription, service-status, or help-desk system.
- Send a customer message or describe a proposed draft as sent, approved, or authoritative.
- Execute refunds, payments, subscription changes, account changes, or any other real side effect.
- Execute even a mock mutation inside the investigation loop.
- Add user accounts, authentication screens, organizations, roles, multi-tenancy, or billing.
- Add streaming, chat history, follow-up conversations, or server-owned conversation memory.
- Add another text-generation provider, automatic provider routing, or model fallback.
- Change Voyage AI's role from embedding generation.
- Add a production analytics dashboard or expose local evaluation surfaces in production.
- Add arbitrary uploads, crawling, non-Markdown ingestion, or a knowledge-base administration UI.
- Treat Langfuse or another optional diagnostic backend as the durable system of record.

## 6. Users

### 6.1 Primary user: support agent

The support agent needs a fast, evidence-backed recommendation and a clear explanation of which
sources were checked. The agent retains control over the proposed response and every mock action.

### 6.2 Secondary user: AI application engineer

The engineer needs to inspect safe investigation trajectories, validation and termination results,
tool effectiveness, retrieval quality, latency, token use, and evaluation regressions.

## 7. Demo scenarios

V2 must demonstrate at least these end-to-end scenarios using version-controlled synthetic data:

1. **Duplicate settled invoices:** look up the referenced customer and invoices, verify the
   duplicate-charge conditions, retrieve the relevant policy, and propose a pending mock refund
   review.
2. **Incomplete duplicate-charge request:** find that invoice identifiers or required charge facts
   are absent and return a focused `missing_information` result with no action proposal.
3. **Subscription-change explanation:** inspect the synthetic subscription state and applicable
   knowledge before drafting a cited reply.
4. **Known service incident:** check service status, distinguish a current incident from a local
   problem, and draft a cited response.
5. **No known incident:** check service status, then retrieve troubleshooting guidance without
   repeating the same lookup.
6. **Contradictory records:** detect incompatible ticket and tool facts and finish with
   `needs_human_review` rather than selecting the convenient fact.
7. **Prompt injection in ticket or tool output:** ignore instructions embedded in untrusted data,
   use only the allowlisted operations, and preserve the confirmation boundary.
8. **Budget exhaustion or non-progress:** terminate deterministically with a visible human-review
   reason and no partial action.
9. **Tool or provider outage:** return a controlled retryable failure, not a fabricated answer or a
   claim that the customer omitted information.

## 8. Core user stories

1. As a support agent, I can submit a synthetic ticket and receive one terminal result without
   managing the investigation steps myself.
2. As a support agent, I can see which approved sources were checked, in order, and whether each
   check found relevant facts.
3. As a support agent, I can inspect the exact display-safe evidence used by the proposal.
4. As a support agent, I receive focused questions when facts I can provide are missing.
5. As a support agent, I see an explicit warning when evidence is contradictory, unsupported, or
   exhausted.
6. As a support agent, I can approve or reject a pending mock refund-review proposal after the
   investigation, through the existing separate confirmation flow.
7. As an engineer, I can run a versioned trajectory evaluation and identify wrong tool choices,
   invalid arguments, unnecessary calls, grounding failures, and incorrect termination.
8. As an engineer, I can correlate a resolution with a safe trace that shows individual model and
   tool steps, budgets, and aggregate usage without customer text or raw payloads.

## 9. End-to-end experience

### 9.1 Ticket submission

The home screen continues to accept `{ text, customerTier? }`. Demo tickets may contain synthetic
customer, invoice, subscription, or service identifiers. The application validates the request,
creates or verifies the anonymous signed session, assigns a trace ID, and starts one synchronous
investigation.

V2 does not require a new account selector or hidden customer context. If the ticket lacks a
synthetic identifier required by a tool, the agent must request that information rather than infer
or enumerate identifiers.

### 9.2 Processing state

The UI shows a non-streaming investigation state, prevents duplicate submission, and explains that
the application is checking synthetic sources. The final timeline appears only after the server has
validated and persisted the terminal result. V2 does not expose partial steps while the request is
running.

### 9.3 Investigation timeline

The result contains an ordered, display-safe timeline. Each step shows:

- A one-based step number.
- The approved source type checked, using a user-facing label rather than an internal function
  signature.
- A short application-generated purpose selected from a bounded set.
- `succeeded`, `not_found`, `invalid_request`, `unavailable`, or `not_executed` status.
- A bounded factual summary and evidence references when available.
- Whether the step added new evidence.

The timeline must not expose chain-of-thought, hidden reasoning, system prompts, complete model
messages, raw tool arguments, raw tool results, database identifiers, secrets, or provider errors.
It must not imply that checking a source changed that source.

### 9.4 Terminal results

Every successful investigation returns exactly one terminal outcome:

| Outcome               | Meaning                                                                                                | Recommended action                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `proposal`            | Evidence supports a response or pending mock review.                                                   | `reply` or `request_refund_review` |
| `missing_information` | Specific customer-providable facts are required to continue safely.                                    | `reply`                            |
| `needs_human_review`  | Evidence is unsupported, contradictory, inaccessible after safe handling, or the loop cannot progress. | `needs_human_review`               |

A `missing_information` result contains one to three concise questions and structured missing-field
codes. It contains no action proposal and makes no unsupported policy claim. It may cite evidence
that establishes why a field is required, but it must not pretend that an absent record is proof of
a customer omission.

A `proposal` preserves the existing V1 action vocabulary. A refund-review proposal is still only
`pending_confirmation`; it is never an executed result.

### 9.5 Evidence inspection

Every timeline fact and every final policy or record-dependent claim references evidence retrieved
during the same investigation. Selecting a reference loads only an immutable display-safe snapshot
authorized for the owning signed session and investigation.

Knowledge evidence includes the existing title, section, and excerpt. Structured tool evidence
includes only fields explicitly approved for display, such as synthetic invoice status, amount,
currency, billing period, service state, or subscription state. It excludes internal row IDs,
vectors, hashes, secrets, raw payloads, unrelated records, and fields not used by the investigation.

### 9.6 Action confirmation

When the terminal proposal recommends `request_refund_review`, the UI displays validated arguments
and requires the user to choose confirm or reject. Confirmation remains a separate same-origin
request after the investigation has finished. The existing session ownership, evidence ownership,
revalidation, row locking, idempotency, and immutable-result requirements continue to apply.

Rejecting the proposal sends no mutation request. Confirmation produces only a local mock audit
result and must be labeled as neither approval nor payment activity.

## 10. Functional requirements

### FR-1: One specialized investigation agent

The system must run at most one investigation agent per ticket. The agent's sole purpose is to
gather enough evidence to produce one support-ticket terminal result. It cannot delegate work,
spawn another agent, retain memory across tickets, or start background work.

### FR-2: Application-owned plan/act/observe/finish loop

The application must own the loop and expose only two model decisions at each turn:

- Request exactly one allowlisted read-only tool with structured arguments.
- Finish with exactly one schema-valid terminal result.

The application, not the model or provider SDK, must validate the decision, enforce budgets,
dispatch a valid tool call, append a bounded result, and decide whether another turn is allowed.
The model must never receive a callable database client, SDK client, network client, or mutation
function.

### FR-3: Fixed read-only synthetic tool allowlist

V2 permits only these logical tools:

| Tool                 | Required purpose                                                                                    | Bounded result                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `searchKnowledge`    | Search the version-controlled Markdown knowledge base.                                              | At most five matching chunk snapshots with scores and safe metadata.         |
| `getCustomerProfile` | Look up one explicitly referenced synthetic customer.                                               | Tier, account state, and only the display-safe fields required by scenarios. |
| `getInvoices`        | Look up explicitly referenced synthetic invoices or invoices for one referenced synthetic customer. | At most five invoices with allowlisted billing fields.                       |
| `getSubscription`    | Look up the current synthetic subscription for one referenced customer.                             | One bounded subscription snapshot or not-found result.                       |
| `getServiceStatus`   | Check one enumerated synthetic service or component.                                                | Current state and at most one relevant active incident snapshot.             |

The catalog and schemas are versioned in application source. The model cannot provide a tool URL,
implementation, query language, output schema, or tool name outside the catalog. Adding or changing
a tool is a product and evaluation change, not a runtime discovery operation.

### FR-4: Strict argument validation and authorization

Every tool request must pass a strict Zod schema that rejects unknown keys, oversized strings,
unrecognized identifier formats, excessive list sizes, unsupported enum values, and invalid field
combinations. The dispatcher must authorize the canonical tool name and schema before invoking an
application service.

Identifiers must come from the submitted synthetic ticket or a prior validated result in the same
run. The agent may not enumerate customers, invoices, subscriptions, or services. Invalid requests
must not reach a data adapter.

### FR-5: Strict result validation and minimization

Every tool result must be parsed against a strict versioned result schema before it enters model
context, persistence, the API response, or telemetry. Results are bounded by record count, field
count, string length, and aggregate serialized size. Unexpected fields are dropped only at an
explicit mapping boundary; schema-invalid mapped results produce a controlled failure.

The application must frame all ticket text, knowledge content, and tool output as untrusted data.
Instructions contained in those values have no authority over the loop, tool catalog, budgets,
validation, or mutation policy.

### FR-6: Hard investigation budgets

Each run must enforce all of these application-level caps:

- At most four tool-call attempts, including invalid, unsupported, and duplicate requests.
- At most five model decision turns, including the terminal turn.
- At most 30,000 cumulative model input tokens and 4,000 cumulative model output tokens.
- At most 6,000 tokens of tool and knowledge results retained in active model context.
- A 20-second end-to-end target and a 30-second hard request deadline, with shorter per-provider
  and per-tool deadlines inside it.

Configuration may lower these values for tests or deployment. It must not raise them above these V2
MVP hard caps without a new approved product change. Retries count toward time and token budgets.
No retry or continuation may outlive the request deadline.

### FR-7: Duplicate-call and non-progress detection

The application must canonicalize and fingerprint each validated tool request. An exact duplicate
must not re-execute the tool. The repeated attempt counts against the four-call budget and ends the
loop as `needs_human_review` with reason code `duplicate_call`.

Each successful call must report the stable evidence IDs it added. Two consecutive executed calls
that add no new evidence must end the loop with reason code `non_progress`. This comparison is
deterministic and must not depend on hidden model reasoning.

### FR-8: Deterministic termination

The application must terminate immediately when any of these conditions occurs:

- A terminal result passes schema, evidence-provenance, grounding, and action-policy validation.
- A duplicate call or two consecutive no-new-evidence calls are detected.
- The tool-call, model-turn, token, context, time, or retry budget is exhausted.
- The provider refuses, truncates, times out, or repeatedly returns invalid output according to the
  existing bounded retry policy.
- A tool result cannot be safely validated or a required internal source is unavailable.

Budget and progress terminations return a successful `needs_human_review` resolution with a stable
reason code only when the system itself remains healthy. Provider or tool infrastructure failures
that make the result unreliable return the existing controlled retryable or non-retryable API
error. They must not be mislabeled as insufficient customer information.

### FR-9: Grounded terminal proposals

All policy claims and synthetic-record facts in a `proposal` or `missing_information` result must
cite evidence retrieved in the current run. The server must verify that each citation references an
owned, validated evidence snapshot and that every referenced snapshot existed before the terminal
decision.

The server must reject invented citations, citations from another run or session, mutation
recommendations outside the action allowlist, refund reviews outside billing, and refund-review
arguments not supported by the cited record and policy evidence. Semantic support remains an
evaluation concern in addition to deterministic provenance checks.

### FR-10: Missing-information outcome

The model may select `missing_information` only when one or more enumerated facts are necessary and
could reasonably be supplied by the customer. The application validates missing-field codes
against a versioned allowlist, limits questions to three, and rejects requests for secrets,
passwords, private keys, full payment credentials, or unrelated personal data.

Missing information must be distinguished from not-found data, contradictory evidence, source
unavailability, and unsupported policy. Those cases route to additional safe investigation, a
controlled error, or `needs_human_review` as appropriate.

### FR-11: Separate mutation boundary

The investigation tool catalog contains no mutation. A terminal refund-review proposal may create
the existing session-owned pending action record only after the complete resolution and cited
evidence are validated and persisted atomically. Execution remains possible only through the
separate explicit confirmation API.

Ticket text, model output, tool output, or a timeline entry cannot confirm an action. Confirmation
must revalidate stored arguments and evidence ownership and must return the original result for
repeated or concurrent requests.

### FR-12: Provider-neutral orchestration

The investigation loop, domain contracts, tool catalog, budgets, and termination rules must remain
provider-neutral. Anthropic remains the only structured text-generation adapter, and Voyage AI
remains limited to embeddings. Provider-specific tool or message shapes must not leak into domain,
UI, tool, retrieval, action, or evaluation code.

### FR-13: Investigation persistence

For each successful terminal result, the application must persist enough validated data to
reconstruct the display-safe timeline and authorize evidence access:

- Run and trace identifiers, owning session hash, one-way ticket hash, and timestamps.
- Agent, prompt, tool-catalog, policy, retrieval, and schema versions.
- Classification and terminal outcome.
- Ordered step number, canonical tool name, safe purpose code, status, duration, validation result,
  retry count, and whether new evidence was added.
- Immutable display-safe evidence snapshots and their relation to steps and final citations.
- Aggregate token usage, tool-call count, model-turn count, termination reason, and total latency.

The database must not persist raw ticket text, hidden reasoning, complete prompts, raw provider
messages, raw provider responses, or raw tool payloads. A failed run persists only the existing
redacted failure metadata necessary for operational diagnosis; it must not leave a pending action.

### FR-14: API compatibility and evidence access

`POST /api/tickets/resolve` remains the ticket-resolution entry point and continues to accept
`{ text, customerTier? }`. Its successful `ApiResult<Resolution>` adds a versioned investigation
summary, timeline, terminal outcome, budget usage, and evidence references. Existing V1-style
single-pass results remain parseable during migration through an explicit response schema version;
the server never guesses a version from optional fields.

V2 adds an owner-authorized evidence route scoped by investigation and evidence ID. It returns only
the immutable display-safe snapshot cited by that investigation. Unknown, uncited, malformed, and
cross-session identifiers share the same non-revealing response and are private and non-cacheable.
Knowledge citations may continue to use the existing source route during migration, provided the
same ownership and immutable-snapshot guarantees hold.

The existing refund-review confirmation route and its contract remain unchanged.

### FR-15: UI rendering and accessibility

The UI must render classification, terminal outcome, proposed draft or questions, timeline,
evidence, budget-stop warnings, and confirmation state without importing server-only modules. It
must:

- Label all drafts and questions as proposals requiring human judgment.
- Use text and accessible status semantics in addition to color.
- Preserve keyboard navigation, visible focus, and screen-reader announcements.
- Remain usable at narrow and wide viewports.
- Distinguish not-found evidence, unavailable systems, insufficient evidence, contradictory
  evidence, validation failure, and timeout.
- Never render raw structured payloads as a substitute for a designed evidence view.

### FR-16: Redacted observability

One application trace represents one complete investigation. The trace must nest individual model
generation and read-only tool observations under a stable investigation observation. Each model
turn remains a separate generation so per-turn latency, model, token use, finish reason, retry, and
validation can be measured. Each tool attempt records the stable tool name, ordinal, status,
duration, result count, and whether it added evidence.

Telemetry may include category, priority, terminal outcome, reason codes, budget limits and usage,
schema versions, prompt/tool/policy versions, aggregate evidence counts, and low-cardinality error
codes. It must exclude ticket text, summaries, questions, drafts, prompts, hidden reasoning,
tool arguments, tool results, source and record identifiers, session or ticket hashes, action
arguments, credentials, raw provider payloads, exception messages, and stack traces.

Pino logs and PostgreSQL remain operational and durable systems of record. Optional Langfuse export
remains metadata-only, batched, and fail-open. Trace-export failure must not consume investigation
budget or change the user result.

### FR-17: Offline trajectory evaluation

The shared CLI and local-only evaluation console must support a versioned V2 agent dataset and
produce schema-validated safe reports. Evaluation must grade both the terminal result and the path
used to reach it. It must not require Langfuse and must not write raw tickets, tool payloads,
prompts, drafts, or source content into persisted history or downloadable reports.

V2 evaluation must be compatible only when dataset version/hash, case IDs, scenario-fixture
version, prompt versions, tool-catalog version, policy version, retrieval configuration, model, and
threshold version are visible. Comparisons must display differences in those values as confounders.

### FR-18: Controlled error handling

The API must preserve the existing distinction among invalid input, configuration error, provider
refusal, truncation, provider timeout, retryable provider unavailability, retrieval failure,
tool-source failure, schema-invalid output, persistence failure, and successful safety abstention.
Errors expose the trace ID, stable safe code, safe message, and retryability only.

No partial proposal, timeline, evidence grant, or pending action may be returned when atomic
persistence fails. No failure response may expose provider bodies, SQL, tool payloads, secrets, or
stack traces.

## 11. Data requirements

### 11.1 Synthetic source fixtures

V2 must add version-controlled synthetic fixtures for customer profiles, invoices, subscriptions,
and service status while retaining the existing Markdown knowledge base. Fixtures must:

- Contain no real customer, account, payment, or incident data.
- Use stable human-recognizable synthetic identifiers and deterministic relationships.
- Include positive, not-found, ambiguous, and contradictory cases.
- Be validated before tests, local startup seeding, or evaluation uses them.
- Be small enough for code review and deterministic test setup.
- Never contain secrets, full payment credentials, passwords, or private keys.

### 11.2 Agent evaluation dataset

A separate versioned V2 dataset must contain 40 to 60 synthetic scenarios. Each scenario declares:

- Stable case and fixture-version identifiers.
- Ticket input and optional customer tier.
- Expected category, allowed priority, terminal outcomes, and actions.
- Allowed and required tool names, forbidden tools, and maximum useful call count.
- Required argument facts or argument constraints without storing secrets.
- Relevant evidence fixture IDs and expected missing-field codes.
- Whether the result should abstain, request information, or propose a refund review.
- Scenario tags and an explicit adversarial label where applicable.

The set must cover normal multi-source cases, single-source cases, missing identifiers, not-found
records, contradictory records, repeated calls, irrelevant calls, invalid arguments, budget
pressure, provider/tool unavailability, and prompt injection in both ticket and tool data.

At least 20% of scenarios must be adversarial or safety-focused. At least 20% must have
`missing_information` or `needs_human_review` as the correct outcome. Action-ready cases must
include enough fixture truth to evaluate the refund-review argument policy deterministically.

### 11.3 Persistence and retention

V2 may add normalized investigation-run, step, and evidence-snapshot records linked to the existing
resolution run. Database constraints must preserve step ordering, run ownership, evidence
provenance, non-negative telemetry, version presence, and at-most-one pending action per eligible
resolution.

The V2 MVP uses the existing project retention posture and adds no user-facing deletion or
production analytics feature. Documentation must state that all fixtures are synthetic and that
raw tickets and raw model/tool payloads are not persisted.

## 12. Security and privacy requirements

- Treat ticket text, Markdown, structured tool results, model output, URL parameters, cookies, and
  stored JSON as untrusted input.
- Execute tools only after canonical allowlist lookup plus strict argument validation.
- Keep tool adapters server-only; the browser must never call them directly.
- Use parameterized data access through `src/db`; no tool or orchestration layer issues SQL.
- Require the owning anonymous signed session for investigation evidence and pending actions.
- Do not expose whether an evidence or proposal identifier exists across sessions.
- Prevent identifier enumeration by rejecting ungrounded identifiers and bounding result counts.
- Delimit and label tool results as data, and exclude any data-supplied instruction from control
  flow.
- Never expose provider keys, database URLs, cookie secrets, prompts, raw provider responses,
  embeddings, vectors, internal IDs, or unrelated records.
- Never persist or trace raw ticket text, complete prompts, hidden reasoning, raw provider
  responses, or raw tool results.
- Validate every final citation against evidence owned by the same investigation.
- Keep every mutation outside the agent loop and behind explicit session-owned confirmation.
- Use synthetic data only in the repository, demonstrations, screenshots, tests, and evaluations.

Threat-focused deterministic tests must cover prompt injection, tool-name spoofing, extra argument
keys, oversized arguments, identifier enumeration, cross-session evidence access, forged
citations, duplicate calls, budget bypass, confirmation bypass, and malicious instructions inside
tool results.

## 13. Reliability requirements

- All budgets use monotonic elapsed time where available and are checked before and after each
  provider or tool boundary.
- Tool adapters have shorter deadlines than the remaining request budget and cannot continue after
  request cancellation.
- Retries are limited to existing transient-error classes, recorded, and charged to the aggregate
  budget.
- Exact duplicate tool requests are never executed twice within a run.
- Read-only tools return deterministic results for a fixed fixture version and arguments.
- Successful resolution, evidence snapshots, and any pending action are persisted atomically.
- Repeated or concurrent action confirmations remain idempotent and return one immutable result.
- Optional tracing fails open; required generation, data access, validation, and persistence fail
  closed.
- A tool outage cannot be represented as a clean not-found result.
- A malformed or oversized tool result cannot enter the model context.
- Unit and integration tests remain network-free; live provider evaluation remains explicitly
  enabled, budgeted, and manually run.

## 14. UX content requirements

The interface must use language that preserves human control:

- “Proposed reply,” never “sent reply.”
- “Proposed mock refund review,” never “refund approved” or “refund issued.”
- “Checked synthetic invoice records,” never “updated billing.”
- “More information is needed,” followed by focused questions, rather than a generic failure.
- “Needs human review” with a stable user-facing reason for contradiction, unsupported scope,
  non-progress, or budget stop.
- “Source unavailable—retry may help” for retryable infrastructure failure, rather than blaming the
  customer or claiming that no record exists.

The timeline may summarize that a source matched, did not match, or was unavailable. It must not
anthropomorphize hidden deliberation or display phrases such as “the model thought.”

## 15. Evaluation design and metrics

### 15.1 Deterministic metrics

| Metric                         | Definition                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Terminal schema validity       | Share of cases with a valid terminal V2 contract.                                                                                |
| Category and priority accuracy | Existing classification grades against allowed labels.                                                                           |
| Final outcome accuracy         | Exact match against allowed `proposal`, `missing_information`, or `needs_human_review` outcomes.                                 |
| Action accuracy                | Existing action is one of the case's allowed actions.                                                                            |
| Tool allowlist compliance      | No attempted tool name falls outside the versioned catalog.                                                                      |
| Tool argument validity         | Valid dispatched attempts divided by all attempts; release safety additionally requires zero invalid request reaches an adapter. |
| Tool choice accuracy           | Labeled decision points where the selected tool is allowed and useful.                                                           |
| Required-tool recall           | Required tools successfully called divided by required tools for answerable cases.                                               |
| Forbidden-tool rate            | Cases with any labeled forbidden or irrelevant tool call.                                                                        |
| Evidence recall                | Expected fixture evidence retrieved before finish.                                                                               |
| Citation provenance            | Citations owned by and retrieved during the same run.                                                                            |
| Missing-information accuracy   | Correct terminal classification and expected missing-field codes.                                                                |
| Termination correctness        | Correct reason and point for finish, budget, duplicate, non-progress, refusal, and failure cases.                                |
| Budget compliance              | Runs staying within every configured hard cap.                                                                                   |
| Trajectory efficiency          | Successful runs at or below the scenario's maximum useful call count.                                                            |
| Duplicate execution rate       | Exact duplicate requests actually executed; target is zero.                                                                      |
| Mutation safety                | Action execution before valid explicit confirmation; target is zero.                                                             |

### 15.2 Model-judged metrics

Citation support and answer completeness may use the existing versioned Anthropic judge only after
deterministic provenance checks. The judge sees only the synthetic evidence required for the claim,
never hidden prompts or unrelated records. Judge prompt/model versions, tokens, latency, failures,
and calibration limitations remain visible.

Model-judged scores are advisory until calibrated on a reviewed sample. They must not override a
deterministic safety failure or allow a run with invalid provenance, budget, or confirmation
behavior to pass.

### 15.3 Operational metrics

Reports include P50/P95 total latency, per-turn generation latency, per-tool latency, cumulative
input/output tokens, cached tokens when available, tool calls, model turns, retries, validation
failures, termination reasons, error counts, and estimated cost when configured.

Metric denominators must be shown. Metrics with no eligible cases are `null`, not zero or passing.
The CLI exits non-zero when a configured threshold is unavailable or fails.

## 16. Observability requirements

The trace tree should represent the real application control flow:

1. One stable root observation for the ticket investigation.
2. Classification as its own generation when classification remains a separate model call.
3. One stable investigation-agent observation containing interleaved decision generations and tool
   attempts.
4. Tool-specific read observations for customer, invoice, subscription, and status lookups;
   knowledge vector search remains a retrieval observation with its embedding child.
5. Grounding and action-policy validation as guardrail observations.
6. Atomic persistence as a separate application operation.

Names are stable and contain no IDs, model names, attempt numbers, or ticket values. Ordinals and
versions are attributes. Every generation records its actual model and token use separately rather
than aggregating the whole loop into one generation.

The existing optional Langfuse projection may use its `agent`, `generation`, `tool`, `retriever`,
`embedding`, and `guardrail` observation types when supported by the installed integration. The
project-owned OpenTelemetry abstraction remains authoritative so Langfuse-specific types do not
leak into business contracts.

Before observability work is considered complete, an explicitly configured synthetic live run must
be sent, fetched, and audited for correct nesting, stable names, useful metadata, and prohibited
data. Deterministic tests alone do not prove exporter behavior.

## 17. API and product-contract summary

| Surface                                                         | V2 contract                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/tickets/resolve`                                     | Starts one synchronous bounded investigation for the owning signed session and returns a versioned terminal resolution plus safe timeline. |
| `GET /api/investigations/:investigationId/evidence/:evidenceId` | Returns only an immutable display-safe snapshot cited by the owned investigation.                                                          |
| `GET /api/sources/:chunkId`                                     | Remains available for V1-compatible knowledge evidence while preserving current ownership checks.                                          |
| `POST /api/actions/refund-review/:proposalId/confirm`           | Retains the existing explicit, session-owned, revalidated, idempotent mock confirmation contract.                                          |
| Local `/api/evaluations/**`                                     | Runs, lists, and compares V2 evaluations only when the existing local-only feature gate allows it.                                         |

All responses use `ApiResult<T>`, include the trace ID, and set private non-cacheable headers where
session-owned data is returned. Production continues to disable evaluation APIs and the admin
console with a non-revealing response.

## 18. Release milestones

### Milestone 1: deterministic tool foundation

- Versioned synthetic fixtures and strict schemas.
- Application-owned read-only tool catalog and dispatcher.
- Identifier provenance, size limits, deadlines, and network-free adapter tests.
- No agent loop and no UI change yet.

### Milestone 2: bounded investigation core

- Provider-neutral decision contract and versioned prompt.
- Loop with four-call, turn, token, context, retry, and deadline budgets.
- Duplicate and non-progress detection.
- Grounding, terminal-outcome, and action-policy validation.
- Atomic run, step, evidence, and pending-action persistence.

### Milestone 3: agent-facing experience

- Versioned resolve response and display-safe timeline.
- Session-owned structured evidence inspection.
- Missing-information and budget-stop presentations.
- Existing refund-review confirmation integrated with V2 evidence.
- Accessibility and responsive-state verification.

### Milestone 4: measurable release

- Versioned V2 scenario fixtures and 40–60-case dataset.
- Deterministic trajectory graders and calibrated advisory citation judge.
- CLI and local-console reporting and compatible-run comparison.
- Redacted per-turn and per-tool observability with a live synthetic trace audit.
- README, architecture, operations, manual test, and measured-results updates.

Each milestone requires its own approved implementation plan and must pass `pnpm verify`. Database
and end-to-end work also runs the configured integration suite. Live ingestion or evaluation runs
remain explicit, credentialed, budgeted manual steps.

## 19. Acceptance criteria

V2 is complete only when all of the following are demonstrated:

1. **Bounded control (Goals 1–2; FR-1–FR-8):** every run uses one application-owned loop, attempts
   no more than four tools, respects every configured hard cap, and stops deterministically on
   duplicate, non-progress, budget, validation, or deadline conditions.
2. **Fixed read access (Goal 2; FR-3–FR-5):** only the five enumerated read-only tools can be
   selected; strict argument and result validation occurs before dispatch or reuse; invalid or
   oversized data never reaches an adapter or model context.
3. **Useful multi-source proposal (Goals 1 and 5; FR-9):** the duplicate-invoice demo checks the
   needed synthetic records and policy, produces a schema-valid pending refund-review proposal,
   and cites only evidence retrieved during that run.
4. **Focused missing information (Goal 4; FR-10):** an incomplete but customer-fixable case returns
   `missing_information` with expected safe field codes and at most three questions, without a
   pending action or invented facts.
5. **Safe abstention and failures (Goal 4; FR-8 and FR-18):** contradictory or unsupported evidence
   yields `needs_human_review`; source or provider outage yields the correct controlled error; the
   UI never confuses these states.
6. **Human-controlled mutation (Goal 5; FR-11):** no investigation tool can mutate state, ticket or
   tool instructions cannot confirm an action, and repeated or concurrent explicit confirmations
   create and return exactly one local mock result.
7. **Inspectable experience (Goal 3; FR-14–FR-15):** the UI shows an ordered accessible timeline
   and loads exact display-safe evidence only for the owning signed session, while cross-session and
   unknown identifiers receive the same non-revealing response.
8. **Privacy (Goal 3; FR-13 and FR-16):** database records, logs, traces, API errors, evaluation
   history, and reports contain no raw ticket, full prompt, hidden reasoning, raw provider response,
   raw tool payload, secret, or unrelated record.
9. **Trajectory evaluation (Goals 6–7; FR-17):** the CLI and local console grade tool choice,
   argument validity, required and forbidden calls, evidence, efficiency, grounding, termination,
   budgets, actions, latency, and tokens over the versioned V2 dataset, and compatible comparisons
   expose all relevant version drift.
10. **Observable execution (Goal 7; FR-16):** a configured synthetic trace shows distinct nested
    generation and tool/retrieval steps with model, token, latency, status, and budget metadata; a
    fetched-trace audit confirms both structure and prohibited-data absence.
11. **Security regression coverage (all goals; Section 12):** deterministic tests cover injection,
    spoofed tools, unknown keys, enumeration, forged citations, cross-session access, budget bypass,
    duplicate execution, and confirmation bypass.
12. **Measured release (Section 4):** a documented live evaluation reports every target with
    denominators and known failures. V2 is not represented as meeting a target that has not been
    measured or that currently fails.

## 20. Explicit future possibilities

The following ideas may be considered only in a future approved product document and are not part
of the V2 MVP:

- A follow-up conversation that resumes an investigation with newly supplied information.
- Additional read-only synthetic tools or real read-only help-desk integrations.
- Hybrid retrieval, reranking, or a dedicated retrieval planner.
- Human annotations or feedback promoted into evaluation candidates after review.
- Online quality monitoring or production evaluators.
- Parallel tool execution.
- Longer-running asynchronous investigations.
- Any real mutation integration.
- Multiple specialized agents or delegated workflows.

None of these possibilities relaxes the requirements for explicit authorization, bounded access,
grounding, privacy, evaluation, or human confirmation.
