# Product Requirements Document: AI Support Ticket Resolution Copilot

**Status:** Implemented V1 historical baseline
**Product type:** Portfolio-ready web application  
**Primary implementation language:** TypeScript

This document records the implemented V1 product contract. Feature completion does not imply that every quality target below currently passes: the latest live measurement is documented as a regression in the README. The approved V2 planning task may intentionally supersede only the constraints it identifies for a single bounded investigation agent.

## 1. Product summary

AI Support Ticket Resolution Copilot helps a support agent understand and respond to an incoming customer ticket. It classifies the ticket, retrieves relevant knowledge-base content, drafts an evidence-backed response with citations, and recommends a next action. Low-confidence or unsupported cases are sent for human review.

This project demonstrates production-oriented AI application engineering: structured model outputs, retrieval-augmented generation (RAG), controlled mock-action proposals, validation, evaluation, observability, and failure handling.

## 2. Problem

Support agents spend time repeatedly:

- Identifying a ticket's category and urgency.
- Searching documentation for the correct policy or procedure.
- Drafting a response consistent with that documentation.
- Deciding whether the ticket requires an operational action or escalation.

Simple chatbots can generate fluent answers but may invent policies, omit evidence, or behave inconsistently. The product must optimize for grounded, inspectable recommendations rather than autonomous behavior.

## 3. Goal

Build a small application that converts a support ticket into a validated resolution proposal backed by retrieved evidence.

### Success criteria for the MVP

- At least 90% category accuracy on the included golden evaluation dataset.
- 100% of successful model responses conform to the application schema.
- At least 85% citation-support score on answerable evaluation cases.
- Unsupported questions explicitly return `needs_human_review` rather than inventing an answer.
- P95 end-to-end latency is measured and reported; initial target is under 8 seconds in the documented test environment.
- Every model call records model, prompt version, latency, token usage, finish reason, and validation result.

These are project targets, not service-level guarantees.

They are also quality gates rather than a claim about the current model/retrieval baseline. V1 feature scope is implemented, but the newest live evaluation remains below several configured thresholds.

## 4. Non-goals

The MVP will not:

- Connect or replace human support agents.
- Send messages to real customers.
- Execute real refunds, payments, or account changes.
- Train or fine-tune a model.
- Build a general-purpose autonomous agent.
- Support arbitrary file formats or production-scale document ingestion.
- Provide enterprise authentication, billing, or multi-region deployment.

A separately approved V2 product-definition task may introduce one application-controlled, budget-bounded investigation agent over an enumerated set of read-only synthetic tools. General-purpose autonomy, dynamic tool discovery, arbitrary execution, multi-agent systems, and unconfirmed mutations remain out of scope.

## 5. Users

### Primary user: support agent

Needs a fast, evidence-backed recommendation while retaining final control.

### Secondary user: AI application engineer

Needs to inspect retrieval results, model decisions, evaluation scores, latency, and cost indicators.

## 6. Core user stories

1. As a support agent, I can submit a ticket and receive its category, priority, and concise summary.
2. As a support agent, I can see a proposed reply grounded in the supplied knowledge base.
3. As a support agent, I can inspect the exact sources used to produce the proposal.
4. As a support agent, I am warned when the available evidence is insufficient.
5. As a support agent, I can approve or reject a proposed mock action.
6. As an engineer, I can ingest the sample knowledge base and inspect the created chunks.
7. As an engineer, I can run a repeatable evaluation suite from the command line.
8. As an engineer, I can inspect persisted safe evaluation history and compare compatible runs by prompt and model version from a local-only console.

## 7. MVP experience

### 7.1 Ticket submission

The user enters ticket text and optionally a customer tier. Example:

> I upgraded yesterday, but I was charged for both plans.

The interface prevents empty submissions and displays processing state.

### 7.2 Resolution proposal

The application returns:

- Category: `billing`, `technical`, `account`, or `other`.
- Priority: `low`, `medium`, or `high`.
- Summary.
- Draft response.
- Confidence value and explanation.
- Supporting citations.
- Recommended action: `reply`, `request_refund_review`, or `needs_human_review`.

### 7.3 Evidence inspection

Each citation shows the document title, section, and supporting excerpt. The UI distinguishes retrieved evidence from generated text.

### 7.4 Action confirmation

For `request_refund_review`, the application displays the proposed tool arguments. The user must confirm before the mock tool is executed. Execution creates a local audit record only.

### 7.5 Evaluation view

The repository provides a CLI evaluation command and a local-only `/admin/evaluations` console. The console runs evaluations, retains a safe compact history in PostgreSQL, compares compatible baseline/candidate runs, and displays:

- Classification accuracy.
- Schema-valid response rate.
- Citation-support rate.
- Appropriate abstention rate.
- Latency distribution.
- Token usage and estimated cost, when pricing configuration is available.
- Failed cases with expected and actual results.

The console and `/api/evaluations/**` routes are disabled by default in production. Complete downloadable reports exist only in the active browser tab or the requested CLI output path; persisted history excludes ticket text, generated drafts, source excerpts, prompts, vectors, credentials, and provider payloads.

## 8. Functional requirements

### FR-1: Structured classification

