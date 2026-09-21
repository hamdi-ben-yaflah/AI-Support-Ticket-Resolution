import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { LlmError } from "@/ai/errors";
import { createResolutionRequest } from "@/ai/pipeline/resolve-ticket";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { GenerateRequest } from "@/ai/types";
import { ClassificationSchema, type Classification } from "@/domain/classification";
import { InMemoryTracing } from "@/observability/testing";
import type { AppTracing } from "@/observability/tracing";

const request: GenerateRequest<Classification> = {
  task: "classification",
  system: "Classify safely",
  input: "untrusted ticket",
  outputSchema: ClassificationSchema,
  maxOutputTokens: 300,
  temperature: 0,
  metadata: {
    traceId: "123e4567-e89b-42d3-a456-426614174000",
    promptVersion: "classify.v1",
  },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    model: "claude-test",
    stop_reason: "end_turn",
    parsed_output: {
      category: "billing",
      priority: "medium",
      summary: "Duplicate charge",
      confidence: 0.87,
    },
    usage: {
      input_tokens: 20,
      output_tokens: 12,
      cache_read_input_tokens: 2,
    },
    ...overrides,
  };
}

function provider(
  parse: ReturnType<typeof vi.fn>,
  maxRetries = 2,
  model = "claude-sonnet-5",
  clock: {
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    random: () => number;
  } = {
    now: () => 0,
    sleep: vi.fn().mockResolvedValue(undefined),
    random: () => 0,
  },
  tracing?: AppTracing,
  promptCacheEnabled?: boolean,
) {
  const client = {
    messages: {
      parse: async (...arguments_: unknown[]) => ({
        ...((await (parse as (...arguments_: unknown[]) => Promise<unknown>)(
          ...arguments_,
        )) as Record<string, unknown>),
        _request_id: "req_1",
      }),
    },
  } as unknown as Anthropic;
  return new AnthropicLlmProvider({
    apiKey: "test-key",
    model,
    timeoutMs: 10_000,
    maxRetries,
    client,
    clock,
    tracing,
    ...(promptCacheEnabled === undefined ? {} : { promptCacheEnabled }),
  });
}

describe("AnthropicLlmProvider prompt caching", () => {
  it("marks the end of the system prompt as an ephemeral cache breakpoint when the request opts in", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    await provider(parse).generateStructured({ ...request, cacheableSystemPrompt: true });

    expect(parse.mock.calls[0]?.[0]?.system).toEqual([
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("leaves the system prompt uncached when the provider disables prompt caching", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    await provider(parse, 2, "claude-sonnet-5", undefined, undefined, false).generateStructured({
      ...request,
      cacheableSystemPrompt: true,
    });

    expect(parse.mock.calls[0]?.[0]?.system).toBe(request.system);
  });

  it("leaves the system prompt uncached when the request does not opt in", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    await provider(parse).generateStructured(request);

    expect(parse.mock.calls[0]?.[0]?.system).toBe(request.system);
  });

  it("sends a byte-identical cached prefix for two tickets with different text", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    const cached = { ...request, cacheableSystemPrompt: true };
    const anthropic = provider(parse);
    await anthropic.generateStructured({ ...cached, input: "first untrusted ticket" });
    await anthropic.generateStructured({ ...cached, input: "second untrusted ticket" });

    const [first, second] = parse.mock.calls.map((call) => call[0]);
    expect(JSON.stringify(first?.system)).toBe(JSON.stringify(second?.system));
    expect(JSON.stringify(first?.output_config)).toBe(JSON.stringify(second?.output_config));
    expect(first?.messages).not.toEqual(second?.messages);
  });

  it("omits cache usage that the provider response does not report", async () => {
    const parse = vi.fn().mockResolvedValue(
      message({
        usage: { input_tokens: 20, output_tokens: 12, cache_read_input_tokens: null },
      }),
    );
    const result = await provider(parse).generateStructured({
      ...request,
      cacheableSystemPrompt: true,
    });

    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 12 });
  });

  it("reports cache read and cache write counts when the provider returns them", async () => {
    const parse = vi.fn().mockResolvedValue(
      message({
        usage: {
          input_tokens: 20,
          output_tokens: 12,
          cache_read_input_tokens: 840,
          cache_creation_input_tokens: 5,
        },
      }),
    );
    const result = await provider(parse).generateStructured({
      ...request,
      cacheableSystemPrompt: true,
    });

    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 12,
      cachedInputTokens: 840,
      cacheWriteInputTokens: 5,
    });
  });
});

