import "server-only";

import { z } from "zod";

export const EMBEDDING_DIMENSIONS = 1_024 as const;

const EmbeddingConfigSchema = z.object({
  VOYAGE_API_KEY: z.string().trim().min(1),
  EMBEDDING_MODEL: z.string().trim().min(1).default("voyage-4"),
  EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .refine((value) => value === EMBEDDING_DIMENSIONS)
    .default(EMBEDDING_DIMENSIONS),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(2_048).default(64),
  EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(20_000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
});

export type EmbeddingConfig = {
  apiKey: string;
  model: string;
  dimensions: typeof EMBEDDING_DIMENSIONS;
  batchSize: number;
  requestTimeoutMs: number;
  maxRetries: number;
};

export function getEmbeddingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig {
  const parsed = EmbeddingConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Embedding configuration is invalid or incomplete.");
  }

  return {
    apiKey: parsed.data.VOYAGE_API_KEY,
    model: parsed.data.EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    batchSize: parsed.data.EMBEDDING_BATCH_SIZE,
    requestTimeoutMs: parsed.data.EMBEDDING_REQUEST_TIMEOUT_MS,
    maxRetries: parsed.data.EMBEDDING_MAX_RETRIES,
  };
}
