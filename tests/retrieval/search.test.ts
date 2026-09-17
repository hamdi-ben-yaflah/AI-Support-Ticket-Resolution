import { describe, expect, it, vi } from "vitest";

import { getRetrievalConfig, type RetrievalConfig } from "@/config/retrieval";
import type { EmbeddingProvider } from "@/embeddings/types";
import { retrieveEvidence, selectEvidence } from "@/retrieval/search";
import type { RetrievalCandidate } from "@/retrieval/types";

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174000",
  "323e4567-e89b-42d3-a456-426614174000",
];
const config: RetrievalConfig = {
  candidateCount: 8,
  finalCount: 2,
  minimumSimilarity: 0.7,
  maximumContextTokens: 10,
  minimumEvidenceCount: 1,
  version: "retrieval.v1",
};
function candidate(index: number, similarity: number, tokenCount = 3): RetrievalCandidate {
  return {
    chunkId: ids[index] as string,
    title: `Title ${index}`,
    section: `Section ${index}`,
    content: `Content ${index}`,
    tokenCount,
    similarity,
    metadata: { sourceId: `source-${index}`, category: "billing", version: "1" },
  };
}
const embedder: EmbeddingProvider = {
  name: "fake",
  model: "fake",
  dimensions: 2,
  embed: vi.fn().mockResolvedValue({
    vectors: [[1, 0]],
    model: "fake",
    usage: { inputTokens: 2 },
    latencyMs: 1,
    retryCount: 0,
  }),
};

describe("retrieval", () => {
  it("retains the reproduced duplicate-charge match at the default threshold", () => {
    const defaultConfig = getRetrievalConfig({ NODE_ENV: "test" });

    expect(defaultConfig.minimumSimilarity).toBe(0.65);
    expect(
      selectEvidence(
        [candidate(0, 0.6605782700274324), candidate(1, 0.6499999999999999)],
        defaultConfig,
      ).map((item) => item.chunkId),
    ).toEqual([ids[0]]);
  });

  it("deduplicates, thresholds, orders, and applies count/token budgets", () => {
    expect(
      selectEvidence(
        [candidate(0, 0.75), candidate(1, 0.9, 8), candidate(0, 0.8), candidate(2, 0.6)],
        config,
      ).map((item) => item.chunkId),
    ).toEqual([ids[1]]);
  });

  it("uses the category search without fallback when evidence is adequate", async () => {
    const search = vi.fn().mockResolvedValue([candidate(0, 0.9)]);
    await expect(
      retrieveEvidence(
        { text: "duplicate charge", category: "billing", traceId: "trace" },
        { embedder, search, config, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ),
    ).resolves.toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ category: "billing" }));
  });

  it("broadens when category evidence is inadequate", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([candidate(0, 0.2)])
      .mockResolvedValueOnce([candidate(1, 0.9)]);
    const result = await retrieveEvidence(
      { text: "question", category: "other", traceId: "trace" },
      { embedder, search, config, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    expect(result[0]?.chunkId).toBe(ids[1]);
    expect(search).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ category: expect.anything() }),
    );
  });

  it("searches all categories directly when no category is supplied", async () => {
    const search = vi.fn().mockResolvedValue([candidate(0, 0.9)]);
    await expect(
      retrieveEvidence(
        { text: "refund policy", traceId: "trace" },
        { embedder, search, config, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      ),
    ).resolves.toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      expect.not.objectContaining({ category: expect.anything() }),
    );
  });

  it("returns controlled insufficient evidence and unavailable failures", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      retrieveEvidence(
        { text: "unknown", category: "other", traceId: "trace" },
        { embedder, search: vi.fn().mockResolvedValue([]), config, log },
      ),
    ).rejects.toMatchObject({ code: "insufficient_evidence" });
    await expect(
      retrieveEvidence(
        { text: "unknown", category: "other", traceId: "trace" },
        { embedder, search: vi.fn().mockRejectedValue(new Error("db")), config, log },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