describe("AnthropicLlmProvider", () => {
  it("returns validated structured output and normalized telemetry", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    const result = await provider(parse).generateStructured(request);

    expect(result.value.category).toBe("billing");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 12, cachedInputTokens: 2 });
    expect(result.providerRequestId).toBe("req_1");
    expect(result.providerMessageId).toBe("msg_1");
    expect(parse).toHaveBeenCalledOnce();
    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 300,
      metadata: { user_id: request.metadata.traceId },
    });
    expect(parse.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    expect(parse.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      timeout: 10_000,
    });
  });

  it("keeps an explicit temperature for Anthropic models that support it", async () => {
    const parse = vi.fn().mockResolvedValue(message({ model: "claude-sonnet-4-6" }));
    await provider(parse, 2, "claude-sonnet-4-6").generateStructured(request);

    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      temperature: 0,
    });
  });

  it("serializes and validates the provider-compatible resolution schema", async () => {
    const parse = vi.fn().mockResolvedValue(
      message({
        parsed_output: {
          action: "needs_human_review",
          reason: "The retrieved policies conflict.",
          groundedReply: null,
        },
      }),
    );
    const resolutionRequest = createResolutionRequest({
      ticket: { text: "A synthetic support question" },
      classification: {
        category: "other",
        priority: "low",
        summary: "Synthetic question",
        confidence: 0.9,
      },
      evidence: [
        {
          chunkId: "223e4567-e89b-42d3-a456-426614174000",
          sourceId: "policy-a",
          title: "Policy A",
          section: "Policy A > Rule",
          content: "A synthetic rule.",
          tokenCount: 4,
          similarity: 0.9,
        },
      ],
      traceId: request.metadata.traceId,
    });

    await expect(provider(parse).generateStructured(resolutionRequest)).resolves.toMatchObject({
      value: {
        action: "needs_human_review",
        reason: "The retrieved policies conflict.",
        groundedReply: null,
      },
    });
    expect(parse.mock.calls[0]?.[0]?.output_config?.format).toMatchObject({
      type: "json_schema",
      schema: { type: "object" },
    });
  });

  it("rejects schema-invalid model output without retrying", async () => {
    const parse = vi.fn().mockResolvedValue(message({ parsed_output: { category: "sales" } }));
    await expect(provider(parse).generateStructured(request)).rejects.toMatchObject({
      code: "invalid_output",
      retryable: false,
    } satisfies Partial<LlmError>);
    expect(parse).toHaveBeenCalledOnce();
  });

  it.each([
    ["refusal", "refused"],
    ["max_tokens", "truncated"],
    ["model_context_window_exceeded", "truncated"],
  ])("maps %s finish reason to %s", async (stopReason, code) => {
    const parse = vi.fn().mockResolvedValue(message({ stop_reason: stopReason }));
    await expect(provider(parse).generateStructured(request)).rejects.toMatchObject({ code });
    expect(parse).toHaveBeenCalledOnce();
  });

  it("retries transient connections within the configured cap", async () => {
    const tracing = new InMemoryTracing();
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new APIConnectionError({ message: "offline" }))
      .mockResolvedValueOnce(message());
    const result = await tracing.withSpan("support.ai.classification", {}, () =>
      provider(parse, 2, "claude-sonnet-5", undefined, tracing).generateStructured(request),
    );
    expect(result.retryCount).toBe(1);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(tracing.spans[0]?.events).toEqual([
      {
        name: "support.retry",
        attributes: {
          attempt: 1,
          retryCount: 1,
          delayMs: 187.5,
          errorCode: "unavailable",
        },
      },
    ]);
  });

  it("uses only the remaining operation deadline for a transient retry", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const parse = vi
      .fn()
      .mockImplementationOnce(() => {
        now = 2_000;
        return Promise.reject(new APIConnectionError({ message: "offline" }));
      })
      .mockResolvedValueOnce(message());

    await provider(parse, 2, "claude-sonnet-5", {
      now: () => now,
      sleep,
      random: () => 0,
    }).generateStructured(request);

    expect(sleep).toHaveBeenCalledWith(187.5);
    expect(parse.mock.calls.map((call) => call[1]?.timeout)).toEqual([10_000, 7_812]);
  });

  it("does not retry when backoff would exhaust the operation deadline", async () => {
    let now = 0;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const parse = vi.fn().mockImplementationOnce(() => {
      now = 9_900;
      return Promise.reject(new APIConnectionError({ message: "offline" }));
    });

    await expect(
      provider(parse, 2, "claude-sonnet-5", {
        now: () => now,
        sleep,
        random: () => 0,
      }).generateStructured(request),
    ).rejects.toMatchObject({ code: "unavailable", retryCount: 0 });
    expect(parse).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not start a request after the operation deadline is exhausted", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(10_000);
    const parse = vi.fn();

    await expect(
      provider(parse, 2, "claude-sonnet-5", {
        now,
        sleep: vi.fn().mockResolvedValue(undefined),
        random: () => 0,
      }).generateStructured(request),
    ).rejects.toMatchObject({ code: "timeout", retryCount: 0 });
    expect(parse).not.toHaveBeenCalled();
  });

  it("limits timeout retries to one", async () => {
    const parse = vi.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: "slow" }));
    await expect(provider(parse, 5).generateStructured(request)).rejects.toMatchObject({
      code: "timeout",
      retryCount: 1,
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
