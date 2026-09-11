import "server-only";

import {
  VoyageAIClient,
  VoyageAIError,
  VoyageAITimeoutError,
} from "voyageai";
import { z } from "zod";

import { EmbeddingError } from "@/embeddings/errors";
import type {
  EmbeddingProvider,
  EmbeddingRequestMetadata,
  EmbeddingResult,
} from "@/embeddings/types";
import { logger, type AppLogger } from "@/observability/logger";

const VoyageEmbeddingResponseSchema = z.object({
  model: z.string().min(1),
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()),
    }),
  ),
  usage: z.object({
    totalTokens: z.number().int().nonnegative(),
  }),
});

type Clock = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

type VoyageEmbeddingClient = Pick<VoyageAIClient, "embed">;

type VoyageEmbeddingProviderOptions = {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  maxRetries: number;
  client?: VoyageEmbeddingClient;
  clock?: Partial<Clock>;
  log?: AppLogger;
};

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

function mapVoyageError(error: unknown, retryCount: number): EmbeddingError {
  if (
    error instanceof VoyageAITimeoutError ||
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof VoyageAIError && error.statusCode === 408)
  ) {
    return new EmbeddingError("timeout", "The embedding provider timed out.", {
      retryable: true,
      retryCount,
      cause: error,
    });
  }

  if (
    error instanceof VoyageAIError &&
    (error.statusCode === undefined ||
      error.statusCode === 429 ||
      error.statusCode >= 500)
  ) {
    return new EmbeddingError(
      "unavailable",
      "The embedding provider is temporarily unavailable.",
      { retryable: true, retryCount, cause: error },
    );
  }

  if (
    error instanceof VoyageAIError &&
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return new EmbeddingError("configuration", "Embedding configuration is invalid.", {
      retryable: false,
      retryCount,
      cause: error,
    });
  }

  return new EmbeddingError("unexpected", "The embedding request failed.", {
    retryable: false,
    retryCount,
    cause: error,
  });
}

function retryDelayMs(error: unknown, retryCount: number): number {
  if (error instanceof VoyageAIError && error.statusCode === 429) {
    const retryAfter = error.rawResponse?.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(10_000, seconds * 1_000);
      }
    }
    return Math.min(10_000, 1_000 * 2 ** retryCount);
  }
  return Math.min(2_000, 250 * 2 ** retryCount);
}

function validateVectors(
  response: unknown,
  expectedCount: number,
  dimensions: number,
  retryCount: number,
): { vectors: number[][]; model: string; inputTokens: number } {
  const parsed = VoyageEmbeddingResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.data.length !== expectedCount) {
    throw new EmbeddingError("invalid_output", "Embedding response is invalid.", {
      retryable: false,
      retryCount,
    });
  }

  const ordered = [...parsed.data.data].sort((left, right) => left.index - right.index);
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (
      item.index !== index ||
      item.embedding.length !== dimensions ||
      item.embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new EmbeddingError("invalid_output", "Embedding vector is invalid.", {
        retryable: false,
        retryCount,
      });
    }
  }

  return {
    vectors: ordered.map((item) => item.embedding),
    model: parsed.data.model,
    inputTokens: parsed.data.usage.totalTokens,
  };
}

function unwrapEmbeddingResponse(response: unknown): unknown {
  // The Voyage SDK resolves to { data: EmbedResponse, rawResponse }, while
  // test doubles and local clients may return EmbedResponse directly.
  if (
    typeof response === "object" &&
    response !== null &&
    "data" in response &&
    !Array.isArray(response.data)
  ) {
    return response.data;
  }
  return response;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly model: string;
  readonly dimensions: number;
  private readonly client: VoyageEmbeddingClient;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly clock: Clock;
  private readonly log: AppLogger;

  constructor(options: VoyageEmbeddingProviderOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.client =
      options.client ??
      new VoyageAIClient({
        apiKey: options.apiKey,
        maxRetries: 0,
        timeoutInSeconds: options.timeoutMs / 1_000,
      });
    this.clock = { ...defaultClock, ...options.clock };
    this.log = options.log ?? logger;
  }

  async embed(
    texts: readonly string[],
    metadata: EmbeddingRequestMetadata,
  ): Promise<EmbeddingResult> {
    if (texts.length === 0 || texts.some((text) => text.trim().length === 0)) {
      throw new EmbeddingError("invalid_output", "Embedding input cannot be empty.", {
        retryable: false,
      });
    }

    const startedAt = this.clock.now();
    const deadline = startedAt + this.timeoutMs;
    let retryCount = 0;

    while (true) {
      const remainingMs = deadline - this.clock.now();
      if (remainingMs <= 0) {
        throw new EmbeddingError("timeout", "The embedding provider timed out.", {
          retryable: true,
          retryCount,
        });
      }

      try {
        const raw = await this.client.embed(
          {
            model: this.model,
            input: [...texts],
            inputType: metadata.inputType,
            truncation: false,
            outputDimension: this.dimensions,
            outputDtype: "float",
          },
          {
            maxRetries: 0,
            timeoutInSeconds: Math.max(0.001, remainingMs / 1_000),
          },
        );
        const validated = validateVectors(
          unwrapEmbeddingResponse(raw),
          texts.length,
          this.dimensions,
          retryCount,
        );
        const latencyMs = Math.max(0, this.clock.now() - startedAt);
        this.log.info({
          event: "embedding_call",
          traceId: metadata.traceId,
          operation: metadata.operation,
          inputType: metadata.inputType,
          provider: this.name,
          model: validated.model,
          inputCount: texts.length,
          inputTokens: validated.inputTokens,
          latencyMs,
          validationPassed: true,
          retryCount,
        });

        return {
          vectors: validated.vectors,
          model: validated.model,
          usage: { inputTokens: validated.inputTokens },
          latencyMs,
          retryCount,
        };
      } catch (error) {
        const mapped =
          error instanceof EmbeddingError ? error : mapVoyageError(error, retryCount);
        if (!mapped.retryable || retryCount >= this.maxRetries) {
          this.log.error({
            event: "embedding_call",
            traceId: metadata.traceId,
            operation: metadata.operation,
            inputType: metadata.inputType,
            provider: this.name,
            model: this.model,
            inputCount: texts.length,
            inputTokens: 0,
            latencyMs: Math.max(0, this.clock.now() - startedAt),
            validationPassed: false,
            retryCount,
            reason: mapped.code,
            providerError:
              error instanceof VoyageAIError
                ? { name: error.name, statusCode: error.statusCode }
                : error instanceof Error
                  ? { name: error.name }
                  : { name: "unknown" },
          });
          throw mapped;
        }

        const delayMs = retryDelayMs(error, retryCount);
        if (this.clock.now() + delayMs >= deadline) throw mapped;
        await this.clock.sleep(delayMs);
        retryCount += 1;
      }
    }
  }
}
