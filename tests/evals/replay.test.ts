import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { LlmProvider } from "@/ai/types";
import type { EmbeddingProvider } from "@/embeddings/types";
import {
  createRecordingEmbeddingProvider,
  createRecordingLlmProvider,
  createReplayEmbeddingProvider,
  createReplayLlmProvider,
  hashEmbeddingRequest,
  hashLlmRequest,
} from "@/evals/replay";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "support-cassettes-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const OutputSchema = z.object({ category: z.literal("billing") }).strict();
const request = {
  task: "classification" as const,
  system: "private system prompt",
  input: "synthetic ticket contents",
  outputSchema: OutputSchema,
  maxOutputTokens: 100,
  metadata: { traceId: "trace", promptVersion: "classify.v1" },
};

describe("evaluation cassettes", () => {
  it("keeps committed cassettes within the redacted allowlist", async () => {
    const directory = join(process.cwd(), "data/evals/cassettes");
    const fileNames = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(fileNames.length).toBeGreaterThan(100);
    for (const fileName of fileNames) {
      const contents = await readFile(join(directory, fileName), "utf8");
      expect(contents).not.toMatch(/sk-ant-|\bpa-[A-Za-z0-9_-]+/);
      expect(contents).not.toContain("providerRequestId");
      expect(contents).not.toContain("providerMessageId");
      expect(contents).not.toContain("BEGIN UNTRUSTED TICKET DATA");
      expect(contents).not.toContain("You classify support tickets");
      expect(contents).not.toContain("You recommend one safe next action");
    }
  });

  it("hashes every answer-affecting LLM field deterministically", () => {
    const original = hashLlmRequest("anthropic", "model-a", request);
    expect(hashLlmRequest("anthropic", "model-a", request)).toBe(original);
    expect(hashLlmRequest("anthropic", "model-b", request)).not.toBe(original);
    expect(hashLlmRequest("anthropic", "model-a", { ...request, input: "changed" })).not.toBe(
      original,
    );
    expect(
      hashLlmRequest("anthropic", "model-a", {
        ...request,
        metadata: { ...request.metadata, promptVersion: "classify.v2" },
      }),
    ).not.toBe(original);
  });

  it("records only parsed output metadata and replays with zero provider usage", async () => {
    const directory = await temporaryDirectory();
    const live = {
      name: "anthropic",
      model: "model-a",
      generateStructured: vi.fn().mockResolvedValue({
        value: { category: "billing" },
        model: "model-a",
        finishReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4 },
        latencyMs: 20,
        retryCount: 0,
        providerRequestId: "must-not-be-recorded",
      }),
    } satisfies LlmProvider;

    await createRecordingLlmProvider(live, directory)
      .forCase("eval-replay-case")
      .generateStructured(request);
    const contents = await readFile(
      join(directory, "eval-replay-case.classification.json"),
      "utf8",
    );
    expect(contents).not.toContain(request.system);
    expect(contents).not.toContain(request.input);
    expect(contents).not.toContain("must-not-be-recorded");

    const replay = await createReplayLlmProvider("model-a", directory)
      .forCase("eval-replay-case")
      .generateStructured(request);
    expect(live.generateStructured).toHaveBeenCalledOnce();
    expect(replay).toMatchObject({
      value: { category: "billing" },
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      retryCount: 0,
    });
  });

  it("throws a typed miss and never falls back to a live provider", async () => {
    const directory = await temporaryDirectory();
    const replay = createReplayLlmProvider("model-a", directory).forCase("eval-missing-case");
    await expect(replay.generateStructured(request)).rejects.toEqual(
      expect.objectContaining({
        name: "CassetteMissError",
        code: "cassette_miss",
        caseId: "eval-missing-case",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("records and replays embeddings by input hash without storing input text", async () => {
    const directory = await temporaryDirectory();
    const live = {
      name: "voyage",
      model: "voyage-test",
      dimensions: 2,
      embed: vi.fn().mockResolvedValue({
        vectors: [[0.25, 0.75]],
        model: "voyage-test",
        usage: { inputTokens: 7 },
        latencyMs: 5,
        retryCount: 0,
      }),
    } satisfies EmbeddingProvider;
    const metadata = {
      traceId: "trace",
      operation: "retrieval" as const,
      inputType: "query" as const,
    };
    const texts = ["sensitive synthetic query"];
    await createRecordingEmbeddingProvider(live, directory)
      .forCase("eval-replay-case")
      .embed(texts, metadata);
    const contents = await readFile(join(directory, "eval-replay-case.embedding.json"), "utf8");
    expect(contents).not.toContain(texts[0]);

    const replay = await createReplayEmbeddingProvider("voyage-test", 2, directory)
      .forCase("eval-replay-case")
      .embed(texts, metadata);
    expect(replay).toEqual({
      vectors: [[0.25, 0.75]],
      model: "voyage-test",
      usage: { inputTokens: 0 },
      latencyMs: 0,
      retryCount: 0,
    });
    expect(
      hashEmbeddingRequest({
        provider: "voyage",
        model: "voyage-test",
        dimensions: 2,
        inputType: "query",
        texts,
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
