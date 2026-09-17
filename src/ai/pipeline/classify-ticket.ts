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
import { ClassificationSchema, type Classification } from "@/domain/classification";
import type { TicketInput } from "@/domain/ticket";
import { createLogger, logger, type AppLogger } from "@/observability/logger";
import { tracing, withTraceCorrelation, type AppTracing } from "@/observability/tracing";

export type ClassificationContext = {
  traceId: string;
};

type ClassifyTicketOptions = ClassificationContext & {
  provider: LlmProvider;
  log?: AppLogger;
  tracing?: AppTracing;
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
  const appTracing = options.tracing ?? tracing;
  const startedAt = Date.now();

  return appTracing.withSpan(
    "support.ai.classification",
    {
      attributes: {
        "support.trace_id": options.traceId,
        "support.task": "classification",
        "support.prompt.version": CLASSIFICATION_PROMPT_VERSION,
        "gen_ai.provider.name": options.provider.name,
        "gen_ai.request.model": options.provider.model,
      },
    },
    async (span) => {
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
            providerRequestId: result.providerRequestId,
          });
        }

        span.setAttributes({
          "gen_ai.response.model": result.model,
          "gen_ai.usage.input_tokens": result.usage.inputTokens,
          "gen_ai.usage.output_tokens": result.usage.outputTokens,
          "support.usage.cached_input_tokens": result.usage.cachedInputTokens,
          "support.usage.cache_write_tokens": result.usage.cacheWriteInputTokens,
          "support.provider.request_id": result.providerRequestId,
          "support.provider.message_id": result.providerMessageId,
          "support.finish_reason": result.finishReason,
          "support.duration_ms": result.latencyMs,
          "support.validation.passed": true,
          "support.validation.outcome": "valid",
          "support.retry_count": result.retryCount,
          "support.category": classification.data.category,
          "support.priority": classification.data.priority,
          "support.confidence": classification.data.confidence,
          "support.outcome": "completed",
        });
        log.info(
          withTraceCorrelation(
            {
              event: "model_call",
              traceId: options.traceId,
              task: "classification",
              provider: options.provider.name,
              model: result.model,
              promptVersion: CLASSIFICATION_PROMPT_VERSION,
              providerRequestId: result.providerRequestId,
              providerMessageId: result.providerMessageId,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens,
              latencyMs: result.latencyMs,
              finishReason: result.finishReason,
              validationPassed: true,
              retryCount: result.retryCount,
            },
            appTracing,
          ),
        );

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

        span.setAttributes({
          "support.duration_ms": Math.max(0, Date.now() - startedAt),
          "support.finish_reason": llmError.finishReason ?? llmError.code,
          "support.validation.passed": false,
          "support.validation.outcome": "invalid",
          "support.retry_count": llmError.retryCount,
          "support.provider.request_id": llmError.providerRequestId,
          "support.outcome": "failed",
        });
        span.fail(llmError.code);
        log.error(
          withTraceCorrelation(
            {
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
            },
            appTracing,
          ),
        );

        throw llmError;
      }
    },
  );
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
    tracing,
  });

  return classifyTicket(input, {
    ...context,
    provider,
    log: createLogger(config.logLevel),
  });
}
