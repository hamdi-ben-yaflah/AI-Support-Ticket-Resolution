import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import type { ChunkMetadata, DocumentMetadata } from "@/domain/knowledge";

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
