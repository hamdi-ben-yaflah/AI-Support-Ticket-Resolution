import type { z } from "zod";

export type AiTask = "classification" | "resolution" | "evaluation";

export type GenerateRequest<T> = {
  task: AiTask;
  system: string;
  input: string;
  outputSchema: z.ZodType<T>;
  maxOutputTokens: number;
  temperature?: number;
  metadata: {
    traceId: string;
    promptVersion: string;
  };
};

export type GenerateResult<T> = {
  value: T;
  model: string;
  finishReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
  latencyMs: number;
  retryCount: number;
  providerRequestId?: string;
  providerMessageId?: string;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
}
