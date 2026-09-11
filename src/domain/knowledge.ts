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

export type KnowledgeDocumentFrontMatter = z.infer<
  typeof KnowledgeDocumentFrontMatterSchema
>;
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type ChunkMetadata = z.infer<typeof ChunkMetadataSchema>;
