import { describe, expect, it } from "vitest";

import { KnowledgeChunkInspectionSchema } from "@/domain/knowledge";
import {
  formatKnowledgeChunkInspection,
  formatKnowledgeChunkInspectionSummary,
} from "@/ingestion/inspection";

const chunk = {
  chunkId: "223e4567-e89b-42d3-a456-426614174000",
  sourceId: "account-access",
  title: "Account access",
  category: "account" as const,
  version: "1.0",
  chunkIndex: 0,
  section: "Account access > Reset a password",
  tokenCount: 12,
  content: "Follow the documented password-reset steps.",
};

describe("knowledge chunk inspection", () => {
  it("validates and serializes the display-safe chunk allowlist", () => {
    expect(KnowledgeChunkInspectionSchema.parse(chunk)).toEqual(chunk);
    expect(JSON.parse(formatKnowledgeChunkInspection(chunk))).toEqual({
      event: "knowledge_chunk",
      ...chunk,
    });
  });

  it("rejects vectors and other fields outside the allowlist", () => {
    expect(
      KnowledgeChunkInspectionSchema.safeParse({
        ...chunk,
        embedding: [0.1, 0.2],
      }).success,
    ).toBe(false);
  });

  it("serializes a non-negative completion count", () => {
    expect(JSON.parse(formatKnowledgeChunkInspectionSummary(8))).toEqual({
      event: "chunk_inspection_completed",
      chunks: 8,
    });
    expect(() => formatKnowledgeChunkInspectionSummary(-1)).toThrow();
  });
});
