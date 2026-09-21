import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

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
} from "@/ai/prompts/resolve.v4";
import { AnthropicLlmProvider } from "@/ai/providers/anthropic";
import type { GenerateRequest, GenerateResult, LlmProvider } from "@/ai/types";
import { getAiConfig } from "@/config/ai";
import { getResolutionPolicy, type ResolutionPolicy } from "@/config/resolution";
import { ClassificationSchema, type Classification } from "@/domain/classification";
import {
  GroundedReplySchema,
  ResolutionProposalSchema,
  ResolutionReasonSchema,
  type GroundedReply,
} from "@/domain/grounded-reply";
import { RequestRefundReviewArgsSchema } from "@/domain/refund-review";
import {
  ResolutionExecutionSchema,
  type ResolutionExecution,
  type ResolutionRunMetadata,
} from "@/domain/resolution-run";
import type { TicketInput } from "@/domain/ticket";
import { createLogger, logger, type AppLogger } from "@/observability/logger";
import { tracing, withTraceCorrelation, type AppTracing } from "@/observability/tracing";
import { isRetrievalError, RetrievalError } from "@/retrieval/errors";
import { createConfiguredEvidenceRetriever } from "@/retrieval/search";
import type { EvidenceRetriever, RetrievedEvidence } from "@/retrieval/types";

const ResolutionDecisionSchema = z
  .object({
    action: z.enum(["reply", "request_refund_review", "needs_human_review"]),
    reason: ResolutionReasonSchema,
    groundedReply: GroundedReplySchema.nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      (decision.action === "reply" || decision.action === "request_refund_review") &&
      decision.groundedReply === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["groundedReply"],
        message: "Reply decisions require a grounded reply.",
      });
    }
    if (decision.action === "needs_human_review" && decision.groundedReply !== null) {
      context.addIssue({
        code: "custom",
        path: ["groundedReply"],
        message: "Human-review decisions cannot include a grounded reply.",
      });
    }
  });

type ResolutionDecision = z.infer<typeof ResolutionDecisionSchema>;

export type ResolutionContext = { traceId: string };

type Classifier = (
  input: TicketInput,
  context: ResolutionContext,
) => Promise<ClassificationExecution>;

type ResolveTicketOptions = ResolutionContext & {
  classifier: Classifier;
  retriever: EvidenceRetriever;
  provider: LlmProvider;
  policy: ResolutionPolicy;
  createProposalId?: () => string;
  log?: AppLogger;
  tracing?: AppTracing;
};

const LOW_CONFIDENCE_REASON = "Classification confidence is below the safe automation threshold.";
const INSUFFICIENT_EVIDENCE_REASON =
  "The knowledge base does not contain enough evidence for a safe reply.";

function createExecutionMetadata(input: {
  classified: ClassificationExecution;
  policy: ResolutionPolicy;
  pipelineStartedAt: number;
  generated?: GenerateResult<ResolutionDecision>;
  resolutionProvider?: LlmProvider;
  resolutionModel?: string;
}): ResolutionRunMetadata {
  const generated = input.generated;
  const classificationModel = input.classified.metadata.model;
  const resolutionModel =
    generated?.model ??
    input.resolutionProvider?.model ??
    input.resolutionModel ??
    classificationModel;
  return {
    promptVersions: {
      classification: input.classified.metadata.promptVersion,
      resolution: RESOLUTION_PROMPT_VERSION,
    },
    resolutionPolicy: input.policy,
    provider: generated
      ? (input.resolutionProvider?.name ?? input.classified.metadata.provider)
      : input.classified.metadata.provider,
    models: {
      classification: classificationModel,
      resolution: resolutionModel,
    },
    ...(classificationModel === resolutionModel ? { model: classificationModel } : {}),
    taskUsage: {
      classification: {
        inputTokens: input.classified.metadata.inputTokens,
        outputTokens: input.classified.metadata.outputTokens,
        cachedInputTokens: input.classified.metadata.cachedInputTokens,
        cacheWriteInputTokens: input.classified.metadata.cacheWriteInputTokens,
      },
      resolution: {
        inputTokens: generated?.usage.inputTokens ?? 0,
        outputTokens: generated?.usage.outputTokens ?? 0,
        cachedInputTokens: generated?.usage.cachedInputTokens ?? 0,
        cacheWriteInputTokens: generated?.usage.cacheWriteInputTokens ?? 0,
      },
    },
    latencyMs: Math.max(0, Date.now() - input.pipelineStartedAt),
    inputTokens: input.classified.metadata.inputTokens + (generated?.usage.inputTokens ?? 0),
    outputTokens: input.classified.metadata.outputTokens + (generated?.usage.outputTokens ?? 0),
    cachedInputTokens:
      input.classified.metadata.cachedInputTokens + (generated?.usage.cachedInputTokens ?? 0),
    cacheWriteInputTokens:
      input.classified.metadata.cacheWriteInputTokens +
      (generated?.usage.cacheWriteInputTokens ?? 0),
    retryCount: input.classified.metadata.retryCount + (generated?.retryCount ?? 0),
    validationPassed: true,
  };
}

