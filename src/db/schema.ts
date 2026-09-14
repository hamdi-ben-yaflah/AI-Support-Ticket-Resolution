import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import type { Classification } from "@/domain/classification";
import type { ChunkMetadata, DocumentMetadata } from "@/domain/knowledge";
import type { MockRefundReviewResult, RequestRefundReviewArgs } from "@/domain/refund-review";
import type { PromptVersions, ResolutionAction } from "@/domain/resolution-run";
import type { EvaluationCaseResult, EvaluationReport } from "@/evals/contracts";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: text("source_id").notNull().unique(),
    title: text("title").notNull(),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").$type<DocumentMetadata>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("documents_title_nonempty", sql`length(trim(${table.title})) > 0`),
    check("documents_content_hash_sha256", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    section: text("section").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 1_024 }).notNull(),
    metadata: jsonb("metadata").$type<ChunkMetadata>().notNull(),
  },
  (table) => [
    unique("document_chunks_document_index_unique").on(table.documentId, table.chunkIndex),
    check("document_chunks_index_nonnegative", sql`${table.chunkIndex} >= 0`),
    check("document_chunks_section_nonempty", sql`length(trim(${table.section})) > 0`),
    check("document_chunks_content_nonempty", sql`length(trim(${table.content})) > 0`),
    check("document_chunks_token_count_positive", sql`${table.tokenCount} > 0`),
  ],
);

export const resolutionRuns = pgTable(
  "resolution_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceId: uuid("trace_id").notNull().unique(),
    sessionHash: text("session_hash").notNull(),
    ticketHash: text("ticket_hash").notNull(),
    promptVersions: jsonb("prompt_versions").$type<PromptVersions>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    resultStatus: text("result_status").notNull(),
    classification: jsonb("classification").$type<Classification>().notNull(),
    action: jsonb("action").$type<ResolutionAction>().notNull(),
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    validationPassed: boolean("validation_passed").notNull(),
    retryCount: integer("retry_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("resolution_runs_session_created_idx").on(table.sessionHash, table.createdAt),
    check("resolution_runs_session_hash_sha256", sql`${table.sessionHash} ~ '^[a-f0-9]{64}$'`),
    check("resolution_runs_ticket_hash_sha256", sql`${table.ticketHash} ~ '^[a-f0-9]{64}$'`),
    check("resolution_runs_provider_nonempty", sql`length(trim(${table.provider})) > 0`),
    check("resolution_runs_model_nonempty", sql`length(trim(${table.model})) > 0`),
    check("resolution_runs_success", sql`${table.resultStatus} = 'success'`),
    check("resolution_runs_latency_nonnegative", sql`${table.latencyMs} >= 0`),
    check("resolution_runs_input_tokens_nonnegative", sql`${table.inputTokens} >= 0`),
    check("resolution_runs_output_tokens_nonnegative", sql`${table.outputTokens} >= 0`),
    check("resolution_runs_retry_count_nonnegative", sql`${table.retryCount} >= 0`),
    check("resolution_runs_validation_passed", sql`${table.validationPassed} = true`),
  ],
);

export const resolutionRunSources = pgTable(
  "resolution_run_sources",
  {
    resolutionRunId: uuid("resolution_run_id")
      .notNull()
      .references(() => resolutionRuns.id, { onDelete: "cascade" }),
    citationPosition: integer("citation_position").notNull(),
    chunkId: uuid("chunk_id").notNull(),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    section: text("section").notNull(),
    content: text("content").notNull(),
  },
  (table) => [
    primaryKey({
      name: "resolution_run_sources_pk",
      columns: [table.resolutionRunId, table.citationPosition],
    }),
    unique("resolution_run_sources_run_chunk_unique").on(table.resolutionRunId, table.chunkId),
    index("resolution_run_sources_chunk_idx").on(table.chunkId),
    check("resolution_run_sources_position_nonnegative", sql`${table.citationPosition} >= 0`),
    check("resolution_run_sources_source_id_nonempty", sql`length(trim(${table.sourceId})) > 0`),
    check("resolution_run_sources_title_nonempty", sql`length(trim(${table.title})) > 0`),
    check("resolution_run_sources_section_nonempty", sql`length(trim(${table.section})) > 0`),
    check("resolution_run_sources_content_nonempty", sql`length(trim(${table.content})) > 0`),
  ],
);

