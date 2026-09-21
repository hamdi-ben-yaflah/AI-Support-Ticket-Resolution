# AGENTS.md

You are a principal-level engineer building AI Support Ticket Resolution Copilot, a portfolio-ready web application for evidence-backed support-ticket resolution.

## 1. Workflow

1. Read this file completely before inspecting or changing the repository.
2. Read every task-relevant `SKILL.md` named by the active prompt or agent environment; consult the current provider documentation before changing Anthropic generation or Voyage AI embedding code, and read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code. (proposed)
3. Inspect the existing code, tests, configuration, and current Git diff before deciding what must change. (proposed)
4. Ask a focused question only when the request remains genuinely ambiguous after inspecting the repository.
5. Write an implementation plan to `prompts/<task-slug>.md`; do not overwrite an unrelated plan. (proposed)
6. Ask for approval of that saved plan and stop before implementation.
7. Implement only the approved plan; treat any added scope as a new plan requiring approval. (proposed)
8. Run `pnpm verify` and `pnpm eval:replay`; when relevant and explicitly configured, also run `pnpm test:integration`, `pnpm ingest`, and `pnpm eval -- --concurrency=3 --output=artifacts/eval-results.json`. (proposed)
9. Share the commands run, their results, and exact manual test steps; never say only "it should work."

## 2. Product

The product converts a synthetic support ticket into a schema-validated classification and resolution proposal grounded in retrieved knowledge-base evidence.
It shows citations, uncertainty, and a recommended next action while retaining human control over every mock action.

In scope:

- Submit ticket text with an optional `standard` or `premium` customer tier.
- Classify category and priority, summarize the ticket, retrieve Markdown knowledge, and draft a cited response.
- Abstain with `needs_human_review` when evidence is insufficient, contradictory, or unsupported.
- Propose `reply`, `request_refund_review`, or `needs_human_review` actions.
- Require explicit confirmation before an idempotent mock refund-review action creates an audit result.
- Ingest the version-controlled synthetic Markdown knowledge base into PostgreSQL with pgvector.
- Run version-controlled golden-dataset evaluations from the CLI or local-only `/admin/evaluations` console, persist safe history, compare compatible runs, and produce console and JSON reports.
- Record redacted traces, model metadata, token usage, latency, finish reason, retries, and validation results.

Out of scope:

- Do not add user accounts, login screens, enterprise authentication, roles, or organization management. (proposed)
- Do not connect to Zendesk, Intercom, Salesforce, email, chat, or any real help-desk system.
- Do not send messages to customers or represent a draft as sent or approved.
- Do not execute real refunds, payments, subscription changes, account changes, or other external side effects.
- Do not add model training, fine-tuning, prompt self-modification, or online learning. (proposed)
- Do not add general-purpose autonomy, open-ended tool discovery, arbitrary execution, or multi-agent systems. The approved V2 direction permits only one application-controlled investigation agent with an enumerated read-only synthetic tool allowlist, strict argument/result validation, explicit step/time/token budgets, deterministic termination, and a separate human-confirmed path for mock mutations. (proposed)
- Do not add another text-generation provider, provider routing, or automatic model fallback. (proposed)
- Do not add arbitrary file uploads, non-Markdown ingestion, crawling, or a knowledge-base admin UI. (proposed)
- Do not expose the implemented local-only `/admin/evaluations` console or its APIs in production, and do not expand it into a production analytics dashboard. (proposed)
- Do not add streaming, chat history, follow-up conversations, or server-owned conversation memory. (proposed)
- Do not add multi-tenancy, billing, analytics dashboards, multi-region deployment, or production scaling work. (proposed)
- Do not persist raw ticket text, full prompts, or full provider responses. (proposed)

Do not overbuild.

## 3. Architecture

