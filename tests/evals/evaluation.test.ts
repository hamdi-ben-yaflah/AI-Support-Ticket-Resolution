import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LlmError } from "@/ai/errors";
import type { LlmProvider } from "@/ai/types";
import { parseEvaluationCliArguments } from "@/evals/cli-options";
import { parseGoldenDataset } from "@/evals/dataset";
import { aggregateQualityMetrics, gradeExecution, nearestRankPercentile } from "@/evals/graders";
import { judgeCitations } from "@/evals/judge";
import { runEvaluation } from "@/evals/runner";
import {
  evaluationChunkId,
  evaluationTraceId,
  makeEvidence,
  makeExecution,
  makeRefundExecution,
  makeGoldenCases,
} from "../support/evaluation";

describe("golden evaluation dataset", () => {
  it("loads 30-50 unique, versioned, synthetic cases", async () => {
    const contents = await readFile(resolve(process.cwd(), "data/evals/golden.jsonl"), "utf8");
    const dataset = parseGoldenDataset(contents);
    expect(dataset.cases).toHaveLength(36);
    expect(new Set(dataset.cases.map((item) => item.id)).size).toBe(36);
    expect(dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(dataset.cases.map((item) => item.expected.category))).toEqual(
      new Set(["billing", "technical", "account", "other"]),
    );
    expect(dataset.cases.some((item) => item.tags.includes("prompt-injection"))).toBe(true);
    expect(
      dataset.cases.some(
        (item) =>
          item.expected.actions.includes("request_refund_review") &&
          item.tags.includes("action-ready"),
      ),
    ).toBe(true);
    expect(
      dataset.cases.some(
        (item) =>
          item.expected.actions.includes("request_refund_review") &&
          item.tags.includes("confirmation-bypass"),
      ),
    ).toBe(true);
    expect(dataset.cases.some((item) => item.expected.shouldAbstain)).toBe(true);
  });

  it("rejects blank lines, duplicates, mixed versions, and undersized datasets", () => {
    const item = JSON.stringify(makeGoldenCases(1)[0]);
    expect(() => parseGoldenDataset(`${item}\n\n${item}`)).toThrow("blank line");
    expect(() => parseGoldenDataset(Array.from({ length: 30 }, () => item).join("\n"))).toThrow(
      "Duplicate",
    );
    expect(() => parseGoldenDataset(item.replace("golden.v2", "golden.v1"))).toThrow();
    expect(() => parseGoldenDataset(item)).toThrow();
  });
});

describe("evaluation CLI options", () => {
  it("accepts pnpm's separator and validates flags", () => {
    expect(
      parseEvaluationCliArguments(
        ["--", "--concurrency", "4", "--output", "artifacts/custom.json"],
        "/workspace",
      ),
    ).toEqual({ concurrency: 4, output: "/workspace/artifacts/custom.json" });
    expect(
      parseEvaluationCliArguments(
        ["--", "--concurrency=3", "--output=artifacts/report.json"],
        "/workspace",
      ),
    ).toEqual({ concurrency: 3, output: "/workspace/artifacts/report.json" });
    expect(() => parseEvaluationCliArguments(["--wat"], "/workspace")).toThrow("Unknown");
    expect(() => parseEvaluationCliArguments(["--concurrency", "0"], "/workspace")).toThrow(
      "1 to 5",
    );
    expect(() => parseEvaluationCliArguments(["--output", "result.txt"], "/workspace")).toThrow(
      "JSON",
    );
    expect(() =>
      parseEvaluationCliArguments(["--output", "a.json", "--output", "b.json"], "/workspace"),
    ).toThrow("Duplicate");
  });
});

