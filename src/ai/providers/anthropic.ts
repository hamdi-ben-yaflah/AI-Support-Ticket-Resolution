import "server-only";

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { LlmError } from "@/ai/errors";
import type { GenerateRequest, GenerateResult, LlmProvider } from "@/ai/types";

const AnthropicMessageSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  parsed_output: z.unknown().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
  }),
});

type Clock = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
};

type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  client?: Anthropic;
  clock?: Partial<Clock>;
};

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  random: () => Math.random(),
};

function retryAfterMs(error: unknown, now: number): number | undefined {
  if (!(error instanceof APIError) || !error.headers) {
    return undefined;
  }

  const raw = error.headers.get("retry-after");
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function mapAnthropicError(error: unknown, retryCount: number): LlmError {
  if (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new LlmError("timeout", "The model provider timed out.", {
      retryable: true,
      retryCount,
      cause: error,
    });
  }

  if (
    error instanceof RateLimitError ||
    error instanceof APIConnectionError ||
    (error instanceof APIError && typeof error.status === "number" && error.status >= 500)
  ) {
    return new LlmError("unavailable", "The model provider is temporarily unavailable.", {
      retryable: true,
      retryCount,
      cause: error,
    });
  }

  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError
  ) {
    return new LlmError("configuration", "The model provider configuration is invalid.", {
      retryable: false,
      retryCount,
      cause: error,
    });
  }

  return new LlmError("unexpected", "The model provider request failed.", {
    retryable: false,
    retryCount,
    cause: error,
  });
}

function isRetryable(error: LlmError, retryCount: number, maxRetries: number): boolean {
  if (!error.retryable || retryCount >= maxRetries) {
    return false;
  }

  return error.code !== "timeout" || retryCount === 0;
}

function supportsExplicitTemperature(model: string): boolean {
  return model !== "claude-sonnet-5";
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly clock: Clock;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        maxRetries: 0,
      });
    this.clock = { ...defaultClock, ...options.clock };
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const startedAt = this.clock.now();
    const deadline = startedAt + this.timeoutMs;
    let retryCount = 0;

    while (true) {
      const remainingMs = deadline - this.clock.now();
      if (remainingMs <= 0) {
        throw new LlmError("timeout", "The model provider timed out.", {
          retryable: true,
          retryCount,
        });
      }

      const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs));

      try {
        const message = await this.client.messages.parse(
          {
            model: this.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: "user", content: request.input }],
            metadata: { user_id: request.metadata.traceId },
            output_config: {
              format: zodOutputFormat(request.outputSchema),
            },
            ...(request.temperature === undefined ||
            !supportsExplicitTemperature(this.model)
              ? {}
              : { temperature: request.temperature }),
          },
          {
            maxRetries: 0,
            timeout: attemptTimeoutMs,
          },
        );

        const parsedMessage = AnthropicMessageSchema.safeParse(message);
        if (!parsedMessage.success) {
          throw new LlmError("invalid_output", "The model returned an invalid response.", {
            retryable: false,
            retryCount,
          });
        }

        const finishReason = parsedMessage.data.stop_reason ?? "unknown";
        if (finishReason === "refusal") {
          throw new LlmError("refused", "The model refused the structured request.", {
            retryable: false,
            retryCount,
            finishReason,
          });
        }

        if (finishReason === "max_tokens" || finishReason === "model_context_window_exceeded") {
          throw new LlmError("truncated", "The model response was truncated.", {
            retryable: false,
            retryCount,
            finishReason,
          });
        }

        const value = request.outputSchema.safeParse(parsedMessage.data.parsed_output);
        if (!value.success) {
          throw new LlmError("invalid_output", "The model returned invalid structured output.", {
            retryable: false,
            retryCount,
            finishReason,
          });
        }

        return {
          value: value.data,
          model: parsedMessage.data.model,
          finishReason,
          usage: {
            inputTokens: parsedMessage.data.usage.input_tokens,
            outputTokens: parsedMessage.data.usage.output_tokens,
            ...(parsedMessage.data.usage.cache_read_input_tokens === null ||
            parsedMessage.data.usage.cache_read_input_tokens === undefined
              ? {}
              : {
                  cachedInputTokens:
                    parsedMessage.data.usage.cache_read_input_tokens,
                }),
          },
          latencyMs: Math.max(0, this.clock.now() - startedAt),
          retryCount,
          providerRequestId: parsedMessage.data.id,
        };
      } catch (error) {
        const mapped = error instanceof LlmError ? error : mapAnthropicError(error, retryCount);
        if (!isRetryable(mapped, retryCount, this.maxRetries)) {
          throw mapped;
        }

        const exponentialDelay = Math.min(2_000, 250 * 2 ** retryCount);
        const requestedDelay = retryAfterMs(error, this.clock.now());
        const delayMs = requestedDelay ?? exponentialDelay * (0.75 + this.clock.random() * 0.5);

        if (this.clock.now() + delayMs >= deadline) {
          throw new LlmError(mapped.code, mapped.message, {
            retryable: mapped.retryable,
            retryCount,
            cause: error,
          });
        }

        await this.clock.sleep(delayMs);
        retryCount += 1;
      }
    }
  }
}
