import { describe, expect, it } from "vitest";

import { parseKnowledgeDocument } from "@/ingestion/chunk-markdown";

function document(body: string, sourceId = "test-source") {
  return `---\nsourceId: ${sourceId}\ntitle: Test source\ncategory: technical\nversion: "1.0"\n---\n${body}`;
}

describe("parseKnowledgeDocument", () => {
  it("preserves heading paths and deterministic indexes and hashes", () => {
    const raw = document(
      "# Product\n\nIntro.\n\n## Setup\n\nFollow the safe setup steps.\n\n### Browser\n\nRestart the browser.",
    );
    const first = parseKnowledgeDocument("test.md", raw);
    const second = parseKnowledgeDocument("test.md", raw);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.chunks.map((chunk) => [chunk.chunkIndex, chunk.section])).toEqual([
      [0, "Product"],
      [1, "Product > Setup"],
      [2, "Product > Setup > Browser"],
    ]);
    expect(first.chunks.every((chunk) => chunk.tokenCount > 0)).toBe(true);
  });

  it("splits oversized sections into bounded overlapping chunks", () => {
    const body = `# Large section\n\n${"A repeatable troubleshooting instruction with several details. ".repeat(180)}`;
    const parsed = parseKnowledgeDocument("large.md", document(body));
    expect(parsed.chunks.length).toBeGreaterThan(1);
    expect(
      parsed.chunks.every((chunk) => chunk.tokenCount <= 600 && chunk.content.length > 0),
    ).toBe(true);
    expect(parsed.chunks.every((chunk) => chunk.section === "Large section")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["missing front matter", "# Heading\nBody"],
    ["missing heading", document("Body without a heading")],
    ["empty body", document("   ")],
  ])("rejects %s documents", (_case, raw) => {
    expect(() => parseKnowledgeDocument("bad.md", raw)).toThrow();
  });
});
