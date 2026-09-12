import type { ResolutionExecution } from "@/domain/resolution-run";
import type { GoldenCase } from "@/evals/contracts";
import type { GoldenDataset } from "@/evals/dataset";
import { runEvaluation } from "@/evals/runner";
import type { RetrievedEvidence } from "@/retrieval/types";

export const evaluationTraceId = "123e4567-e89b-42d3-a456-426614174000";
export const evaluationChunkId = "223e4567-e89b-42d3-a456-426614174000";

export function makeGoldenCases(count = 30): GoldenCase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `eval-case-${String(index + 1).padStart(2, "0")}`,
    datasetVersion: "golden.v1",
    ticket: { text: `Synthetic ticket text number ${index + 1} for evaluation.` },
    expected: {
      category: "billing",
      priorities: ["medium"],
      actions: ["reply"],
      relevantSourceIds: ["duplicate-charges"],
      shouldAbstain: false,
    },
    tags: ["normal", "answerable"],
  }));
}

export function makeEvidence(): RetrievedEvidence[] {
  return [{
    chunkId: evaluationChunkId,
    sourceId: "duplicate-charges",
    title: "Duplicate charges",
    section: "When both charges settled",
    content: "Two settled duplicate charges may be submitted for review.",
    tokenCount: 10,
    similarity: 0.95,
  }];
}

export function makeExecution(): ResolutionExecution {
  return {
    proposal: {
      category: "billing",
      priority: "medium",
      summary: "A duplicate settled charge was reported.",
      confidence: 0.95,
      action: "reply",
      reason: "The duplicate-charge policy supports a response.",
      groundedReply: {
        suggestedResponse: "We can submit the duplicate charge for review.",
        citations: [{
          chunkId: evaluationChunkId,
          sourceId: "duplicate-charges",
          section: "When both charges settled",
          claim: "Settled duplicate charges may be reviewed.",
        }],
      },
    },
    citedSources: [{
      citationPosition: 0,
      chunkId: evaluationChunkId,
      sourceId: "duplicate-charges",
      title: "Duplicate charges",
      section: "When both charges settled",
      content: "Two settled duplicate charges may be submitted for review.",
    }],
    metadata: {
      promptVersions: { classification: "classify.v1", resolution: "resolve.v3" },
      resolutionPolicy: { version: "resolution-policy.v1", minimumConfidence: 0.65 },
      provider: "fake",
      model: "fake-model",
      latencyMs: 12,
      inputTokens: 20,
      outputTokens: 10,
      retryCount: 0,
      validationPassed: true,
    },
  };
}

export async function makeEvaluationReport() {
  const cases = makeGoldenCases();
  const dataset: GoldenDataset = {
    version: "golden.v1",
    sha256: "a".repeat(64),
    cases,
  };
  return runEvaluation({
    dataset,
    concurrency: 3,
    runtime: {
      provider: "fake",
      model: "fake-model",
      promptVersions: { classification: "classify.v1", resolution: "resolve.v3" },
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
      execute: async (_goldenCase, context) => {
        context.recordRetrieved(makeEvidence());
        return makeExecution();
      },
      judge: async () => ({
        value: {
          decisions: [{
            citationId: evaluationChunkId,
            supported: true,
            rationale: "The evidence directly supports the claim.",
          }],
        },
        model: "fake-model",
        finishReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3 },
        latencyMs: 2,
        retryCount: 0,
      }),
    },
    createId: () => evaluationTraceId,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}
