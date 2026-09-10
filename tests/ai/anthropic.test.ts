import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { LlmError } from "@/ai/errors";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { GenerateRequest } from "@/ai/types";
import { ClassificationSchema, type Classification } from "@/domain/classification";

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
) {
  const client = { messages: { parse } } as unknown as Anthropic;
  return new AnthropicLlmProvider({
    apiKey: "test-key",
    model,
    timeoutMs: 10_000,
    maxRetries,
    client,
    clock: { now: () => 0, sleep: vi.fn().mockResolvedValue(undefined), random: () => 0 },
  });
}

describe("AnthropicLlmProvider", () => {
  it("returns validated structured output and normalized telemetry", async () => {
    const parse = vi.fn().mockResolvedValue(message());
    const result = await provider(parse).generateStructured(request);

    expect(result.value.category).toBe("billing");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 12, cachedInputTokens: 2 });
    expect(result.providerRequestId).toBe("msg_1");
    expect(parse).toHaveBeenCalledOnce();
    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 300,
      metadata: { user_id: request.metadata.traceId },
    });
    expect(parse.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
  });

  it("keeps an explicit temperature for Anthropic models that support it", async () => {
    const parse = vi.fn().mockResolvedValue(message({ model: "claude-sonnet-4-6" }));
    await provider(parse, 2, "claude-sonnet-4-6").generateStructured(request);

    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      temperature: 0,
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
    const parse = vi
      .fn()
      .mockRejectedValueOnce(new APIConnectionError({ message: "offline" }))
      .mockResolvedValueOnce(message());
    const result = await provider(parse).generateStructured(request);
    expect(result.retryCount).toBe(1);
    expect(parse).toHaveBeenCalledTimes(2);
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
