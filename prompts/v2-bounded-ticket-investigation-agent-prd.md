# Plan: V2 bounded ticket-investigation agent PRD

## Objective

Create a new product requirements document at `docs/ai-support-copilot-prd-v2.md` for a demo-focused, bounded ticket-investigation agent. Preserve the completed V1 PRD unchanged as the historical baseline.

## Product direction

V2 will extend the existing evidence-backed resolution pipeline with a single model-directed, application-controlled investigation workflow. The agent may choose from a small allowlist of synthetic read-only tools, inspect their validated results, and either continue investigating or finish with a grounded proposal, a structured request for missing information, or human review.

The PRD will explicitly distinguish this bounded workflow from a general-purpose autonomous agent. It will retain human confirmation for every mock mutation and will not introduce real customer data, real help-desk integrations, or real external side effects.

## Planned PRD structure

1. Document status, relationship to V1, and product summary.
2. Problem statement and why the current one-shot pipeline is insufficient for multi-source cases.
3. V2 goals, non-goals, target users, and demo scenarios.
4. Core user stories for investigation visibility, evidence inspection, missing-information handling, and action approval.
5. End-to-end experience, including an investigation timeline and final proposal.
6. Functional requirements for:
   - a bounded plan/act/observe/finish loop;
   - an application-owned tool allowlist;
   - synthetic customer, invoice, subscription, service-status, and knowledge tools;
   - strict tool argument/result validation;
   - step, time, and token budgets;
   - duplicate-call and non-progress detection;
   - grounded final proposals and deterministic safety checks;
   - human confirmation for mock mutations;
   - controlled termination, abstention, and missing-information outcomes;
   - investigation-step observability and trajectory evaluation.
7. Data, API, security, privacy, reliability, and UX requirements at a product-contract level.
8. Evaluation metrics covering tool choice, argument validity, trajectory efficiency, grounding, termination, action safety, latency, and cost.
9. Version-controlled synthetic scenario requirements, including adversarial tool-output cases.
10. Incremental release milestones and complete acceptance criteria.
11. Explicit future possibilities that remain outside the V2 MVP.

## Key constraints to encode

- One specialized investigation agent; no multi-agent system.
- A maximum of four tool calls per investigation.
- Only enumerated tools can be selected; the application validates and dispatches every call.
- Read-only synthetic tools are automatically executable inside the investigation budget.
- Any mock state-changing action remains a separate, session-owned, idempotent confirmation flow.
- Tool output and retrieved content are untrusted data and cannot provide instructions.
- The agent cannot browse the web, run arbitrary code, issue SQL, access secrets, or dynamically discover tools.
- Raw ticket text, full prompts, and raw provider responses remain excluded from persistence and telemetry.
- The feature remains provider-neutral above the existing Anthropic adapter and keeps Voyage limited to embeddings.
- V2 adds no real help-desk integration, authentication product, multi-tenancy, or production scaling initiative.

## Verification

- Confirm the new PRD is internally consistent with the implemented V1 product and clearly marks which V1 limitations V2 intentionally supersedes.
- Confirm every goal is covered by at least one functional requirement and acceptance criterion.
- Confirm safety, evaluation, observability, and human-control requirements are testable rather than aspirational.
- Run `pnpm exec prettier --check docs/ai-support-copilot-prd-v2.md` after authoring.
- Review the final Git diff to ensure only the approved PRD and this plan changed.

## Deliverable

A standalone, implementation-ready V2 PRD. This task will not change application code, dependencies, database migrations, the V1 PRD, or the technical specification.
