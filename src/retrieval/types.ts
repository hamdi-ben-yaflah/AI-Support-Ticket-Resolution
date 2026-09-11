import { z } from "zod";

import { ChunkMetadataSchema } from "@/domain/knowledge";

export const RetrievedEvidenceSchema = z.object({
  chunkId: z.string().uuid(),
  sourceId: z.string().trim().min(1),
  section: z.string().trim().min(1),
  content: z.string().trim().min(1),
  tokenCount: z.number().int().positive(),
  similarity: z.number().finite().min(-1).max(1),
});

export const RetrievalCandidateSchema = RetrievedEvidenceSchema.omit({
  sourceId: true,
}).extend({
  metadata: ChunkMetadataSchema,
});

export type RetrievedEvidence = z.infer<typeof RetrievedEvidenceSchema>;
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>;

export interface EvidenceRetriever {
  retrieve(input: {
    text: string;
    category: string;
    traceId: string;
  }): Promise<RetrievedEvidence[]>;
}
