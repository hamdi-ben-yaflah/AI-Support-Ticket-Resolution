import "server-only";

import { LlmError, isLlmError } from "@/ai/errors";
import {
  classifyTicketWithMetadata,
  type ClassificationExecution,
} from "@/ai/pipeline/classify-ticket";
import { validateGroundedReply } from "@/ai/pipeline/validate-grounding";
import {
  buildResolutionInput,
  RESOLUTION_PROMPT_VERSION,
  RESOLUTION_SYSTEM_PROMPT,
} from "@/ai/prompts/resolve.v1";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { GenerateRequest, LlmProvider } from "@/ai/types";
import { getAiConfig } from "@/config/ai";
import { ClassificationSchema, type Classification } from "@/domain/classification";
import {
  GroundedReplySchema,
  ResolutionProposalSchema,
  type GroundedReply,
} from "@/domain/grounded-reply";
import {
  ResolutionExecutionSchema,
  type ResolutionExecution,
} from "@/domain/resolution-run";
import type { TicketInput } from "@/domain/ticket";
import { createLogger, logger, type AppLogger } from "@/observability/logger";
import { createConfiguredEvidenceRetriever } from "@/retrieval/search";
import { RetrievalError } from "@/retrieval/errors";
import type { EvidenceRetriever, RetrievedEvidence } from "@/retrieval/types";

export type ResolutionContext = { traceId: string };

type Classifier = (
  input: TicketInput,
  context: ResolutionContext,
) => Promise<ClassificationExecution>;

type ResolveTicketOptions = ResolutionContext & {
  classifier: Classifier;
  retriever: EvidenceRetriever;
  provider: LlmProvider;
  log?: AppLogger;
};

export function createResolutionRequest(input: {
  ticket: TicketInput;
  classification: Classification;
  evidence: readonly RetrievedEvidence[];
  traceId: string;
}): GenerateRequest<GroundedReply> {
  return {
    task: "resolution",
    system: RESOLUTION_SYSTEM_PROMPT,
    input: buildResolutionInput(input),
    outputSchema: GroundedReplySchema,
    maxOutputTokens: 1_200,
    temperature: 0,
    metadata: {
      traceId: input.traceId,
      promptVersion: RESOLUTION_PROMPT_VERSION,
    },
  };
}

export async function resolveTicket(
  input: TicketInput,
  options: ResolveTicketOptions,
): Promise<ResolutionExecution> {
  const log = options.log ?? logger;
  const pipelineStartedAt = Date.now();
  const classified = await options.classifier(input, { traceId: options.traceId });
  const classification = ClassificationSchema.parse(classified.classification);
  const evidence = await options.retriever.retrieve({
    text: input.text,
    category: classification.category,
    traceId: options.traceId,
  });
  const startedAt = Date.now();

  try {
    const generated = await options.provider.generateStructured(
      createResolutionRequest({
        ticket: input,
        classification,
        evidence,
        traceId: options.traceId,
      }),
    );
    const groundedReply = validateGroundedReply(generated.value, evidence);
    const proposal = ResolutionProposalSchema.parse({
      ...classification,
      groundedReply,
    });
    const evidenceById = new Map(evidence.map((item) => [item.chunkId, item]));
    const citedSources = groundedReply.citations.map((citation, citationPosition) => {
      const source = evidenceById.get(citation.chunkId);
      if (!source) {
        throw new LlmError("invalid_output", "Citation provenance is unavailable.", {
          retryable: false,
        });
      }

      return {
        citationPosition,
        chunkId: source.chunkId,
        sourceId: source.sourceId,
        title: source.title,
        section: source.section,
        content: source.content,
      };
    });

    const execution = ResolutionExecutionSchema.parse({
      proposal,
      citedSources,
      metadata: {
        promptVersions: {
          classification: classified.metadata.promptVersion,
          resolution: RESOLUTION_PROMPT_VERSION,
        },
        provider: options.provider.name,
        model: generated.model,
        latencyMs: Math.max(0, Date.now() - pipelineStartedAt),
        inputTokens:
          classified.metadata.inputTokens + generated.usage.inputTokens,
        outputTokens:
          classified.metadata.outputTokens + generated.usage.outputTokens,
        retryCount: classified.metadata.retryCount + generated.retryCount,
        validationPassed: true,
      },
    });
    log.info({
      event: "model_call",
      traceId: options.traceId,
      task: "resolution",
      provider: options.provider.name,
      model: generated.model,
      promptVersion: RESOLUTION_PROMPT_VERSION,
      providerRequestId: generated.providerRequestId,
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens,
      cachedInputTokens: generated.usage.cachedInputTokens,
      latencyMs: generated.latencyMs,
      finishReason: generated.finishReason,
      validationPassed: true,
      retryCount: generated.retryCount,
      evidenceCount: evidence.length,
    });
    return execution;
  } catch (error) {
    const mapped = isLlmError(error)
      ? error
      : new LlmError("unexpected", "Grounded reply generation failed.", {
          retryable: false,
          cause: error,
        });
    log.error({
      event: "model_call",
      traceId: options.traceId,
      task: "resolution",
      provider: options.provider.name,
      model: options.provider.model,
      promptVersion: RESOLUTION_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      finishReason: mapped.finishReason ?? mapped.code,
      validationPassed: false,
      retryCount: mapped.retryCount,
      evidenceCount: evidence.length,
    });
    throw mapped;
  }
}

export async function resolveTicketWithConfiguredProviders(
  input: TicketInput,
  context: ResolutionContext,
): Promise<ResolutionExecution> {
  let config;
  try {
    config = getAiConfig();
  } catch (error) {
    throw new LlmError("configuration", "AI configuration is invalid.", {
      retryable: false,
      cause: error,
    });
  }
  const log = createLogger(config.logLevel);
  const provider = new AnthropicLlmProvider({
    apiKey: config.anthropicApiKey,
    model: config.model,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
  let retriever: EvidenceRetriever;
  try {
    retriever = createConfiguredEvidenceRetriever();
  } catch (error) {
    throw new RetrievalError("unavailable", "Knowledge retrieval is not configured.", {
      retryable: true,
      cause: error,
    });
  }

  return resolveTicket(input, {
    ...context,
    provider,
    retriever,
    classifier: (ticket, classificationContext) =>
      classifyTicketWithMetadata(ticket, {
        ...classificationContext,
        provider,
        log,
      }),
    log,
  });
}
