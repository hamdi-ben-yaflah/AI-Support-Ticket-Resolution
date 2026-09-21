import "server-only";

import { z } from "zod";

const AiConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.string().trim().min(1),
  LLM_MODEL: z.string().trim().min(1),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  ANTHROPIC_PROMPT_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AiConfig = {
  anthropicApiKey: string;
  model: string;
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
    model: parsed.data.LLM_MODEL,
    requestTimeoutMs: parsed.data.AI_REQUEST_TIMEOUT_MS,
    maxRetries: parsed.data.AI_MAX_RETRIES,
    promptCacheEnabled: parsed.data.ANTHROPIC_PROMPT_CACHE_ENABLED,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