export function createResolutionRequest(input: {
  ticket: TicketInput;
  classification: Classification;
  evidence: readonly RetrievedEvidence[];
  traceId: string;
}): GenerateRequest<ResolutionDecision> {
  return {
    task: "resolution",
    system: RESOLUTION_SYSTEM_PROMPT,
    input: buildResolutionInput(input),
    outputSchema: ResolutionDecisionSchema,
    maxOutputTokens: 1_200,
    temperature: 0,
    cacheableSystemPrompt: true,
    metadata: {
      traceId: input.traceId,
      promptVersion: RESOLUTION_PROMPT_VERSION,
    },
  };
}

function abstain(input: {
  classification: Classification;
  classified: ClassificationExecution;
  policy: ResolutionPolicy;
  reason: string;
  pipelineStartedAt: number;
  resolutionModel: string;
}): ResolutionExecution {
  const proposal = ResolutionProposalSchema.parse({
    ...input.classification,
    action: "needs_human_review",
    reason: input.reason,
  });

  return ResolutionExecutionSchema.parse({
    proposal,
    citedSources: [],
    metadata: createExecutionMetadata(input),
  });
}

function createCitedSources(
  groundedReply: GroundedReply,
  evidence: readonly RetrievedEvidence[],
): ResolutionExecution["citedSources"] {
  const evidenceById = new Map(evidence.map((item) => [item.chunkId, item]));
  return groundedReply.citations.map((citation, citationPosition) => {
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
}

function createGeneratedExecution(input: {
  classification: Classification;
  classified: ClassificationExecution;
  decision: ResolutionDecision;
  generated: GenerateResult<ResolutionDecision>;
  evidence: readonly RetrievedEvidence[];
  policy: ResolutionPolicy;
  provider: LlmProvider;
  pipelineStartedAt: number;
  createProposalId: () => string;
}): ResolutionExecution {
  const metadata = createExecutionMetadata({
    classified: input.classified,
    policy: input.policy,
    pipelineStartedAt: input.pipelineStartedAt,
    generated: input.generated,
    resolutionProvider: input.provider,
  });

  if (input.decision.action === "needs_human_review") {
    return ResolutionExecutionSchema.parse({
      proposal: ResolutionProposalSchema.parse({
        ...input.classification,
        action: input.decision.action,
        reason: input.decision.reason,
      }),
      citedSources: [],
      metadata,
    });
  }

  if (input.decision.groundedReply === null) {
    throw new LlmError("invalid_output", "The reply decision is incomplete.", {
      retryable: false,
    });
  }

  const groundedReply = validateGroundedReply(input.decision.groundedReply, input.evidence);
  const citedSources = createCitedSources(groundedReply, input.evidence);

  if (input.decision.action === "request_refund_review") {
    if (input.classification.category !== "billing") {
      throw new LlmError(
        "invalid_output",
        "Refund review is not allowed for this ticket category.",
        { retryable: false },
      );
    }
    const actionArguments = RequestRefundReviewArgsSchema.parse({
      reason: input.decision.reason,
      ticketSummary: input.classification.summary,
      evidenceChunkIds: groundedReply.citations.map((citation) => citation.chunkId),
    });
    return ResolutionExecutionSchema.parse({
      proposal: ResolutionProposalSchema.parse({
        ...input.classification,
        action: input.decision.action,
        reason: input.decision.reason,
        groundedReply,
        actionProposal: {
          proposalId: input.createProposalId(),
          toolName: "requestRefundReview",
          state: "pending_confirmation",
          arguments: actionArguments,
        },
      }),
      citedSources,
      metadata,
    });
  }

  return ResolutionExecutionSchema.parse({
    proposal: ResolutionProposalSchema.parse({
      ...input.classification,
      action: input.decision.action,
      reason: input.decision.reason,
      groundedReply,
    }),
    citedSources,
    metadata,
  });
}

function logAbstention(
  log: AppLogger,
  input: {
    traceId: string;
    reasonCode: "low_confidence" | "insufficient_evidence" | "model_selected";
    classification: Classification;
    policy: ResolutionPolicy;
  },
  appTracing: AppTracing = tracing,
) {
  appTracing.getActiveSpan()?.setAttributes({
    "support.abstention.reason_code": input.reasonCode,
    "support.action": "needs_human_review",
    "support.category": input.classification.category,
    "support.priority": input.classification.priority,
    "support.confidence": input.classification.confidence,
  });
  log.info(
    withTraceCorrelation(
      {
        event: "resolution_abstained",
        traceId: input.traceId,
        reasonCode: input.reasonCode,
        classificationConfidence: input.classification.confidence,
        minimumConfidence: input.policy.minimumConfidence,
        resolutionPolicyVersion: input.policy.version,
      },
      appTracing,
    ),
  );
}

export async function resolveTicket(
  input: TicketInput,
  options: ResolveTicketOptions,
): Promise<ResolutionExecution> {
  const log = options.log ?? logger;
  const appTracing = options.tracing ?? tracing;
  const pipelineStartedAt = Date.now();
  const classified = await options.classifier(input, { traceId: options.traceId });
  const classification = ClassificationSchema.parse(classified.classification);

  if (classification.confidence < options.policy.minimumConfidence) {
    const execution = abstain({
      classification,
      classified,
      policy: options.policy,
      reason: LOW_CONFIDENCE_REASON,
      pipelineStartedAt,
      resolutionModel: options.provider.model,
    });
    logAbstention(
      log,
      {
        traceId: options.traceId,
        reasonCode: "low_confidence",
        classification,
        policy: options.policy,
      },
      appTracing,
    );
    return execution;
  }

  let evidence: RetrievedEvidence[];
  try {
    evidence = await options.retriever.retrieve({
      text: input.text,
      category: classification.category,
      traceId: options.traceId,
    });
  } catch (error) {
    if (!isRetrievalError(error) || error.code !== "insufficient_evidence") {
      throw error;
    }

    const execution = abstain({
      classification,
      classified,
      policy: options.policy,
      reason: INSUFFICIENT_EVIDENCE_REASON,
      pipelineStartedAt,
      resolutionModel: options.provider.model,
    });
    logAbstention(
      log,
      {
        traceId: options.traceId,
        reasonCode: "insufficient_evidence",
        classification,
        policy: options.policy,
      },
      appTracing,
    );
    return execution;
  }

  const startedAt = Date.now();
  let generated: GenerateResult<ResolutionDecision>;
  try {
    generated = await appTracing.withSpan(
      "support.ai.resolution",
      {
        attributes: {
          "support.trace_id": options.traceId,
          "support.task": "resolution",
          "support.prompt.version": RESOLUTION_PROMPT_VERSION,
          "support.policy.version": options.policy.version,
          "gen_ai.provider.name": options.provider.name,
          "gen_ai.request.model": options.provider.model,
        },
      },
      async (span) => {
        try {
          const result = await options.provider.generateStructured(
            createResolutionRequest({
              ticket: input,
              classification,
              evidence,
              traceId: options.traceId,
            }),
          );
          span.setAttributes({
            "gen_ai.response.model": result.model,
            "gen_ai.usage.input_tokens": result.usage.inputTokens,
            "gen_ai.usage.output_tokens": result.usage.outputTokens,
            "support.usage.cached_input_tokens": result.usage.cachedInputTokens,
            "support.usage.cache_write_tokens": result.usage.cacheWriteInputTokens,
            "support.provider.request_id": result.providerRequestId,
            "support.provider.message_id": result.providerMessageId,
            "support.finish_reason": result.finishReason,
            "support.duration_ms": result.latencyMs,
            "support.retry_count": result.retryCount,
            "support.validation.passed": true,
            "support.validation.outcome": "provider_schema_valid",
            "support.action": result.value.action,
            "support.outcome": "completed",
          });
          return result;
        } catch (error) {
          const mapped = isLlmError(error)
            ? error
            : new LlmError("unexpected", "Grounded resolution generation failed.", {
                retryable: false,
                cause: error,
              });
          span.setAttributes({
            "support.duration_ms": Math.max(0, Date.now() - startedAt),
            "support.finish_reason": mapped.finishReason ?? mapped.code,
            "support.validation.passed": false,
            "support.validation.outcome": "provider_error",
            "support.retry_count": mapped.retryCount,
            "support.provider.request_id": mapped.providerRequestId,
            "support.provider.status_code": mapped.providerStatusCode,
            "support.outcome": "failed",
          });
          span.fail(mapped.code);
          throw mapped;
        }
      },
    );
  } catch (error) {
    const mapped = isLlmError(error)
      ? error
      : new LlmError("unexpected", "Grounded resolution generation failed.", {
          retryable: false,
          cause: error,
        });
    log.error(
      withTraceCorrelation(
        {
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
          providerStatusCode: mapped.providerStatusCode,
          providerErrorType: mapped.providerErrorType,
          validationPassed: false,
          retryCount: mapped.retryCount,
          evidenceCount: evidence.length,
        },
        appTracing,
      ),
    );
    throw mapped;
  }

  try {
    const execution = await appTracing.withSpan(
      "support.grounding.validate",
      {
        attributes: {
          "support.trace_id": options.traceId,
          "support.operation": "grounding_validation",
          "support.policy.version": options.policy.version,
          "support.citation_count": generated.value.groundedReply?.citations.length ?? 0,
        },
      },
      async (span) => {
        try {
          const result = createGeneratedExecution({
            classification,
            classified,
            decision: generated.value,
            generated,
            evidence,
            policy: options.policy,
            provider: options.provider,
            pipelineStartedAt,
            createProposalId: options.createProposalId ?? randomUUID,
          });
          span.setAttributes({
            "support.validation.passed": true,
            "support.validation.outcome":
              result.proposal.action === "needs_human_review" ? "not_applicable" : "grounded",
            "support.action": result.proposal.action,
            "support.citation_count": result.citedSources.length,
            "support.outcome": "completed",
          });
          return result;
        } catch (error) {
          span.setAttributes({
            "support.validation.passed": false,
            "support.validation.outcome": "invalid",
            "support.outcome": "failed",
          });
          span.fail("invalid_output");
          throw error;
        }
      },
    );

    log.info(
      withTraceCorrelation(
        {
          event: "model_call",
          traceId: options.traceId,
          task: "resolution",
          provider: options.provider.name,
          model: generated.model,
          promptVersion: RESOLUTION_PROMPT_VERSION,
          providerRequestId: generated.providerRequestId,
          providerMessageId: generated.providerMessageId,
          inputTokens: generated.usage.inputTokens,
          outputTokens: generated.usage.outputTokens,
          cachedInputTokens: generated.usage.cachedInputTokens,
          latencyMs: generated.latencyMs,
          finishReason: generated.finishReason,
          validationPassed: true,
          retryCount: generated.retryCount,
          evidenceCount: evidence.length,
          action: generated.value.action,
        },
        appTracing,
      ),
    );
    if (execution.proposal.action === "needs_human_review") {
      logAbstention(
        log,
        {
          traceId: options.traceId,
          reasonCode: "model_selected",
          classification,
          policy: options.policy,
        },
        appTracing,
      );
    }
    return execution;
  } catch (error) {
    const mapped = isLlmError(error)
      ? error
      : error instanceof z.ZodError
        ? new LlmError("invalid_output", "The resolution decision is invalid.", {
            retryable: false,
            cause: error,
          })
        : new LlmError("unexpected", "Grounded resolution generation failed.", {
            retryable: false,
            cause: error,
          });
    log.error(
      withTraceCorrelation(
        {
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
        },
        appTracing,
      ),
    );
    throw mapped;
  }
}

export async function resolveTicketWithConfiguredProviders(
  input: TicketInput,
  context: ResolutionContext,
): Promise<ResolutionExecution> {
  let config;
  let policy: ResolutionPolicy;
  try {
    config = getAiConfig();
    policy = getResolutionPolicy();
  } catch (error) {
    throw new LlmError("configuration", "AI configuration is invalid.", {
      retryable: false,
      cause: error,
    });
  }
  const log = createLogger(config.logLevel);
  const provider = new AnthropicLlmProvider({
    apiKey: config.anthropicApiKey,
    model: config.models.resolution,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    promptCacheEnabled: config.promptCacheEnabled,
    tracing,
  });
  const classificationProvider = new AnthropicLlmProvider({
    apiKey: config.anthropicApiKey,
    model: config.models.classification,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    promptCacheEnabled: config.promptCacheEnabled,
    tracing,
  });
  const retriever: EvidenceRetriever = {
    retrieve: async (retrievalInput) => {
      let configuredRetriever: EvidenceRetriever;
      try {
        configuredRetriever = createConfiguredEvidenceRetriever();
      } catch (error) {
        throw new RetrievalError("unavailable", "Knowledge retrieval is not configured.", {
          retryable: true,
          cause: error,
        });
      }
      return configuredRetriever.retrieve(retrievalInput);
    },
  };

  return resolveTicket(input, {
    ...context,
    provider,
    retriever,
    policy,
    classifier: (ticket, classificationContext) =>
      classifyTicketWithMetadata(ticket, {
        ...classificationContext,
        provider: classificationProvider,
        log,
        tracing,
      }),
    log,
    tracing,
  });
}