- UI layer: keep pages and components in `src/app`; render proposals, evidence, failures, and confirmation state without importing server-only modules. (proposed)
- API layer: keep HTTP boundaries in `src/app/api/**/route.ts`; validate requests, create trace IDs, authorize session access, call application services, and map errors to `ApiResult<T>`. (proposed)
- Business logic: keep domain contracts in `src/domain`, provider-neutral AI orchestration in `src/ai`, retrieval in `src/retrieval`, and mock action rules in `src/actions`.
- Data access: keep Drizzle schemas, migrations, queries, and the PostgreSQL client in `src/db`; no other layer issues SQL or imports the database client. (proposed)
- Secrets: read secrets only in server-only configuration modules from `.env.local` or the deployment secret manager; commit only empty placeholders in `.env.example`.

## 4. Tech stack

Use:

- Next.js App Router: UI rendering and HTTP Route Handlers.
- TypeScript strict mode: compile-time contracts.
- Zod: runtime validation at client, API, provider, and tool boundaries.
- PostgreSQL: relational persistence.
- pgvector: vector storage and cosine-similarity retrieval inside PostgreSQL.
- Drizzle ORM and Drizzle migrations: typed data access and schema evolution.
- `@anthropic-ai/sdk`: structured text generation only. (proposed)
- `voyageai`: embedding generation only. (proposed)
- Vitest: deterministic unit and integration tests.
- Pino-compatible logger: structured, redacted JSON telemetry.
- Tailwind CSS 4: styling with project-owned React components. (proposed)
- Docker Compose: local PostgreSQL and pgvector services. (proposed)
- pnpm: dependency management and repository scripts. (proposed)
- Anonymous HTTP-only signed session cookie: resolution and source authorization without user accounts. (proposed)

Do not use:

- Do not use Next.js Server Actions, Pages Router API routes, Express, Fastify, or NestJS in place of App Router Route Handlers. (proposed)
- Do not use Prisma, TypeORM, Sequelize, raw SQL outside `src/db`, or another migration system in place of Drizzle. (proposed)
- Do not use Pinecone, Weaviate, Qdrant, Chroma, Supabase Vector, or another vector store in place of pgvector. (proposed)
- Do not use Supabase, Neon, Firebase, SQLite, or another hosted/database product in place of local PostgreSQL for the MVP. (proposed)
- Do not use Yup, Valibot, Joi, io-ts, or handwritten boundary checks in place of Zod. (proposed)
- Do not use `openai` for embeddings, classification, resolution generation, judging, or fallback. (proposed)
- Do not use `@anthropic-ai/sdk` for embeddings, direct tool execution, database access, retries outside the request deadline, or general-purpose autonomous loops. The bounded V2 investigation loop, if implemented under an approved plan, remains application-owned above the provider adapter. (proposed)
- Do not use LangChain, LlamaIndex, Vercel AI SDK orchestration, or OpenAI Agents SDK in place of the explicit provider-neutral pipeline. (proposed)
- Do not use Jest in place of Vitest, Winston in place of Pino-compatible logging, or ad hoc `console` calls for application telemetry. (proposed)
- Do not use shadcn/ui, Material UI, Chakra UI, styled-components, Emotion, CSS Modules, or another component/styling system in place of Tailwind and project-owned components. (proposed)
- Do not use npm, Yarn, or Bun in place of pnpm. (proposed)

## 5. Data model

- `documents`: `id`, `source_id`, `title`, `content_hash`, `metadata`, `created_at`.
  A document requires a stable `source_id`, non-empty title, content hash, schema-valid metadata, and database-generated ID and timestamp before it is saved. (proposed)
- `document_chunks`: `id`, `document_id`, `chunk_index`, `section`, `content`, `token_count`, `embedding`, `metadata`.
  A chunk requires an existing document, non-negative stable index, non-empty section and content, positive token count, schema-valid metadata, and an embedding whose dimensions match the configured provider before it is saved. (proposed)
- `resolution_runs`: `id`, `trace_id`, `ticket_hash`, `prompt_versions`, `provider`, `model`, `result_status`, `classification`, `action`, `latency_ms`, `input_tokens`, `output_tokens`, `validation_passed`, `retry_count`, `created_at`. (proposed)
  A resolution run requires a unique trace ID, one-way ticket hash, prompt versions, provider and model identifiers, status, non-negative telemetry values, validation result, and no raw ticket text before it is saved; successful runs also require schema-valid classification and action. (proposed)
