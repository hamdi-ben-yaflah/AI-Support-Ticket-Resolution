import { VoyageAIClient, VoyageAIError, VoyageAITimeoutError } from "voyageai";
import { describe, expect, it, vi } from "vitest";

import { VoyageEmbeddingProvider } from "@/embeddings/providers/voyage";
import type { AppLogger } from "@/observability/logger";

function response(data: Array<{ index: number; embedding: number[] }>) {
  return {
    object: "list",
    model: "voyage-4",
    data: data.map((item) => ({ object: "embedding", ...item })),
    usage: { totalTokens: 4 },
  };
}

function sdkResponse(data: Array<{ index: number; embedding: number[] }>) {
  return { data: response(data), rawResponse: new Response() };
}

function provider(
  embed: ReturnType<typeof vi.fn>,
  dimensions = 2,
  maxRetries = 0,
  log: AppLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger,
) {
  return new VoyageEmbeddingProvider({
    apiKey: "test",
    model: "voyage-4",
    dimensions,
    timeoutMs: 10_000,
    maxRetries,
    client: { embed } as unknown as VoyageAIClient,
    clock: { now: () => 0, sleep: vi.fn().mockResolvedValue(undefined) },
    log,
  });
}

describe("VoyageEmbeddingProvider", () => {
  it.each(["document", "query"] as const)(
    "requests float %s vectors without silent truncation and preserves ordering",
    async (inputType) => {
      const embed = vi.fn().mockResolvedValue(
        response([
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ]),
      );
      const result = await provider(embed).embed(["first", "second"], {
        traceId: "trace",
        operation: inputType === "document" ? "ingestion" : "retrieval",
        inputType,
      });

      expect(result.vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
      expect(result.usage.inputTokens).toBe(4);
      expect(embed).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "voyage-4",
          outputDimension: 2,
          outputDtype: "float",
          truncation: false,
          inputType,
          input: ["first", "second"],
        }),
        expect.objectContaining({ maxRetries: 0 }),
      );
    },
  );

  it("unwraps the Voyage SDK HTTP response envelope", async () => {
    const embed = vi.fn().mockResolvedValue(sdkResponse([{ index: 0, embedding: [1, 0] }]));
    await expect(
      provider(embed).embed(["input"], {
        traceId: "trace",
        operation: "ingestion",
        inputType: "document",
      }),
    ).resolves.toMatchObject({ vectors: [[1, 0]] });
  });

  it.each([
    ["dimension mismatch", [{ index: 0, embedding: [1] }]],
    ["non-finite value", [{ index: 0, embedding: [Number.NaN, 0] }]],
    ["wrong index", [{ index: 1, embedding: [1, 0] }]],
  ])("rejects %s", async (_case, data) => {
    await expect(
      provider(vi.fn().mockResolvedValue(response(data))).embed(["input"], {
        traceId: "trace",
        operation: "ingestion",
        inputType: "document",
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it.each([
    [new VoyageAITimeoutError("slow"), "timeout"],
    [new VoyageAIError({ statusCode: 429 }), "unavailable"],
    [new VoyageAIError({ statusCode: 401 }), "configuration"],
  ])("maps provider errors without leaking SDK details", async (error, code) => {
    await expect(
      provider(vi.fn().mockRejectedValue(error)).embed(["input"], {
        traceId: "trace",
        operation: "retrieval",
        inputType: "query",
      }),
    ).rejects.toMatchObject({ code });
  });

  it("logs bounded, allowlisted Voyage rate-limit diagnostics", async () => {
    const errorLog = vi.fn();
    const error = new VoyageAIError({
      statusCode: 429,
      body: {
        code: "rate_limit_exceeded",
        detail:
          "Payment method required for this project. Authorization: Bearer provider-token api_key=provider-key",
        ignored: { secret: "must-not-be-logged" },
      },
      rawResponse: new Response(null, {
        status: 429,
        headers: {
          "retry-after": "30",
          "x-request-id": "voyage-request-123",
          "x-ratelimit-limit-requests": "3",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "45s",
          "x-unrelated-secret": "must-not-be-logged",
        },
      }),
    });

    await expect(
      provider(vi.fn().mockRejectedValue(error), 2, 0, {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
      } as unknown as AppLogger).embed(["private input"], {
        traceId: "trace",
        operation: "ingestion",
        inputType: "document",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        providerError: {
          name: "VoyageAIError",
          statusCode: 429,
          code: "rate_limit_exceeded",
          reason:
            "Payment method required for this project. authorization=[REDACTED] api_key=[REDACTED]",
          requestId: "voyage-request-123",
          retryAfter: "30",
          rateLimitLimit: "3",
          rateLimitRemaining: "0",
          rateLimitReset: "45s",
        },
      }),
    );
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain("private input");
    expect(serializedLog).not.toContain("provider-token");
    expect(serializedLog).not.toContain("provider-key");
    expect(serializedLog).not.toContain("must-not-be-logged");
  });

  it("keeps non-Voyage terminal error diagnostics minimal", async () => {
    const errorLog = vi.fn();
    await expect(
      provider(vi.fn().mockRejectedValue(new Error("sensitive SDK detail")), 2, 0, {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
      } as unknown as AppLogger).embed(["input"], {
        traceId: "trace",
        operation: "retrieval",
        inputType: "query",
      }),
    ).rejects.toMatchObject({ code: "unexpected" });

    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ providerError: { name: "Error" } }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive SDK detail");
  });

  it("retries transient failures within the deadline", async () => {
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new VoyageAIError({ statusCode: 503 }))
      .mockResolvedValueOnce(response([{ index: 0, embedding: [1, 0] }]));
    await expect(
      provider(embed, 2, 1).embed(["input"], {
        traceId: "trace",
        operation: "retrieval",
        inputType: "query",
      }),
    ).resolves.toMatchObject({ retryCount: 1 });
    expect(embed).toHaveBeenCalledTimes(2);
  });
});
