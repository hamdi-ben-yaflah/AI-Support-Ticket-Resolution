import "server-only";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { EmbeddingProvider } from "@/embeddings/types";
import { parseKnowledgeDocument } from "@/ingestion/chunk-markdown";
import type { ParsedKnowledgeDocument } from "@/ingestion/types";

export type IngestionRepository = {
  getContentHashes(sourceIds: readonly string[]): Promise<Map<string, string>>;
  replaceDocument(input: {
    sourceId: string;
    title: string;
    contentHash: string;
    metadata: ParsedKnowledgeDocument["metadata"];
    chunks: Array<ParsedKnowledgeDocument["chunks"][number] & { embedding: number[] }>;
  }): Promise<void>;
};

export type IngestionSummary = {
  files: number;
  documents: number;
  chunks: number;
  skipped: number;
  updated: number;
};

export async function readKnowledgeBaseDirectory(
  directory: string,
): Promise<ParsedKnowledgeDocument[]> {
  const fileNames = (await readdir(directory))
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
  if (fileNames.length === 0) throw new Error("No Markdown knowledge documents found.");

  const documents = await Promise.all(
    fileNames.map(async (fileName) =>
      parseKnowledgeDocument(fileName, await readFile(join(directory, fileName), "utf8")),
    ),
  );
  const sourceIds = new Set<string>();
  for (const document of documents) {
    if (sourceIds.has(document.sourceId)) {
      throw new Error(`Duplicate knowledge source ID: ${document.sourceId}.`);
    }
    sourceIds.add(document.sourceId);
  }

  return documents;
}

async function embedDocument(
  document: ParsedKnowledgeDocument,
  embedder: EmbeddingProvider,
  batchSize: number,
  traceId: string,
) {
  const vectors: number[][] = [];
  for (let offset = 0; offset < document.chunks.length; offset += batchSize) {
    const batch = document.chunks.slice(offset, offset + batchSize);
    const result = await embedder.embed(
      batch.map((chunk) => chunk.content),
      { traceId, operation: "ingestion", inputType: "document" },
    );
    if (result.vectors.length !== batch.length) {
      throw new Error("Embedding batch returned the wrong vector count.");
    }
    for (const vector of result.vectors) {
      if (
        vector.length !== embedder.dimensions ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("Embedding batch returned an invalid vector.");
      }
      vectors.push(vector);
    }
  }

  return document.chunks.map((chunk, index) => ({
    ...chunk,
    embedding: vectors[index] as number[],
  }));
}

export async function ingestKnowledgeBase(input: {
  documents: readonly ParsedKnowledgeDocument[];
  repository: IngestionRepository;
  embedder: EmbeddingProvider;
  batchSize: number;
  traceId: string;
}): Promise<IngestionSummary> {
  const sourceIds = new Set<string>();
  for (const document of input.documents) {
    if (sourceIds.has(document.sourceId)) {
      throw new Error(`Duplicate knowledge source ID: ${document.sourceId}.`);
    }
    sourceIds.add(document.sourceId);
  }

  const existing = await input.repository.getContentHashes([...sourceIds]);
  let skipped = 0;
  let updated = 0;
  let chunks = 0;

  for (const document of input.documents) {
    if (existing.get(document.sourceId) === document.contentHash) {
      skipped += 1;
      continue;
    }

    const embeddedChunks = await embedDocument(
      document,
      input.embedder,
      input.batchSize,
      input.traceId,
    );
    await input.repository.replaceDocument({
      sourceId: document.sourceId,
      title: document.title,
      contentHash: document.contentHash,
      metadata: document.metadata,
      chunks: embeddedChunks,
    });
    updated += 1;
    chunks += embeddedChunks.length;
  }

  return {
    files: input.documents.length,
    documents: input.documents.length,
    chunks,
    skipped,
    updated,
  };
}
