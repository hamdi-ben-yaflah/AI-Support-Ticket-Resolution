import "server-only";

import { z } from "zod";

const OptionalModelSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().trim().min(1).max(200).optional(),
);

const AiConfigSchema = z
  .object({
    ANTHROPIC_API_KEY: z.string().trim().min(1),
    LLM_MODEL: OptionalModelSchema,
    LLM_MODEL_CLASSIFICATION: OptionalModelSchema,
    LLM_MODEL_RESOLUTION: OptionalModelSchema,
    LLM_MODEL_JUDGE: OptionalModelSchema,
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    ANTHROPIC_PROMPT_CACHE_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .superRefine((value, context) => {
    const unresolved = [
      value.LLM_MODEL_CLASSIFICATION ?? value.LLM_MODEL,
      value.LLM_MODEL_RESOLUTION ?? value.LLM_MODEL,
      value.LLM_MODEL_JUDGE ?? value.LLM_MODEL,
    ].some((model) => model === undefined);
    if (unresolved) {
      context.addIssue({
        code: "custom",
        path: ["LLM_MODEL"],
        message: "A model is required for every AI task.",
      });
    }
  });

export type AiConfig = {
  anthropicApiKey: string;
  models: {
    classification: string;
    resolution: string;
    judge: string;
  };
  requestTimeoutMs: number;
  maxRetries: number;
  promptCacheEnabled: boolean;
  logLevel: z.infer<typeof AiConfigSchema>["LOG_LEVEL"];
};

export function getAiConfig(environment: NodeJS.ProcessEnv = process.env): AiConfig {
  const parsed = AiConfigSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error("AI configuration is invalid or incomplete.");
  }

  return {
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    models: {
      classification: parsed.data.LLM_MODEL_CLASSIFICATION ?? parsed.data.LLM_MODEL!,
      resolution: parsed.data.LLM_MODEL_RESOLUTION ?? parsed.data.LLM_MODEL!,
      judge: parsed.data.LLM_MODEL_JUDGE ?? parsed.data.LLM_MODEL!,
    },
    requestTimeoutMs: parsed.data.AI_REQUEST_TIMEOUT_MS,
    maxRetries: parsed.data.AI_MAX_RETRIES,
    promptCacheEnabled: parsed.data.ANTHROPIC_PROMPT_CACHE_ENABLED,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
