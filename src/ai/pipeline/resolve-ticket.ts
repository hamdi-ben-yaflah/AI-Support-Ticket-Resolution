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
import {
  getResolutionPolicy,
  type ResolutionPolicy,
} from "@/config/resolution";
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
      (decision.action === "reply" ||
        decision.action === "request_refund_review") &&
      decision.groundedReply === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["groundedReply"],
        message: "Reply decisions require a grounded reply.",
      });
    }
    if (
      decision.action === "needs_human_review" &&
      decision.groundedReply !== null
    ) {
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
};

const LOW_CONFIDENCE_REASON =
  "Classification confidence is below the safe automation threshold.";
const INSUFFICIENT_EVIDENCE_REASON =
  "The knowledge base does not contain enough evidence for a safe reply.";

function createExecutionMetadata(input: {
  classified: ClassificationExecution;
  policy: ResolutionPolicy;
  pipelineStartedAt: number;
  generated?: GenerateResult<ResolutionDecision>;
  resolutionProvider?: LlmProvider;
}): ResolutionRunMetadata {
  const generated = input.generated;
  return {
    promptVersions: {
      classification: input.classified.metadata.promptVersion,
      resolution: RESOLUTION_PROMPT_VERSION,
    },
    resolutionPolicy: input.policy,
    provider: generated
      ? (input.resolutionProvider?.name ?? input.classified.metadata.provider)
      : input.classified.metadata.provider,
    model: generated?.model ?? input.classified.metadata.model,
    latencyMs: Math.max(0, Date.now() - input.pipelineStartedAt),
    inputTokens:
      input.classified.metadata.inputTokens + (generated?.usage.inputTokens ?? 0),
    outputTokens:
      input.classified.metadata.outputTokens + (generated?.usage.outputTokens ?? 0),
    retryCount:
      input.classified.metadata.retryCount + (generated?.retryCount ?? 0),
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

  const groundedReply = validateGroundedReply(
    input.decision.groundedReply,
    input.evidence,
  );
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
      evidenceChunkIds: groundedReply.citations.map(
        (citation) => citation.chunkId,
      ),
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
) {
  log.info({
    event: "resolution_abstained",
    traceId: input.traceId,
    reasonCode: input.reasonCode,
    classificationConfidence: input.classification.confidence,
    minimumConfidence: input.policy.minimumConfidence,
    resolutionPolicyVersion: input.policy.version,
  });
}

export async function resolveTicket(
  input: TicketInput,
  options: ResolveTicketOptions,
): Promise<ResolutionExecution> {
  const log = options.log ?? logger;
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
    });
    logAbstention(log, {
      traceId: options.traceId,
      reasonCode: "low_confidence",
      classification,
      policy: options.policy,
    });
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
    });
    logAbstention(log, {
      traceId: options.traceId,
      reasonCode: "insufficient_evidence",
      classification,
      policy: options.policy,
    });
    return execution;
  }

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

    const execution = createGeneratedExecution({
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
      action: generated.value.action,
    });
    if (execution.proposal.action === "needs_human_review") {
      logAbstention(log, {
        traceId: options.traceId,
        reasonCode: "model_selected",
        classification,
        policy: options.policy,
      });
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
    model: config.model,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
  const retriever: EvidenceRetriever = {
    retrieve: async (retrievalInput) => {
      let configuredRetriever: EvidenceRetriever;
      try {
        configuredRetriever = createConfiguredEvidenceRetriever();
      } catch (error) {
        throw new RetrievalError(
          "unavailable",
          "Knowledge retrieval is not configured.",
          {
            retryable: true,
            cause: error,
          },
        );
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
        provider,
        log,
      }),
    log,
  });
}
