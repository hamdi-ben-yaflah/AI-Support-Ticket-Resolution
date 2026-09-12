import { z } from "zod";

import { KnowledgeChunkInspectionSchema } from "@/domain/knowledge";

export function formatKnowledgeChunkInspection(
  value: unknown,
): string {
  const chunk = KnowledgeChunkInspectionSchema.parse(value);
  return JSON.stringify({ event: "knowledge_chunk", ...chunk });
}

export function formatKnowledgeChunkInspectionSummary(count: number): string {
  const chunks = z.number().int().nonnegative().parse(count);
  return JSON.stringify({ event: "chunk_inspection_completed", chunks });
}
