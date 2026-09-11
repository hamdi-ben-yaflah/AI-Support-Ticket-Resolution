import "server-only";

import { getEmbeddingConfig } from "@/config/embedding";
import { getRetrievalConfig, type RetrievalConfig } from "@/config/retrieval";
import { searchDocumentChunks } from "@/db/knowledge";
import { VoyageEmbeddingProvider } from "@/embeddings/providers/voyage";
import type { EmbeddingProvider } from "@/embeddings/types";
import { logger, type AppLogger } from "@/observability/logger";
import { RetrievalError, isRetrievalError } from "@/retrieval/errors";
import {
  RetrievalCandidateSchema,
  type EvidenceRetriever,
  type RetrievalCandidate,
  type RetrievedEvidence,
} from "@/retrieval/types";

type CandidateSearch = (input: {
  embedding: number[];
  category?: string;
  limit: number;
}) => Promise<RetrievalCandidate[]>;

type RetrieveOptions = {
  embedder: EmbeddingProvider;
  search: CandidateSearch;
  config: RetrievalConfig;
  log?: AppLogger;
};

function eligibleCandidates(
  candidates: readonly RetrievalCandidate[],
  minimumSimilarity: number,
): RetrievalCandidate[] {
  const unique = new Map<string, RetrievalCandidate>();
  for (const raw of candidates) {
    const candidate = RetrievalCandidateSchema.parse(raw);
    if (candidate.similarity < minimumSimilarity) continue;
    const existing = unique.get(candidate.chunkId);
    if (!existing || existing.similarity < candidate.similarity) {
      unique.set(candidate.chunkId, candidate);
    }
  }

  return [...unique.values()].sort(
    (left, right) =>
      right.similarity - left.similarity || left.chunkId.localeCompare(right.chunkId),
  );
}

export function selectEvidence(
  candidates: readonly RetrievalCandidate[],
  config: RetrievalConfig,
): RetrievedEvidence[] {
  const selected: RetrievedEvidence[] = [];
  let usedTokens = 0;

  for (const candidate of eligibleCandidates(candidates, config.minimumSimilarity)) {
    if (selected.length >= config.finalCount) break;
    if (usedTokens + candidate.tokenCount > config.maximumContextTokens) continue;
    selected.push({
      chunkId: candidate.chunkId,
      sourceId: candidate.metadata.sourceId,
      title: candidate.title,
      section: candidate.section,
      content: candidate.content,
      tokenCount: candidate.tokenCount,
      similarity: candidate.similarity,
    });
    usedTokens += candidate.tokenCount;
  }

  return selected;
}

export async function retrieveEvidence(
  input: { text: string; category: string; traceId: string },
  options: RetrieveOptions,
): Promise<RetrievedEvidence[]> {
  const log = options.log ?? logger;
  const startedAt = Date.now();
  let fallbackUsed = false;

  try {
    const embedded = await options.embedder.embed([input.text], {
      traceId: input.traceId,
      operation: "retrieval",
      inputType: "query",
    });
    const queryEmbedding = embedded.vectors[0];
    if (!queryEmbedding) throw new Error("Embedding provider returned no query vector.");

    const categoryCandidates = await options.search({
      embedding: queryEmbedding,
      category: input.category,
      limit: options.config.candidateCount,
    });
    let candidates = categoryCandidates;
    if (
      eligibleCandidates(categoryCandidates, options.config.minimumSimilarity).length <
      options.config.minimumEvidenceCount
    ) {
      fallbackUsed = true;
      candidates = [
        ...categoryCandidates,
        ...(await options.search({
          embedding: queryEmbedding,
          limit: options.config.candidateCount,
        })),
      ];
    }

    const selected = selectEvidence(candidates, options.config);
    log.info({
      event: "retrieval_completed",
      traceId: input.traceId,
      retrievalVersion: options.config.version,
      categoryFilter: input.category,
      fallbackUsed,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      minimumSimilarity: options.config.minimumSimilarity,
      maximumContextTokens: options.config.maximumContextTokens,
      similarities: selected.map((item) => Number(item.similarity.toFixed(4))),
      latencyMs: Math.max(0, Date.now() - startedAt),
    });

    if (selected.length < options.config.minimumEvidenceCount) {
      throw new RetrievalError(
        "insufficient_evidence",
        "No adequate knowledge-base evidence was found.",
        { retryable: false },
      );
    }

    return selected;
  } catch (error) {
    if (isRetrievalError(error)) throw error;
    log.error({
      event: "retrieval_failed",
      traceId: input.traceId,
      retrievalVersion: options.config.version,
      categoryFilter: input.category,
      fallbackUsed,
      latencyMs: Math.max(0, Date.now() - startedAt),
    });
    throw new RetrievalError("unavailable", "Knowledge retrieval is unavailable.", {
      retryable: true,
      cause: error,
    });
  }
}

export function createConfiguredEvidenceRetriever(): EvidenceRetriever {
  const embedding = getEmbeddingConfig();
  const embedder = new VoyageEmbeddingProvider({
    apiKey: embedding.apiKey,
    model: embedding.model,
    dimensions: embedding.dimensions,
    timeoutMs: embedding.requestTimeoutMs,
    maxRetries: embedding.maxRetries,
  });
  const config = getRetrievalConfig();

  return {
    retrieve: (input) =>
      retrieveEvidence(input, { embedder, search: searchDocumentChunks, config }),
  };
}