export const actionAudit = pgTable(
  "action_audit",
  {
    proposalId: uuid("proposal_id").primaryKey(),
    resolutionRunId: uuid("resolution_run_id")
      .notNull()
      .unique()
      .references(() => resolutionRuns.id, { onDelete: "cascade" }),
    proposedArguments: jsonb("proposed_arguments").$type<RequestRefundReviewArgs>().notNull(),
    state: text("state").notNull(),
    traceId: uuid("trace_id").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    result: jsonb("result").$type<MockRefundReviewResult>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("action_audit_resolution_run_idx").on(table.resolutionRunId),
    check("action_audit_state_valid", sql`${table.state} in ('pending_confirmation', 'executed')`),
    check(
      "action_audit_state_fields_valid",
      sql`(
        ${table.state} = 'pending_confirmation'
        and ${table.confirmedAt} is null
        and ${table.executedAt} is null
        and ${table.result} is null
      ) or (
        ${table.state} = 'executed'
        and ${table.confirmedAt} is not null
        and ${table.executedAt} is not null
        and ${table.result} is not null
      )`,
    ),
    check(
      "action_audit_execution_order_valid",
      sql`${table.executedAt} is null or ${table.confirmedAt} <= ${table.executedAt}`,
    ),
  ],
);

export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid("id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    datasetHash: text("dataset_hash").notNull(),
    datasetCaseCount: integer("dataset_case_count").notNull(),
    provider: text("provider").notNull(),
    generationModel: text("generation_model").notNull(),
    judgeModel: text("judge_model").notNull(),
    promptVersions: jsonb("prompt_versions")
      .$type<EvaluationReport["runtime"]["promptVersions"]>()
      .notNull(),
    retrievalConfig: jsonb("retrieval_config")
      .$type<EvaluationReport["runtime"]["retrieval"]>()
      .notNull(),
    resolutionPolicy: jsonb("resolution_policy")
      .$type<EvaluationReport["runtime"]["resolutionPolicy"]>()
      .notNull(),
    concurrency: integer("concurrency").notNull(),
    pricing: jsonb("pricing").$type<EvaluationReport["runtime"]["pricing"]>(),
    thresholdVersion: text("threshold_version").notNull(),
    thresholds: jsonb("thresholds").$type<EvaluationReport["thresholds"]>().notNull(),
    summary: jsonb("summary").$type<EvaluationReport["metrics"]>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_runs_completed_idx").on(table.completedAt, table.id),
    check("evaluation_runs_schema_version_nonempty", sql`length(trim(${table.schemaVersion})) > 0`),
    check("evaluation_runs_status_valid", sql`${table.status} in ('pass', 'regression')`),
    check(
      "evaluation_runs_dataset_version_nonempty",
      sql`length(trim(${table.datasetVersion})) > 0`,
    ),
    check("evaluation_runs_dataset_hash_sha256", sql`${table.datasetHash} ~ '^[a-f0-9]{64}$'`),
    check("evaluation_runs_case_count_positive", sql`${table.datasetCaseCount} > 0`),
    check("evaluation_runs_provider_nonempty", sql`length(trim(${table.provider})) > 0`),
    check(
      "evaluation_runs_generation_model_nonempty",
      sql`length(trim(${table.generationModel})) > 0`,
    ),
    check("evaluation_runs_judge_model_nonempty", sql`length(trim(${table.judgeModel})) > 0`),
    check("evaluation_runs_concurrency_positive", sql`${table.concurrency} > 0`),
    check(
      "evaluation_runs_threshold_version_nonempty",
      sql`length(trim(${table.thresholdVersion})) > 0`,
    ),
    check(
      "evaluation_runs_completed_after_started",
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const evaluationResults = pgTable(
  "evaluation_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evaluationRunId: uuid("evaluation_run_id")
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: "cascade" }),
    caseId: text("case_id").notNull(),
    tags: jsonb("tags").$type<EvaluationCaseResult["tags"]>().notNull(),
    actual: jsonb("actual").$type<EvaluationCaseResult["actual"]>(),
    scores: jsonb("scores").$type<EvaluationCaseResult["scores"]>().notNull(),
    passed: boolean("passed").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    generationInputTokens: integer("generation_input_tokens").notNull(),
    generationOutputTokens: integer("generation_output_tokens").notNull(),
    judgeInputTokens: integer("judge_input_tokens").notNull(),
    judgeOutputTokens: integer("judge_output_tokens").notNull(),
    retryCount: integer("retry_count").notNull(),
    error: jsonb("error").$type<EvaluationCaseResult["error"]>(),
  },
  (table) => [
    unique("evaluation_results_run_case_unique").on(table.evaluationRunId, table.caseId),
    index("evaluation_results_run_case_idx").on(table.evaluationRunId, table.caseId),
    check("evaluation_results_case_id_nonempty", sql`length(trim(${table.caseId})) > 0`),
    check("evaluation_results_latency_nonnegative", sql`${table.latencyMs} >= 0`),
    check(
      "evaluation_results_generation_input_nonnegative",
      sql`${table.generationInputTokens} >= 0`,
    ),
    check(
      "evaluation_results_generation_output_nonnegative",
      sql`${table.generationOutputTokens} >= 0`,
    ),
    check("evaluation_results_judge_input_nonnegative", sql`${table.judgeInputTokens} >= 0`),
    check("evaluation_results_judge_output_nonnegative", sql`${table.judgeOutputTokens} >= 0`),
    check("evaluation_results_retry_nonnegative", sql`${table.retryCount} >= 0`),
  ],
);
