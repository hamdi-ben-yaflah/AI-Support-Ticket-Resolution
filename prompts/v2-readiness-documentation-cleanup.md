# Plan: V2 readiness documentation cleanup

## Objective

Align the repository's governing and operator-facing documentation with the V1 implementation that is currently on `main`, remove stale contradictions before the approved V2 PRD is authored, and make the unresolved live-evaluation baseline explicit without changing runtime behavior or tuning quality.

## Current state

- The current `main` revision passes deterministic quality, PostgreSQL integration, container, security, publication, deployment, and production smoke workflows.
- Local `pnpm run ci` passes formatting, linting, type checking, migration consistency, 190 deterministic tests with coverage, operational asset generation, and the production build.
- `pnpm ci` is a pnpm built-in clean-install command and does not invoke the package script currently named `ci`.
- `AGENTS.md` still names OpenAI as the embedding provider, excludes the implemented local evaluation console, and prohibits every agent loop even though the approved V2 direction is a bounded application-controlled investigation loop.
- The V1 PRD and technical specification remain labeled `Draft 1.0` despite the implemented V1 stories, and the technical specification contains at least one stale npm command and outdated source-layout references.
- The metadata-only Langfuse implementation plan exists as an untracked file even though the corresponding implementation is committed.
- The latest completed live evaluation is a regression rather than a passing V1 quality baseline. It must be documented honestly; retrieval or prompt tuning is outside this cleanup.

## Scope

### 1. Reconcile `AGENTS.md` with the implemented product and approved V2 direction

- Replace the stale OpenAI embedding requirement with the implemented Voyage AI embedding boundary and keep Anthropic as the only text-generation and judging provider.
- Describe the implemented local-only `/admin/evaluations` console and its production-disabled boundary instead of excluding every evaluation UI.
- Preserve the prohibition on general-purpose autonomy, open-ended tool discovery, arbitrary execution, real side effects, and multi-agent systems.
- Add a narrow V2 exception for the approved single bounded investigation agent: application-owned read-only synthetic tool allowlist, strict validation, explicit budgets, deterministic termination, and separate human confirmation for mock mutations.
- Keep the existing architecture, privacy, session ownership, provider-neutral orchestration, and no-raw-content rules intact.

### 2. Mark and reconcile the V1 product documents

- Update `docs/ai-support-copilot-prd.md` and `docs/ai-support-copilot-technical-spec.md` from draft language to an implemented V1 historical baseline without rewriting their original product intent.
- Correct factual drift against the current repository, including provider names, source-layout examples, pnpm commands, the implemented evaluation console/history/comparison surface, persisted evaluation records, deployment boundaries, and metadata-only OpenTelemetry/Langfuse observability.
- Clearly separate implemented V1 behavior from future V2 investigation-agent behavior so the approved V2 PRD can supersede only the intentionally changed constraints.
- Do not claim that V1 quality thresholds pass; distinguish feature completion from the current measured quality regression.

### 3. Reconcile README status and commands

- Replace the stale 2026-09-12 “latest” evaluation section with the newest available 2026-09-17 workflow result, including its revision, pass/fail metrics, known limitations, and the fact that a current-HEAD rerun is still required.
- Preserve sanitized reporting and do not copy ticket text, provider payloads, prompts, source content, or secrets from workflow artifacts.
- Rename the local aggregate package script from `ci` to `verify` so it cannot collide with pnpm's built-in `ci` command, and update README command references to `pnpm verify`.
- Keep GitHub Actions unchanged because the pipeline already invokes each check explicitly.

### 4. Preserve planning history and prepare the approved V2 PRD task

- Retain `prompts/ai-model-observability-langfuse.md` as the implementation plan corresponding to the committed observability work; make only factual wording corrections if required by the implemented code.
- Retain the approved `prompts/v2-bounded-ticket-investigation-agent-prd.md` unchanged except for a narrowly necessary reference to the reconciled V1 baseline, if one is needed after the documentation audit.
- Do not author `docs/ai-support-copilot-prd-v2.md` in this cleanup. That remains the next task under its already-approved plan.

## Out of scope

- No application code, prompts, provider adapters, retrieval configuration, thresholds, schemas, migrations, APIs, UI behavior, deployment workflows, or dependencies.
- No live-provider calls, paid evaluation rerun, retrieval tuning, prompt tuning, model changes, or attempt to make the V1 evaluation pass.
- No Langfuse instrumentation changes or claims of a live-trace audit that has not been performed.
- No V2 PRD authoring or V2 implementation.

## Verification

1. Review the final diff and confirm every changed statement is supported by the current code, tests, configuration, or recorded workflow result.
2. Run `pnpm exec prettier --check AGENTS.md README.md docs/ai-support-copilot-prd.md docs/ai-support-copilot-technical-spec.md prompts/ai-model-observability-langfuse.md prompts/v2-bounded-ticket-investigation-agent-prd.md prompts/v2-readiness-documentation-cleanup.md`.
3. Run `pnpm verify` after renaming the aggregate script and confirm formatting, linting, type checking, migration consistency, deterministic tests/coverage, operational generation, and the production build pass.
4. Confirm `git status --short` contains only the approved cleanup files and the already-approved V2 planning file.
5. Report that local database integration, ingestion, live evaluation, and live Langfuse trace verification were not rerun unless their isolated credentials and explicit cost-bearing prerequisites are available; cite the existing green main CI/integration run and the latest failed live-evaluation run instead.

## Acceptance criteria

1. A new contributor can read `AGENTS.md`, the V1 PRD, the technical specification, and README without encountering contradictions about the embedding provider, evaluation UI, observability implementation, or bounded V2 agent direction.
2. V1 is identified as the implemented historical product baseline while its latest live quality regression remains visible and is not represented as passing.
3. `pnpm verify` is the documented, non-colliding aggregate local verification command.
4. The implemented Langfuse work has a tracked plan, and no documentation claims that raw ticket/prompt/output/source content is exported.
5. The cleanup does not change runtime behavior and leaves the approved V2 PRD task ready to begin next.
