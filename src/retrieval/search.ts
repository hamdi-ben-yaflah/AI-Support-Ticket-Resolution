import "server-only";

import { getEmbeddingConfig } from "@/config/embedding";
import { getRetrievalConfig, type RetrievalConfig } from "@/config/retrieval";
import { searchDocumentChunks } from "@/db/knowledge";
import { VoyageEmbeddingProvider } from "@/embeddings/providers/voyage";
import type { EmbeddingProvider } from "@/embeddings/types";
import { logger, type AppLogger } from "@/observability/logger";
import { tracing, withTraceCorrelation, type AppTracing } from "@/observability/tracing";
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
  tracing?: AppTracing;
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
  const appTracing = options.tracing ?? tracing;
  const startedAt = Date.now();
  return appTracing.withSpan(
    "support.retrieval",
    {
      attributes: {
        "support.trace_id": input.traceId,
        "support.operation": "evidence_retrieval",
        "support.retrieval.version": options.config.version,
        "support.retrieval.category_filter": input.category,
        "support.retrieval.minimum_similarity": options.config.minimumSimilarity,
        "support.retrieval.maximum_context_tokens": options.config.maximumContextTokens,
      },
    },
    async (retrievalSpan) => {
      let fallbackUsed = false;
      try {
        const embedded = await appTracing.withSpan(
          "support.embedding.query",
          {
            attributes: {
              "support.trace_id": input.traceId,
              "support.operation": "retrieval",
              "support.embedding.input_type": "query",
              "support.embedding.input_count": 1,
              "support.embedding.dimensions": options.embedder.dimensions,
              "gen_ai.provider.name": options.embedder.name,
              "gen_ai.request.model": options.embedder.model,
            },
          },
          async (span) => {
            try {
              const result = await options.embedder.embed([input.text], {
                traceId: input.traceId,
                operation: "retrieval",
                inputType: "query",
              });
              span.setAttributes({
                "gen_ai.response.model": result.model,
                "support.embedding.token_count": result.usage.inputTokens,
                "support.duration_ms": result.latencyMs,
                "support.retry_count": result.retryCount,
                "support.validation.passed": true,
                "support.outcome": "completed",
              });
              return result;
            } catch (error) {
              span.setAttributes({
                "support.validation.passed": false,
                "support.outcome": "failed",
              });
              span.fail("unavailable");
              throw error;
            }
          },
        );
        const queryEmbedding = embedded.vectors[0];
        if (!queryEmbedding) throw new Error("Embedding provider returned no query vector.");

        const candidates = await appTracing.withSpan(
          "support.vector_search",
          {
            attributes: {
              "support.trace_id": input.traceId,
              "support.operation": "cosine_similarity_search",
              "support.retrieval.category_filter": input.category,
            },
          },
          async (span) => {
            try {
              const categoryCandidates = await options.search({
                embedding: queryEmbedding,
                category: input.category,
                limit: options.config.candidateCount,
              });
              let found = categoryCandidates;
              if (
                eligibleCandidates(categoryCandidates, options.config.minimumSimilarity).length <
                options.config.minimumEvidenceCount
              ) {
                fallbackUsed = true;
                found = [
                  ...categoryCandidates,
                  ...(await options.search({
                    embedding: queryEmbedding,
                    limit: options.config.candidateCount,
                  })),
                ];
              }
              span.setAttributes({
                "support.retrieval.fallback_used": fallbackUsed,
                "support.retrieval.candidate_count": found.length,
                "support.outcome": "completed",
              });
              return found;
            } catch (error) {
              span.setAttributes({ "support.outcome": "failed" });
              span.fail("retrieval_unavailable");
              throw error;
            }
          },
        );

        const selected = selectEvidence(candidates, options.config);
        const similarities = selected.map((item) => Number(item.similarity.toFixed(4)));
        retrievalSpan.setAttributes({
          "support.retrieval.fallback_used": fallbackUsed,
          "support.retrieval.candidate_count": candidates.length,
          "support.retrieval.selected_count": selected.length,
          "support.retrieval.context_token_count": selected.reduce(
            (total, item) => total + item.tokenCount,
            0,
          ),
          "support.retrieval.similarities": similarities,
          "support.duration_ms": Math.max(0, Date.now() - startedAt),
        });
        log.info(
          withTraceCorrelation(
            {
              event: "retrieval_completed",
              traceId: input.traceId,
              retrievalVersion: options.config.version,
              categoryFilter: input.category,
              fallbackUsed,
              candidateCount: candidates.length,
              selectedCount: selected.length,
              minimumSimilarity: options.config.minimumSimilarity,
              maximumContextTokens: options.config.maximumContextTokens,
              similarities,
              latencyMs: Math.max(0, Date.now() - startedAt),
            },
            appTracing,
          ),
        );

        if (selected.length < options.config.minimumEvidenceCount) {
          retrievalSpan.setAttributes({
            "support.outcome": "abstained",
            "support.abstention.reason_code": "insufficient_evidence",
          });
          throw new RetrievalError(
            "insufficient_evidence",
            "No adequate knowledge-base evidence was found.",
            { retryable: false },
          );
        }

        retrievalSpan.setAttributes({ "support.outcome": "completed" });
        return selected;
      } catch (error) {
        if (isRetrievalError(error)) throw error;
        retrievalSpan.setAttributes({
          "support.retrieval.fallback_used": fallbackUsed,
          "support.duration_ms": Math.max(0, Date.now() - startedAt),
          "support.outcome": "failed",
        });
        retrievalSpan.fail("retrieval_unavailable");
        log.error(
          withTraceCorrelation(
            {
              event: "retrieval_failed",
              traceId: input.traceId,
              retrievalVersion: options.config.version,
              categoryFilter: input.category,
              fallbackUsed,
              latencyMs: Math.max(0, Date.now() - startedAt),
            },
            appTracing,
          ),
        );
        throw new RetrievalError("unavailable", "Knowledge retrieval is unavailable.", {
          retryable: true,
          cause: error,
        });
      }
    },
  );
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
