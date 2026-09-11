import "server-only";

import { z } from "zod";

const RetrievalConfigSchema = z
  .object({
    RETRIEVAL_CANDIDATE_COUNT: z.coerce.number().int().min(1).max(50).default(8),
    RETRIEVAL_FINAL_COUNT: z.coerce.number().int().min(1).max(8).default(5),
    RETRIEVAL_MINIMUM_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.68),
    RETRIEVAL_MAXIMUM_CONTEXT_TOKENS: z.coerce
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(3_500),
    RETRIEVAL_MINIMUM_EVIDENCE_COUNT: z.coerce.number().int().min(1).max(8).default(1),
  })
  .refine((value) => value.RETRIEVAL_FINAL_COUNT <= value.RETRIEVAL_CANDIDATE_COUNT, {
    message: "Final retrieval count cannot exceed candidate count.",
  });

export type RetrievalConfig = {
  candidateCount: number;
  finalCount: number;
  minimumSimilarity: number;
  maximumContextTokens: number;
  minimumEvidenceCount: number;
  version: "retrieval.v1";
};

export function getRetrievalConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RetrievalConfig {
  const parsed = RetrievalConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Retrieval configuration is invalid.");
  }

  return {
    candidateCount: parsed.data.RETRIEVAL_CANDIDATE_COUNT,
    finalCount: parsed.data.RETRIEVAL_FINAL_COUNT,
    minimumSimilarity: parsed.data.RETRIEVAL_MINIMUM_SIMILARITY,
    maximumContextTokens: parsed.data.RETRIEVAL_MAXIMUM_CONTEXT_TOKENS,
    minimumEvidenceCount: parsed.data.RETRIEVAL_MINIMUM_EVIDENCE_COUNT,
    version: "retrieval.v1",
  };
}