The system must classify every accepted ticket using a schema-validated output. Invalid model output must never be passed to downstream steps without validation.

### FR-2: Knowledge-base ingestion

The system must ingest Markdown documents, split them into identifiable chunks, generate embeddings, and store the text, source metadata, and vectors.

### FR-3: Retrieval

The system must retrieve relevant chunks using semantic search and category metadata when available. Retrieval parameters must be configurable.

### FR-4: Grounded response generation

The system must instruct the model to use only retrieved context for policy or factual claims. The response must include source identifiers for claims that depend on the knowledge base.

### FR-5: Abstention

If evidence is insufficient or contradictory, the system must return `needs_human_review` with a short explanation.

### FR-6: Controlled action proposal

The system must expose one mock action boundary, `requestRefundReview`. The model may select only the corresponding structured action; it does not dynamically select or execute a tool. The server constructs and validates the arguments, persists a session-owned pending proposal, and requires a separate explicit confirmation before idempotent mock execution.

### FR-7: Provider boundary

Application logic must use an internal model-provider interface. Provider-specific response shapes must not leak into domain or UI code.

### FR-8: Evaluations

The project must include a version-controlled golden dataset and a repeatable evaluation runner shared by the CLI and local-only console. Validated safe aggregate and compact per-case records must persist for history and compatible-run comparison. The command must exit non-zero when configured regression thresholds fail.

### FR-9: Observability

Each request must receive a trace ID. Model and retrieval steps must record structured telemetry without raw customer text. Ticket resolution may additionally export an optional, fail-open metadata-only OpenTelemetry trace to Langfuse; Pino logs and PostgreSQL remain the operational and durable systems of record.

### FR-10: Error handling

The interface must distinguish retryable provider errors, invalid requests, validation failures, timeouts, retrieval failures, and insufficient evidence.

## 9. Data requirements

The repository will contain synthetic data only:

- 8 synthetic Markdown knowledge-base documents covering billing, account access, subscriptions, refunds, incidents, and common technical issues.
- 36 versioned evaluation tickets including common cases, edge cases, prompt-injection attempts, ambiguous requests, and unanswerable questions.
- Expected categories, priorities, allowed actions, relevant source IDs, and whether the system should abstain.

No real customer data or secrets may be committed.

## 10. Safety and trust requirements

- Retrieved documents are untrusted data, not instructions.
- Tool arguments are validated server-side.
- High-impact actions require confirmation and are mocked in the MVP.
- The application must not expose hidden prompts, API keys, or unrelated documents.
- Logs should use hashes, IDs, or redacted text by default.
- The UI must label all responses as proposed drafts requiring human review.

## 11. UX requirements

- A user can reach a resolution proposal from the home screen in one submission.
- Sources are visible beside the proposed response, not hidden in a secondary workflow.
- Loading, abstention, validation failure, provider failure, and tool-confirmation states are distinct.
- The V1 interface is non-streaming and remains usable throughout its loading and terminal states.

## 12. Metrics

### Quality

- Category accuracy.
- Priority accuracy.
- Citation precision: cited chunks that support the generated claim.
- Answer completeness against the evaluation rubric.
- Abstention precision and recall.
- Action selection accuracy.

### Operational

- P50 and P95 latency.
- Input and output tokens per resolved ticket.
- Estimated cost per resolved ticket.
- Provider error and timeout rates.
- Structured-output validation failure rate.

## 13. Release plan

### Milestone 1: deterministic foundation

- Project skeleton and database.
- Ticket and resolution schemas.
- Structured classification.
- Unit tests for validation and error mapping.

### Milestone 2: grounded generation

- Markdown ingestion and chunking.
- Embeddings and vector search.
- Draft response with source citations and abstention.

### Milestone 3: controlled action

- Mock refund-review tool.
- Confirmation UI and audit record.
- Prompt-injection and authorization tests.

### Milestone 4: measurable release

- Golden dataset and evaluation runner.
- Evaluation results and failure analysis.
- Architecture diagram, setup guide, screenshots, and demonstration video.

## 14. Acceptance criteria

The V1 feature scope is complete when:

1. A fresh installation can seed the knowledge base and database using documented commands.
2. A user can submit each sample ticket and receive a schema-valid result.
3. Answerable cases cite viewable source chunks.
4. Unanswerable cases visibly abstain.
5. The mock tool cannot execute without confirmation or valid arguments.
6. The evaluation suite produces machine-readable and human-readable results.
7. The README reports measured results and known failure cases.
8. Automated tests cover schemas, chunking, retrieval filters, tool authorization, and error behavior.

The V1 product surface, safety controls, persistence, evaluation tooling, and deterministic coverage are implemented. Live-model acceptance is not fully met: the newest run includes schema failures and misses several configured quality thresholds, so the current measured regression is not represented as a passing V1 quality baseline.

## 15. Future possibilities

- Hybrid keyword and vector retrieval.
- Reranking and retrieval-quality evaluations.
- A single bounded ticket-investigation agent over validated read-only synthetic tools, as defined by an approved V2 PRD.
- Agent feedback captured as evaluation candidates after explicit review.
- Multi-tenant document isolation.
- Real help-desk integration in read-only mode.
- Conversation history with explicit server-owned state.
