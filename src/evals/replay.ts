import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { GenerateRequest, GenerateResult, LlmProvider } from "@/ai/types";
import type {
  EmbeddingProvider,
  EmbeddingRequestMetadata,
  EmbeddingResult,
} from "@/embeddings/types";

export const DEFAULT_CASSETTE_DIRECTORY = resolve(process.cwd(), "data/evals/cassettes");

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CaseIdSchema = z.string().regex(/^eval-[a-z0-9-]+$/);
const CassetteTaskSchema = z.enum(["classification", "resolution", "evaluation"]);

const LlmCassetteSchema = z
  .object({
    schemaVersion: z.literal("llm-cassette.v1"),
    caseId: CaseIdSchema,
    task: CassetteTaskSchema,
    requestHash: HashSchema,
    response: z
      .object({
        value: z.unknown(),
        model: z.string().trim().min(1),
        finishReason: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const EmbeddingCassetteSchema = z
  .object({
    schemaVersion: z.literal("embedding-cassette.v1"),
    caseId: CaseIdSchema.nullable(),
    operation: z.enum(["ingestion", "retrieval"]),
    requestHash: HashSchema,
    response: z
      .object({
        vectors: z.array(z.array(z.number().finite())).min(1),
        model: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const CassetteManifestSchema = z
  .object({
    schemaVersion: z.literal("cassette-manifest.v2"),
    llm: z
      .object({
        provider: z.literal("anthropic"),
        models: z
          .object({
            classification: z.string().trim().min(1),
            resolution: z.string().trim().min(1),
            judge: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
    embeddings: z
      .object({
        provider: z.literal("voyage"),
        model: z.string().trim().min(1),
        dimensions: z.number().int().positive(),
        batchSize: z.number().int().positive(),
      })
      .strict(),
    evaluation: z
      .object({
        retrieval: z
          .object({
            version: z.literal("retrieval.v1"),
            candidateCount: z.number().int().min(1).max(50),
            finalCount: z.number().int().min(1).max(8),
            minimumSimilarity: z.number().min(-1).max(1),
            maximumContextTokens: z.number().int().positive(),
            minimumEvidenceCount: z.number().int().min(1).max(8),
          })
          .strict(),
        resolutionPolicy: z
          .object({
            version: z.literal("resolution-policy.v1"),
            minimumConfidence: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const LegacyCassetteManifestSchema = z
  .object({
    schemaVersion: z.literal("cassette-manifest.v1"),
    llm: z.object({ provider: z.literal("anthropic"), model: z.string().trim().min(1) }).strict(),
    embeddings: CassetteManifestSchema.shape.embeddings,
    evaluation: CassetteManifestSchema.shape.evaluation,
  })
  .strict();

export type CassetteManifest = z.infer<typeof CassetteManifestSchema>;

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export function hashLlmRequest<T>(
  provider: string,
  model: string,
  request: GenerateRequest<T>,
): string {
  return sha256({
    provider,
    model,
    promptVersion: request.metadata.promptVersion,
    system: request.system,
    input: request.input,
    outputSchema: z.toJSONSchema(request.outputSchema),
  });
}

export function hashEmbeddingRequest(input: {
  provider: string;
  model: string;
  dimensions: number;
  inputType: EmbeddingRequestMetadata["inputType"];
  texts: readonly string[];
}): string {
  return sha256(input);
}

export class CassetteMissError extends Error {
  readonly code = "cassette_miss";

  constructor(
    readonly caseId: string,
    readonly requestHash: string,
  ) {
    super(`Cassette miss for ${caseId} (${requestHash}).`);
    this.name = "CassetteMissError";
  }
}

export function isCassetteMissError(error: unknown): error is CassetteMissError {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof CassetteMissError) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

function llmPath(directory: string, caseId: string, task: string): string {
  return join(directory, `${caseId}.${task}.json`);
}

function embeddingPath(
  directory: string,
  caseId: string | undefined,
  operation: EmbeddingRequestMetadata["operation"],
  hash: string,
): string {
  return operation === "retrieval" && caseId
    ? join(directory, `${caseId}.embedding.json`)
    : join(directory, `ingestion.${hash}.embedding.json`);
}

export async function loadCassetteManifest(
  directory = DEFAULT_CASSETTE_DIRECTORY,
): Promise<CassetteManifest> {
  const raw = await readJson(join(directory, "manifest.json"));
  const current = CassetteManifestSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = LegacyCassetteManifestSchema.parse(raw);
  return CassetteManifestSchema.parse({
    ...legacy,
    schemaVersion: "cassette-manifest.v2",
    llm: {
      provider: legacy.llm.provider,
      models: {
        classification: legacy.llm.model,
        resolution: legacy.llm.model,
        judge: legacy.llm.model,
      },
    },
  });
}

export async function writeCassetteManifest(
  manifest: CassetteManifest,
  directory = DEFAULT_CASSETTE_DIRECTORY,
): Promise<void> {
  await writeJsonAtomically(
    join(directory, "manifest.json"),
    CassetteManifestSchema.parse(manifest),
  );
}

export type ScopedProvider<T> = T & { forCase(caseId: string): T };

class RecordingLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly live: LlmProvider,
    private readonly directory: string,
    private readonly caseId: string,
  ) {
    this.name = live.name;
    this.model = live.model;
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const result = await this.live.generateStructured(request);
    const requestHash = hashLlmRequest(this.name, this.model, request);
    await writeJsonAtomically(llmPath(this.directory, this.caseId, request.task), {
      schemaVersion: "llm-cassette.v1",
      caseId: this.caseId,
      task: request.task,
      requestHash,
      response: {
        value: result.value,
        model: result.model,
        finishReason: result.finishReason,
      },
    });
    return result;
  }
}

export function createRecordingLlmProvider(
  live: LlmProvider,
  directory = DEFAULT_CASSETTE_DIRECTORY,
): ScopedProvider<LlmProvider> {
  const create = (caseId: string): ScopedProvider<LlmProvider> =>
    Object.assign(new RecordingLlmProvider(live, directory, CaseIdSchema.parse(caseId)), {
      forCase: create,
    });
  return create("eval-unscoped");
}

class ReplayLlmProvider implements LlmProvider {
  readonly name = "anthropic";

  constructor(
    readonly model: string,
    private readonly directory: string,
    private readonly caseId: string,
  ) {}

  async generateStructured<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const requestHash = hashLlmRequest(this.name, this.model, request);
    let cassette;
    try {
      cassette = LlmCassetteSchema.parse(
        await readJson(llmPath(this.directory, this.caseId, request.task)),
      );
    } catch {
      throw new CassetteMissError(this.caseId, requestHash);
    }
    if (
      cassette.caseId !== this.caseId ||
      cassette.task !== request.task ||
      cassette.requestHash !== requestHash
    ) {
      throw new CassetteMissError(this.caseId, requestHash);
    }
    const value = request.outputSchema.safeParse(cassette.response.value);
    if (!value.success) throw new CassetteMissError(this.caseId, requestHash);

    return {
      value: value.data,
      model: cassette.response.model,
      finishReason: cassette.response.finishReason,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      retryCount: 0,
    };
  }
}

export function createReplayLlmProvider(
  model: string,
  directory = DEFAULT_CASSETTE_DIRECTORY,
): ScopedProvider<LlmProvider> {
  const create = (caseId: string): ScopedProvider<LlmProvider> =>
    Object.assign(new ReplayLlmProvider(model, directory, CaseIdSchema.parse(caseId)), {
      forCase: create,
    });
  return create("eval-unscoped");
}

class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly live: EmbeddingProvider,
    private readonly directory: string,
    private readonly caseId?: string,
  ) {
    this.name = live.name;
    this.model = live.model;
    this.dimensions = live.dimensions;
  }

  async embed(
    texts: readonly string[],
    metadata: EmbeddingRequestMetadata,
  ): Promise<EmbeddingResult> {
    const result = await this.live.embed(texts, metadata);
    const requestHash = hashEmbeddingRequest({
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
      inputType: metadata.inputType,
      texts,
    });
    await writeJsonAtomically(
      embeddingPath(this.directory, this.caseId, metadata.operation, requestHash),
      {
        schemaVersion: "embedding-cassette.v1",
        caseId: this.caseId ?? null,
        operation: metadata.operation,
        requestHash,
        response: { vectors: result.vectors, model: result.model },
      },
    );
    return result;
  }
}

export function createRecordingEmbeddingProvider(
  live: EmbeddingProvider,
  directory = DEFAULT_CASSETTE_DIRECTORY,
): ScopedProvider<EmbeddingProvider> {
  const create = (caseId: string): ScopedProvider<EmbeddingProvider> =>
    Object.assign(new RecordingEmbeddingProvider(live, directory, CaseIdSchema.parse(caseId)), {
      forCase: create,
    });
  return Object.assign(new RecordingEmbeddingProvider(live, directory), { forCase: create });
}

class ReplayEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";

  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly directory: string,
    private readonly caseId?: string,
  ) {}

  async embed(
    texts: readonly string[],
    metadata: EmbeddingRequestMetadata,
  ): Promise<EmbeddingResult> {
    const requestHash = hashEmbeddingRequest({
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
      inputType: metadata.inputType,
      texts,
    });
    const displayCaseId = this.caseId ?? "knowledge-ingestion";
    let cassette;
    try {
      cassette = EmbeddingCassetteSchema.parse(
        await readJson(embeddingPath(this.directory, this.caseId, metadata.operation, requestHash)),
      );
    } catch {
      throw new CassetteMissError(displayCaseId, requestHash);
    }
    if (
      cassette.requestHash !== requestHash ||
      cassette.operation !== metadata.operation ||
      cassette.caseId !== (this.caseId ?? null) ||
      cassette.response.vectors.length !== texts.length ||
      cassette.response.vectors.some((vector) => vector.length !== this.dimensions)
    ) {
      throw new CassetteMissError(displayCaseId, requestHash);
    }
    return {
      vectors: cassette.response.vectors,
      model: cassette.response.model,
      usage: { inputTokens: 0 },
      latencyMs: 0,
      retryCount: 0,
    };
  }
}

export function createReplayEmbeddingProvider(
  model: string,
  dimensions: number,
  directory = DEFAULT_CASSETTE_DIRECTORY,
): ScopedProvider<EmbeddingProvider> {
  const create = (caseId: string): ScopedProvider<EmbeddingProvider> =>
    Object.assign(
      new ReplayEmbeddingProvider(model, dimensions, directory, CaseIdSchema.parse(caseId)),
      { forCase: create },
    );
  return Object.assign(new ReplayEmbeddingProvider(model, dimensions, directory), {
    forCase: create,
  });
}
