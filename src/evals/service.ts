import "server-only";

import { classifyTicketWithMetadata } from "@/ai/pipeline/classify-ticket";
import { resolveTicket } from "@/ai/pipeline/resolve-ticket";
import { CLASSIFICATION_PROMPT_VERSION } from "@/ai/prompts/classify.v1";
import { RESOLUTION_PROMPT_VERSION } from "@/ai/prompts/resolve.v4";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import { getAiConfig } from "@/config/ai";
import { getEvaluationPricing } from "@/config/evaluation";
import { getResolutionPolicy } from "@/config/resolution";
import { getRetrievalConfig } from "@/config/retrieval";
import { persistEvaluationReport } from "@/db/evaluation-runs";
import { loadGoldenDataset } from "@/evals/dataset";
import { EvaluationSetupError } from "@/evals/errors";
import { judgeCitations } from "@/evals/judge";
import { runEvaluation, type EvaluationDependencies } from "@/evals/runner";
import { createLogger } from "@/observability/logger";
import { createConfiguredEvidenceRetriever } from "@/retrieval/search";

export async function runConfiguredEvaluation(concurrency = 3) {
  try {
    const [dataset, aiConfig, retrievalConfig, resolutionPolicy, pricing] =
      await Promise.all([
        loadGoldenDataset(),
        Promise.resolve(getAiConfig()),
        Promise.resolve(getRetrievalConfig()),
        Promise.resolve(getResolutionPolicy()),
        Promise.resolve(getEvaluationPricing()),
      ]);
    const provider = new AnthropicLlmProvider({
      apiKey: aiConfig.anthropicApiKey,
      model: aiConfig.model,
      timeoutMs: aiConfig.requestTimeoutMs,
      maxRetries: aiConfig.maxRetries,
    });
    const retriever = createConfiguredEvidenceRetriever();
    const log = createLogger(aiConfig.logLevel);
    const dependencies: EvaluationDependencies = {
      execute: (goldenCase, context) => {
        const recordingRetriever = {
          retrieve: async (retrievalInput: Parameters<typeof retriever.retrieve>[0]) => {
            const evidence = await retriever.retrieve(retrievalInput);
            context.recordRetrieved(evidence);
            return evidence;
          },
        };
        return resolveTicket(goldenCase.ticket, {
          traceId: context.traceId,
          provider,
          retriever: recordingRetriever,
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
      judge: (execution, traceId) => judgeCitations({ execution, provider, traceId }),
    };

    const report = await runEvaluation({
      dataset,
      concurrency,
      dependencies,
      runtime: {
        provider: provider.name,
        model: provider.model,
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
        pricing,
      },
    });
    await persistEvaluationReport(report);
    return report;
  } catch (error) {
    if (error instanceof EvaluationSetupError) throw error;
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