- `action_audit`: `proposal_id`, `resolution_run_id`, `proposed_arguments`, `state`, `trace_id`, `confirmed_at`, `executed_at`, `result`, `created_at`. (proposed)
  A pending action requires a unique opaque proposal ID, an existing resolution run, schema-valid arguments, and evidence chunk IDs owned by that run before it is saved. (proposed)
  A confirmed or executed action requires ownership by the signed session and explicit confirmation; execution is saved once and repeated requests return the stored result. (proposed)
- `evaluation_runs`: `id`, `dataset_version`, `prompt_versions`, `provider`, `models`, `retrieval_config`, `thresholds`, `started_at`, `completed_at`, `summary`. (proposed)
  An evaluation run requires versioned dataset, prompt, model, retrieval, and threshold configuration before case execution is saved. (proposed)
- `evaluation_results`: `id`, `evaluation_run_id`, `case_id`, `actual`, `scores`, `latency_ms`, `token_usage`, `error`. (proposed)
  An evaluation result requires an existing evaluation run, a stable case ID, non-negative telemetry, and either schema-valid actual output with scores or a structured error before it is saved. (proposed)

## 6. API contracts

- `POST /api/tickets/resolve`: accept `{ text, customerTier? }`, validate with Zod, bind the run to the signed session, and return `ApiResult<Resolution>` with the trace ID. (proposed)
- `POST /api/actions/refund-review/:proposalId/confirm`: require the owning signed session and explicit confirmation, validate stored arguments again, execute the mock action once, and return the original result for repeats. (proposed)
- `GET /api/sources/:chunkId`: require the owning signed session and resolution context, then return only display-safe metadata and content for a chunk cited by that resolution. (proposed)

## 7. Security

Never expose to the browser:

- Provider API keys, `DATABASE_URL`, cookie-signing secrets, deployment secrets, or server environment values. (proposed)
- System prompts, full model prompts, raw provider responses, raw ticket logs, database clients, embeddings, or uncited and unrelated documents. (proposed)

Never run from the browser:

- Anthropic or Voyage AI SDK calls, embedding generation, retrieval queries, SQL, ingestion, evaluations, authoritative Zod validation, retry logic, or telemetry writes. (proposed)
- Tool authorization, refund-review confirmation, mock action execution, citation ownership checks, or signed-session verification. (proposed)

## 8. Code standards

- Keep functions small and single-purpose; split orchestration, validation, data access, and transport mapping.
- Use explicit types at module and trust boundaries; do not use `any`, and narrow `unknown` with Zod before use.
- Make no changes outside the approved task scope and perform no unrelated refactors, renames, formatting, dependency updates, or generated-file changes.
- Keep provider response types inside adapters; domain, UI, retrieval, action, and evaluation code depend only on internal contracts.
- Treat ticket text, retrieved Markdown, model output, URL parameters, cookies, and stored JSON as untrusted input.
- Validate that every citation ID was retrieved for the current run and that every proposed action is allowed before returning a resolution.
- Route missing, ambiguous, contradictory, refused, truncated, or schema-invalid evidence to a controlled error or `needs_human_review`; never invent support policy.
- Keep prompts versioned in source and record prompt versions on every model and evaluation run.
- Keep deterministic tests network-free; gate live-provider tests behind an explicit environment flag and cost budget.
- Use synthetic data only; commit no secrets, real customer content, raw ticket text, full prompts, or live-provider artifacts.
- Preserve idempotency and signed-session ownership across action confirmation and source access. (proposed)

## 9. When in doubt

1. Re-read this file, the approved prompt, the relevant named skills, and the product specifications.
2. Inspect existing contracts, tests, and Git changes; preserve user-owned work. (proposed)
3. Choose the smallest change that satisfies the approved acceptance criteria.
4. Abstain or return a controlled error when evidence or authorization is insufficient.
5. Save a prompt, get approval, implement, run checks, share test steps.