describe("evaluation graders", () => {
  it("uses explicit denominators and nearest-rank percentiles", () => {
    const result = {
      caseId: "eval-case-one",
      tags: ["test"],
      expected: makeGoldenCases(1)[0]!.expected,
      actual: {
        category: "billing" as const,
        priority: "medium" as const,
        confidence: 0.9,
        action: "reply" as const,
        citedChunkIds: [evaluationChunkId],
        citedSourceIds: ["duplicate-charges"],
        retrievedChunkIds: [evaluationChunkId],
        retrievedSourceIds: ["duplicate-charges"],
        provider: "fake",
        model: "fake",
        promptVersions: { classification: "v1", resolution: "v1" },
      },
      scores: {
        schemaValid: true,
        categoryCorrect: true,
        priorityCorrect: true,
        actionCorrect: true,
        abstentionCorrect: true,
        retrievalRecallAt5: 0.5,
        citationExistence: 1,
        citationSupport: 0.5,
      },
      judgeDecisions: [],
      telemetry: {
        latencyMs: 1,
        generationInputTokens: 1,
        generationOutputTokens: 1,
        generationCachedInputTokens: 0,
        generationCacheWriteTokens: 0,
        judgeInputTokens: 1,
        judgeOutputTokens: 1,
        judgeCachedInputTokens: 0,
        judgeCacheWriteTokens: 0,
        retryCount: 0,
      },
      error: null,
      passed: false,
    };
    const metrics = aggregateQualityMetrics([result]);
    expect(metrics.retrievalRecallAt5).toEqual({ value: 0.5, numerator: 0.5, denominator: 1 });
    expect(metrics.abstentionPrecision.value).toBeNull();
    expect(nearestRankPercentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(nearestRankPercentile([40, 10, 30, 20], 0.95)).toBe(40);
  });
});

describe("citation judge", () => {
  it("rejects missing, duplicate, and unknown citation IDs", async () => {
    const provider = {
      name: "fake",
      model: "fake",
      generateStructured: vi.fn().mockResolvedValue({
        value: {
          decisions: [
            {
              citationId: "323e4567-e89b-42d3-a456-426614174000",
              supported: true,
              rationale: "Wrong ID.",
            },
          ],
        },
        model: "fake",
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        retryCount: 0,
      }),
    } as unknown as LlmProvider;
    await expect(
      judgeCitations({ execution: makeExecution(), provider, traceId: evaluationTraceId }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("judges and grades refund-review citations without exposing action arguments", async () => {
    const execution = makeRefundExecution();
    const provider = {
      name: "fake",
      model: "fake",
      generateStructured: vi.fn().mockResolvedValue({
        value: {
          decisions: [
            {
              citationId: evaluationChunkId,
              supported: true,
              rationale: "Direct support.",
            },
          ],
        },
        model: "fake",
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        retryCount: 0,
      }),
    } as unknown as LlmProvider;
    const judged = await judgeCitations({
      execution,
      provider,
      traceId: evaluationTraceId,
    });
    const goldenCase = makeGoldenCases(1)[0]!;
    goldenCase.expected.actions = ["request_refund_review"];
    const scores = gradeExecution({
      goldenCase,
      execution,
      retrieved: makeEvidence(),
      judgeDecisions: judged?.value.decisions ?? [],
    });

    expect(provider.generateStructured).toHaveBeenCalledOnce();
    expect(scores).toMatchObject({
      actionCorrect: true,
      citationExistence: 1,
      citationSupport: 1,
      abstentionCorrect: true,
    });
    expect(
      JSON.stringify({
        action: execution.proposal.action,
        citedChunkIds: execution.citedSources.map((source) => source.chunkId),
      }),
    ).not.toContain("proposalId");
  });
});

describe("cache-aware evaluation cost", () => {
  it("totals cache tokens and charges reads and writes at their own rates", async () => {
    const cases = makeGoldenCases();
    const cachedExecution = {
      ...makeExecution(),
      metadata: {
        ...makeExecution().metadata,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 10,
      },
    };
    const report = await runEvaluation({
      dataset: { version: "golden.v2", sha256: "d".repeat(64), cases },
      concurrency: 3,
      runtime: {
        provider: "fake",
        model: "fake-model",
        promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
        retrieval: {
          version: "retrieval.v1",
          candidateCount: 8,
          finalCount: 5,
          minimumSimilarity: 0.65,
          maximumContextTokens: 3_500,
          minimumEvidenceCount: 1,
        },
        resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
        pricing: {
          inputUsdPerMillion: 1_000_000,
          outputUsdPerMillion: 0,
          cacheReadUsdPerMillion: 100_000,
          cacheWriteUsdPerMillion: 2_000_000,
        },
      },
      dependencies: {
        execute: async (_item, context) => {
          context.recordRetrieved(makeEvidence());
          return cachedExecution;
        },
        judge: async () => ({
          value: {
            decisions: [
              { citationId: evaluationChunkId, supported: true, rationale: "Direct support." },
            ],
          },
          model: "fake-model",
          finishReason: "end_turn",
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cachedInputTokens: 100,
            cacheWriteInputTokens: 2,
          },
          latencyMs: 1,
          retryCount: 0,
        }),
      },
      createId: () => evaluationTraceId,
    });

    const caseCount = cases.length;
    expect(report.metrics.operations.cachedInputTokens).toBe(900 * caseCount);
    expect(report.metrics.operations.cacheWriteInputTokens).toBe(12 * caseCount);
    // 25 uncached input + 900 cache reads + 12 cache writes per case, each at its own rate.
    expect(report.metrics.operations.estimatedCostUsd).toBeCloseTo(
      caseCount * (25 * 1 + 900 * 0.1 + 12 * 2),
      6,
    );
  });
});

describe("shared evaluation runner", () => {
  it("bounds concurrency, preserves order, computes cost, and omits ticket content", async () => {
    const cases = makeGoldenCases();
    cases[0]!.ticket.text = "DO NOT EXPOSE THIS SYNTHETIC TICKET";
    let active = 0;
    let maximumActive = 0;
    const report = await runEvaluation({
      dataset: { version: "golden.v2", sha256: "b".repeat(64), cases },
      concurrency: 3,
      runtime: {
        provider: "fake",
        model: "fake-model",
        promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
        retrieval: {
          version: "retrieval.v1",
          candidateCount: 8,
          finalCount: 5,
          minimumSimilarity: 0.65,
          maximumContextTokens: 3_500,
          minimumEvidenceCount: 1,
        },
        resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
        pricing: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          cacheReadUsdPerMillion: 0.1,
          cacheWriteUsdPerMillion: 1.25,
        },
      },
      dependencies: {
        execute: async (_item, context) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((done) => setTimeout(done, 1));
          active -= 1;
          context.recordRetrieved(makeEvidence());
          return makeExecution();
        },
        judge: async () => ({
          value: {
            decisions: [
              { citationId: evaluationChunkId, supported: true, rationale: "Direct support." },
            ],
          },
          model: "fake-model",
          finishReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 3 },
          latencyMs: 1,
          retryCount: 0,
        }),
      },
      createId: () => evaluationTraceId,
    });
    expect(maximumActive).toBe(3);
    expect(report.cases.map((item) => item.caseId)).toEqual(cases.map((item) => item.id));
    expect(report.status).toBe("pass");
    expect(report.metrics.operations.estimatedCostUsd).toBeCloseTo(0.00153);
    expect(JSON.stringify(report)).not.toContain("DO NOT EXPOSE");
    expect(JSON.stringify(report)).not.toContain("suggestedResponse");
    expect(JSON.stringify(report)).not.toContain(makeEvidence()[0]!.content);
  });

  it("continues after isolated resolution and judge failures", async () => {
    const cases = makeGoldenCases();
    const report = await runEvaluation({
      dataset: { version: "golden.v2", sha256: "c".repeat(64), cases },
      concurrency: 2,
      runtime: {
        provider: "fake",
        model: "fake-model",
        promptVersions: { classification: "classify.v1", resolution: "resolve.v4" },
        retrieval: {
          version: "retrieval.v1",
          candidateCount: 8,
          finalCount: 5,
          minimumSimilarity: 0.65,
          maximumContextTokens: 3_500,
          minimumEvidenceCount: 1,
        },
        resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
        pricing: null,
      },
      dependencies: {
        execute: async (item, context) => {
          if (item.id === cases[0]!.id)
            throw new LlmError("timeout", "secret", { retryable: true });
          context.recordRetrieved(makeEvidence());
          return makeExecution();
        },
        judge: async (_execution, traceId) => {
          if (traceId === "323e4567-e89b-42d3-a456-426614174000") {
            throw new LlmError("invalid_output", "secret", { retryable: false });
          }
          return {
            value: {
              decisions: [{ citationId: evaluationChunkId, supported: true, rationale: "Direct." }],
            },
            model: "fake",
            finishReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
            retryCount: 0,
          };
        },
      },
      createId: (() => {
        let count = 0;
        return () => (count++ === 1 ? "323e4567-e89b-42d3-a456-426614174000" : evaluationTraceId);
      })(),
    });
    expect(report.cases).toHaveLength(30);
    expect(report.cases[0]!.error).toMatchObject({ stage: "resolution", code: "timeout" });
    expect(report.cases.some((item) => item.error?.stage === "judge")).toBe(true);
    expect(report.status).toBe("regression");
  });
});
