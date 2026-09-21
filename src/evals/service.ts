import "server-only";

import { classifyTicketWithMetadata } from "@/ai/pipeline/classify-ticket";
import { resolveTicket } from "@/ai/pipeline/resolve-ticket";
import { CLASSIFICATION_PROMPT_VERSION } from "@/ai/prompts/classify.v1";
import { RESOLUTION_PROMPT_VERSION } from "@/ai/prompts/resolve.v4";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { LlmProvider } from "@/ai/types";
import { getAiConfig } from "@/config/ai";
import { getEmbeddingConfig } from "@/config/embedding";
import { getEvaluationPricing, type EvaluationPricing } from "@/config/evaluation";
import { getResolutionPolicy } from "@/config/resolution";
import { getRetrievalConfig, type RetrievalConfig } from "@/config/retrieval";
import { persistEvaluationReport } from "@/db/evaluation-runs";
import { searchDocumentChunks } from "@/db/knowledge";
import { VoyageEmbeddingProvider } from "@/embeddings/providers/voyage";
import type { EmbeddingProvider } from "@/embeddings/types";
import { loadGoldenDataset } from "@/evals/dataset";
import { EvaluationSetupError } from "@/evals/errors";
import { judgeCitations } from "@/evals/judge";
import {
  createRecordingEmbeddingProvider,
  createRecordingLlmProvider,
  createReplayEmbeddingProvider,
  createReplayLlmProvider,
  isCassetteMissError,
  loadCassetteManifest,
  writeCassetteManifest,
  type ScopedProvider,
} from "@/evals/replay";
import { runEvaluation, type EvaluationDependencies } from "@/evals/runner";
import { createLogger } from "@/observability/logger";
import { retrieveEvidence } from "@/retrieval/search";

export type EvaluationMode = "live" | "record" | "replay";

type EvaluationProviders = {
  llm: ScopedProvider<LlmProvider>;
  embeddings: ScopedProvider<EmbeddingProvider>;
  pricing: EvaluationPricing;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  replayConfig?: {
    retrieval: RetrievalConfig;
    resolutionPolicy: ReturnType<typeof getResolutionPolicy>;
  };
};

async function createProviders(mode: EvaluationMode): Promise<EvaluationProviders> {
  if (mode === "replay") {
    const manifest = await loadCassetteManifest();
    return {
      llm: createReplayLlmProvider(manifest.llm.model),
      embeddings: createReplayEmbeddingProvider(
        manifest.embeddings.model,
        manifest.embeddings.dimensions,
      ),
      pricing: null,
      logLevel: "info",
      replayConfig: manifest.evaluation,
    };
  }

  const ai = getAiConfig();
  const embedding = getEmbeddingConfig();
  const liveLlm = new AnthropicLlmProvider({
    apiKey: ai.anthropicApiKey,
    model: ai.model,
    timeoutMs: ai.requestTimeoutMs,
    maxRetries: ai.maxRetries,
    promptCacheEnabled: ai.promptCacheEnabled,
  });
  const liveEmbeddings = new VoyageEmbeddingProvider({
    apiKey: embedding.apiKey,
    model: embedding.model,
    dimensions: embedding.dimensions,
    timeoutMs: embedding.requestTimeoutMs,
    maxRetries: embedding.maxRetries,
  });
  if (mode === "live") {
    return {
      llm: Object.assign(liveLlm, { forCase: () => liveLlm }),
      embeddings: Object.assign(liveEmbeddings, { forCase: () => liveEmbeddings }),
      pricing: getEvaluationPricing(),
      logLevel: ai.logLevel,
    };
  }

  return {
    llm: createRecordingLlmProvider(liveLlm),
    embeddings: createRecordingEmbeddingProvider(liveEmbeddings),
    pricing: getEvaluationPricing(),
    logLevel: ai.logLevel,
  };
}

export async function runConfiguredEvaluation(concurrency = 3, mode: EvaluationMode = "live") {
  try {
    const [dataset, providers, configuredRetrieval, configuredResolutionPolicy] = await Promise.all(
      [
        loadGoldenDataset(),
        createProviders(mode),
        Promise.resolve(getRetrievalConfig()),
        Promise.resolve(getResolutionPolicy()),
      ],
    );
    const retrievalConfig = providers.replayConfig?.retrieval ?? configuredRetrieval;
    const resolutionPolicy = providers.replayConfig?.resolutionPolicy ?? configuredResolutionPolicy;
    if (mode === "record") {
      const embedding = getEmbeddingConfig();
      await writeCassetteManifest({
        schemaVersion: "cassette-manifest.v1",
        llm: { provider: "anthropic", model: providers.llm.model },
        embeddings: {
          provider: "voyage",
          model: embedding.model,
          dimensions: embedding.dimensions,
          batchSize: embedding.batchSize,
        },
        evaluation: { retrieval: retrievalConfig, resolutionPolicy },
      });
    }
    const log = createLogger(providers.logLevel);
    const dependencies: EvaluationDependencies = {
      execute: (goldenCase, context) => {
        const provider = providers.llm.forCase(goldenCase.id);
        const embedder = providers.embeddings.forCase(goldenCase.id);
        const retriever = {
          retrieve: async (retrievalInput: Parameters<typeof retrieveEvidence>[0]) => {
            const evidence = await retrieveEvidence(retrievalInput, {
              embedder,
              search: searchDocumentChunks,
              config: retrievalConfig,
              log,
            });
            context.recordRetrieved(evidence);
            return evidence;
          },
        };
        return resolveTicket(goldenCase.ticket, {
          traceId: context.traceId,
          provider,
          retriever,
          policy: resolutionPolicy,
          classifier: (ticket, classificationContext) =>
            classifyTicketWithMetadata(ticket, {
              ...classificationContext,
              provider,
              log,
            }),
          log,
        });
      },
      judge: (execution, traceId, goldenCase) =>
        judgeCitations({
          execution,
          provider: providers.llm.forCase(goldenCase.id),
          traceId,
        }),
    };

    const report = await runEvaluation({
      dataset,
      concurrency,
      dependencies,
      runtime: {
        provider: providers.llm.name,
        model: providers.llm.model,
        promptVersions: {
          classification: CLASSIFICATION_PROMPT_VERSION,
          resolution: RESOLUTION_PROMPT_VERSION,
        },
        retrieval: {
          version: retrievalConfig.version,
          candidateCount: retrievalConfig.candidateCount,
          finalCount: retrievalConfig.finalCount,
          minimumSimilarity: retrievalConfig.minimumSimilarity,
          maximumContextTokens: retrievalConfig.maximumContextTokens,
          minimumEvidenceCount: retrievalConfig.minimumEvidenceCount,
        },
        resolutionPolicy,
        pricing: providers.pricing,
      },
    });
    await persistEvaluationReport(report);
    return report;
  } catch (error) {
    if (isCassetteMissError(error) || error instanceof EvaluationSetupError) throw error;
    if (error instanceof Error && error.message.toLowerCase().includes("configuration")) {
      throw new EvaluationSetupError(
        "configuration",
        "Evaluation configuration is invalid or incomplete.",
        error,
      );
    }
    throw new EvaluationSetupError("unexpected", "The evaluation could not start.", error);
  }
}
