import "server-only";

import { LlmError, isLlmError } from "@/ai/errors";
import {
  buildClassificationInput,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
} from "@/ai/prompts/classify.v1";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { GenerateRequest, LlmProvider } from "@/ai/types";
import { getAiConfig } from "@/config/ai";
import {
  ClassificationSchema,
  type Classification,
} from "@/domain/classification";
import type { TicketInput } from "@/domain/ticket";
import { createLogger, logger, type AppLogger } from "@/observability/logger";

export type ClassificationContext = {
  traceId: string;
};

type ClassifyTicketOptions = ClassificationContext & {
  provider: LlmProvider;
  log?: AppLogger;
};

export type ClassificationExecution = {
  classification: Classification;
  metadata: {
    provider: string;
    model: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    retryCount: number;
  };
};

export function createClassificationRequest(
  input: TicketInput,
  traceId: string,
): GenerateRequest<Classification> {
  return {
    task: "classification",
    system: CLASSIFICATION_SYSTEM_PROMPT,
    input: buildClassificationInput(input),
    outputSchema: ClassificationSchema,
    maxOutputTokens: 300,
    temperature: 0,
    metadata: {
      traceId,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
    },
  };
}

export async function classifyTicket(
  input: TicketInput,
  options: ClassifyTicketOptions,
): Promise<Classification> {
  const execution = await classifyTicketWithMetadata(input, options);
  return execution.classification;
}

export async function classifyTicketWithMetadata(
  input: TicketInput,
  options: ClassifyTicketOptions,
): Promise<ClassificationExecution> {
  const log = options.log ?? logger;
  const startedAt = Date.now();

  try {
    const result = await options.provider.generateStructured(
      createClassificationRequest(input, options.traceId),
    );
    const classification = ClassificationSchema.safeParse(result.value);
    if (!classification.success) {
      throw new LlmError("invalid_output", "The model returned an invalid classification.", {
        retryable: false,
        retryCount: result.retryCount,
        finishReason: result.finishReason,
      });
    }

    log.info({
      event: "model_call",
      traceId: options.traceId,
      task: "classification",
      provider: options.provider.name,
      model: result.model,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      providerRequestId: result.providerRequestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
      validationPassed: true,
      retryCount: result.retryCount,
    });

    return {
      classification: classification.data,
      metadata: {
        provider: options.provider.name,
        model: result.model,
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        retryCount: result.retryCount,
      },
    };
  } catch (error) {
    const llmError = isLlmError(error)
      ? error
      : new LlmError("unexpected", "Classification failed.", {
          retryable: false,
          cause: error,
        });

    log.error({
      event: "model_call",
      traceId: options.traceId,
      task: "classification",
      provider: options.provider.name,
      model: options.provider.model,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      finishReason: llmError.finishReason ?? llmError.code,
      validationPassed: false,
      retryCount: llmError.retryCount,
    });

    throw llmError;
  }
}

export async function classifyTicketWithConfiguredProvider(
  input: TicketInput,
  context: ClassificationContext,
): Promise<Classification> {
  let config;
  try {
    config = getAiConfig();
  } catch (error) {
    throw new LlmError("configuration", "AI configuration is invalid.", {
      retryable: false,
      cause: error,
    });
  }

  const provider = new AnthropicLlmProvider({
    apiKey: config.anthropicApiKey,
    model: config.model,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });

  return classifyTicket(input, {
    ...context,
    provider,
    log: createLogger(config.logLevel),
  });
}
