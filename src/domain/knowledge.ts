import { z } from "zod";

import { CATEGORIES } from "@/domain/classification";

const StableSourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a stable kebab-case source ID.");

export const KnowledgeDocumentFrontMatterSchema = z.object({
  sourceId: StableSourceIdSchema,
  title: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  version: z.string().trim().min(1).max(40),
});

export const DocumentMetadataSchema = KnowledgeDocumentFrontMatterSchema.pick({
  category: true,
  version: true,
});

export const ChunkMetadataSchema = KnowledgeDocumentFrontMatterSchema.pick({
  sourceId: true,
  category: true,
  version: true,
});

export const KnowledgeChunkInspectionSchema = z
  .object({
    chunkId: z.string().uuid(),
    sourceId: StableSourceIdSchema,
    title: KnowledgeDocumentFrontMatterSchema.shape.title,
    category: DocumentMetadataSchema.shape.category,
    version: DocumentMetadataSchema.shape.version,
    chunkIndex: z.number().int().nonnegative(),
    section: z.string().trim().min(1).max(300),
    tokenCount: z.number().int().positive(),
    content: z.string().trim().min(1),
  })
  .strict();

export type KnowledgeDocumentFrontMatter = z.infer<
  typeof KnowledgeDocumentFrontMatterSchema
>;
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type ChunkMetadata = z.infer<typeof ChunkMetadataSchema>;
export type KnowledgeChunkInspection = z.infer<
  typeof KnowledgeChunkInspectionSchema
>;
