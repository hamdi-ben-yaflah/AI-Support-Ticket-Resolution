import "server-only";

import { asc, cosineDistance, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db/client";
import { documentChunks, documents } from "@/db/schema";
import {
  ChunkMetadataSchema,
  DocumentMetadataSchema,
  KnowledgeChunkInspectionSchema,
  type KnowledgeChunkInspection,
} from "@/domain/knowledge";

const SearchRowSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  title: z.string().trim().min(1),
  section: z.string().trim().min(1),
  content: z.string().trim().min(1),
  tokenCount: z.number().int().positive(),
  metadata: ChunkMetadataSchema,
  similarity: z.number().finite().min(-1).max(1),
});

export type PersistedChunkInput = {
  id?: string;
  chunkIndex: number;
  section: string;
  content: string;
  tokenCount: number;
  embedding: number[];
  metadata: z.infer<typeof ChunkMetadataSchema>;
};

export type PersistedDocumentInput = {
  sourceId: string;
  title: string;
  contentHash: string;
  metadata: z.infer<typeof DocumentMetadataSchema>;
  chunks: PersistedChunkInput[];
};

export type KnowledgeSearchRow = z.infer<typeof SearchRowSchema>;

export async function getDocumentContentHashes(
  sourceIds: readonly string[],
): Promise<Map<string, string>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await getDatabase()
    .select({ sourceId: documents.sourceId, contentHash: documents.contentHash })
    .from(documents)
    .where(inArray(documents.sourceId, [...sourceIds]));

  return new Map(rows.map((row) => [row.sourceId, row.contentHash]));
}

export async function replaceDocument(input: PersistedDocumentInput): Promise<void> {
  const metadata = DocumentMetadataSchema.parse(input.metadata);
  const chunkValues = input.chunks.map((chunk) => ({
    ...chunk,
    metadata: ChunkMetadataSchema.parse(chunk.metadata),
  }));

  await getDatabase().transaction(async (transaction) => {
    const [document] = await transaction
      .insert(documents)
      .values({
        sourceId: input.sourceId,
        title: input.title,
        contentHash: input.contentHash,
        metadata,
      })
      .onConflictDoUpdate({
        target: documents.sourceId,
        set: {
          title: input.title,
          contentHash: input.contentHash,
          metadata,
        },
      })
      .returning({ id: documents.id });

    if (!document) throw new Error("Document upsert returned no identifier.");
    await transaction.delete(documentChunks).where(eq(documentChunks.documentId, document.id));

    if (chunkValues.length > 0) {
      await transaction.insert(documentChunks).values(
        chunkValues.map((chunk) => ({
          ...chunk,
          documentId: document.id,
        })),
      );
    }
  });
}

export async function searchDocumentChunks(input: {
  embedding: number[];
  category?: string;
  limit: number;
}): Promise<KnowledgeSearchRow[]> {
  const distance = cosineDistance(documentChunks.embedding, input.embedding);
  const similarity = sql<number>`1 - (${distance})`;
  const categoryCondition = input.category
    ? sql`${documentChunks.metadata}->>'category' = ${input.category}`
    : undefined;

  const rows = await getDatabase()
    .select({
      chunkId: documentChunks.id,
      documentId: documentChunks.documentId,
      title: documents.title,
      section: documentChunks.section,
      content: documentChunks.content,
      tokenCount: documentChunks.tokenCount,
      metadata: documentChunks.metadata,
      similarity,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(categoryCondition)
    .orderBy(distance, documentChunks.id)
    .limit(input.limit);

  return z.array(SearchRowSchema).parse(rows);
}

export async function inspectDocumentChunks(): Promise<KnowledgeChunkInspection[]> {
  const rows = await getDatabase()
    .select({
      chunkId: documentChunks.id,
      sourceId: documents.sourceId,
      title: documents.title,
      category: sql<string>`${documents.metadata}->>'category'`,
      version: sql<string>`${documents.metadata}->>'version'`,
      chunkIndex: documentChunks.chunkIndex,
      section: documentChunks.section,
      tokenCount: documentChunks.tokenCount,
      content: documentChunks.content,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .orderBy(asc(documents.sourceId), asc(documentChunks.chunkIndex));

  return z.array(KnowledgeChunkInspectionSchema).parse(rows);
}

export async function deleteDocumentsBySourceIds(sourceIds: readonly string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  await getDatabase()
    .delete(documents)
    .where(inArray(documents.sourceId, [...sourceIds]));
}
