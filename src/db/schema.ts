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
import type { PromptVersions, ResolutionAction } from "@/domain/resolution-run";

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
    unique("document_chunks_document_index_unique").on(
      table.documentId,
      table.chunkIndex,
    ),
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
    promptVersions: jsonb("prompt_versions")
      .$type<PromptVersions>()
      .notNull(),
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
    unique("resolution_run_sources_run_chunk_unique").on(
      table.resolutionRunId,
      table.chunkId,
    ),
    index("resolution_run_sources_chunk_idx").on(table.chunkId),
    check("resolution_run_sources_position_nonnegative", sql`${table.citationPosition} >= 0`),
    check("resolution_run_sources_source_id_nonempty", sql`length(trim(${table.sourceId})) > 0`),
    check("resolution_run_sources_title_nonempty", sql`length(trim(${table.title})) > 0`),
    check("resolution_run_sources_section_nonempty", sql`length(trim(${table.section})) > 0`),
    check("resolution_run_sources_content_nonempty", sql`length(trim(${table.content})) > 0`),
  ],
);
