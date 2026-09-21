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
  llm: {
    classification: ScopedProvider<LlmProvider>;
    resolution: ScopedProvider<LlmProvider>;
    judge: ScopedProvider<LlmProvider>;
  };
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
      llm: {
        classification: createReplayLlmProvider(manifest.llm.models.classification),
        resolution: createReplayLlmProvider(manifest.llm.models.resolution),
        judge: createReplayLlmProvider(manifest.llm.models.judge),
      },
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
  const createLlm = (model: string) =>
    new AnthropicLlmProvider({
      apiKey: ai.anthropicApiKey,
      model,
      timeoutMs: ai.requestTimeoutMs,
      maxRetries: ai.maxRetries,
      promptCacheEnabled: ai.promptCacheEnabled,
    });
  const liveLlm = {
    classification: createLlm(ai.models.classification),
    resolution: createLlm(ai.models.resolution),
    judge: createLlm(ai.models.judge),
  };
  const pricing =
    new Set([liveLlm.classification.model, liveLlm.resolution.model, liveLlm.judge.model]).size ===
    1
      ? getEvaluationPricing()
      : null;
  const liveEmbeddings = new VoyageEmbeddingProvider({
    apiKey: embedding.apiKey,
    model: embedding.model,
    dimensions: embedding.dimensions,
    timeoutMs: embedding.requestTimeoutMs,
    maxRetries: embedding.maxRetries,
  });
  if (mode === "live") {
    return {
      llm: {
        classification: Object.assign(liveLlm.classification, {
          forCase: () => liveLlm.classification,
        }),
        resolution: Object.assign(liveLlm.resolution, { forCase: () => liveLlm.resolution }),
        judge: Object.assign(liveLlm.judge, { forCase: () => liveLlm.judge }),
      },
      embeddings: Object.assign(liveEmbeddings, { forCase: () => liveEmbeddings }),
      pricing,
      logLevel: ai.logLevel,
    };
  }

  return {
    llm: {
      classification: createRecordingLlmProvider(liveLlm.classification),
      resolution: createRecordingLlmProvider(liveLlm.resolution),
      judge: createRecordingLlmProvider(liveLlm.judge),
    },
    embeddings: createRecordingEmbeddingProvider(liveEmbeddings),
    pricing,
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
        schemaVersion: "cassette-manifest.v2",
        llm: {
          provider: "anthropic",
          models: {
            classification: providers.llm.classification.model,
            resolution: providers.llm.resolution.model,
            judge: providers.llm.judge.model,
          },
        },
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
        const classificationProvider = providers.llm.classification.forCase(goldenCase.id);
        const resolutionProvider = providers.llm.resolution.forCase(goldenCase.id);
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
          provider: resolutionProvider,
          retriever,
          policy: resolutionPolicy,
          classifier: (ticket, classificationContext) =>
            classifyTicketWithMetadata(ticket, {
              ...classificationContext,
              provider: classificationProvider,
              log,
            }),
          log,
        });
      },
      judge: (execution, traceId, goldenCase) =>
        judgeCitations({
          execution,
          provider: providers.llm.judge.forCase(goldenCase.id),
          traceId,
        }),
    };

    const report = await runEvaluation({
      dataset,
      concurrency,
      dependencies,
      runtime: {
        provider: providers.llm.resolution.name,
        models: {
          classification: providers.llm.classification.model,
          resolution: providers.llm.resolution.model,
          judge: providers.llm.judge.model,
        },
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
