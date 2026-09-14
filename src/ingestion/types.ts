import { z } from "zod";

import {
  ChunkMetadataSchema,
  DocumentMetadataSchema,
  KnowledgeDocumentFrontMatterSchema,
} from "@/domain/knowledge";

export const ParsedChunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  section: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1),
  tokenCount: z.number().int().positive(),
  metadata: ChunkMetadataSchema,
});

export const ParsedKnowledgeDocumentSchema = z.object({
  sourcePath: z.string().min(1),
  sourceId: KnowledgeDocumentFrontMatterSchema.shape.sourceId,
  title: KnowledgeDocumentFrontMatterSchema.shape.title,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: DocumentMetadataSchema,
  chunks: z.array(ParsedChunkSchema).min(1),
});

export type ParsedChunk = z.infer<typeof ParsedChunkSchema>;
export type ParsedKnowledgeDocument = z.infer<typeof ParsedKnowledgeDocumentSchema>;
