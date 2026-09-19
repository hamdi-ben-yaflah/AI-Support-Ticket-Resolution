import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLlmError } from "@/ai/errors";
import {
  resolveTicketWithConfiguredProviders,
  type ResolutionContext,
} from "@/ai/pipeline/resolve-ticket";
import { getOrCreateResolutionSession, type ResolutionSession } from "@/auth/session";
import { SessionConfigurationError } from "@/config/session";
import { SecurityConfigurationError } from "@/config/security";
import { persistSuccessfulResolution } from "@/db/resolution-runs";
import { createApiResultSchema, type ApiErrorCode, type ApiResult } from "@/domain/api-result";
import { ResolutionProposalSchema, type ResolutionProposal } from "@/domain/grounded-reply";
import type { PersistedResolutionRun, ResolutionExecution } from "@/domain/resolution-run";
import { ResolutionExecutionSchema } from "@/domain/resolution-run";
import { TicketInputSchema, type TicketInput } from "@/domain/ticket";
import { logger, type AppLogger } from "@/observability/logger";
import {
  tracing,
  withTraceCorrelation,
  type AppTracing,
  type NormalizedTraceErrorCode,
} from "@/observability/tracing";
import { isRetrievalError } from "@/retrieval/errors";
import { createAdmissionController } from "@/security/admission";
import {
  PRIVATE_NO_STORE,
  readGuardedJson,
  requestGuardResponse,
  TICKET_BODY_BYTES,
} from "@/security/http";

type Resolver = (input: TicketInput, context: ResolutionContext) => Promise<ResolutionExecution>;

type HandlerDependencies = {
  admission?: ReturnType<typeof createAdmissionController>;
  resolve?: Resolver;
  createSession?: (request: Request, ticketText: string) => ResolutionSession;
  persist?: (run: PersistedResolutionRun) => Promise<void>;
  createTraceId?: () => string;
  log?: AppLogger;
  tracing?: AppTracing;
};

type ErrorResponse = {
  status: number;
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
};

class ResolutionPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Resolution authorization context could not be saved.", { cause });
    this.name = "ResolutionPersistenceError";
  }
}

const ResolutionApiResultSchema = createApiResultSchema(ResolutionProposalSchema);

function failure(traceId: string, error: ErrorResponse) {
  const body: ApiResult<ResolutionProposal> = {
    ok: false,
    traceId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };

  return NextResponse.json(ResolutionApiResultSchema.parse(body), {
    status: error.status,
    headers: PRIVATE_NO_STORE,
  });
}

function mapResolutionError(error: unknown): ErrorResponse {
  if (error instanceof SessionConfigurationError || error instanceof SecurityConfigurationError) {
    return {
      status: 500,
      code: "configuration_error",
      message: "The resolution service is not configured.",
      retryable: false,
    };
  }

  if (error instanceof ResolutionPersistenceError) {
    return {
      status: 503,
      code: "internal_error",
      message: "The ticket could not be resolved.",
      retryable: true,
    };
  }

  if (isRetrievalError(error) && error.code === "unavailable") {
    return {
      status: 503,
      code: "retrieval_unavailable",
      message: "Knowledge retrieval is temporarily unavailable. Try again.",
      retryable: true,
    };
  }

  if (!isLlmError(error)) {
    return {
      status: 500,
      code: "internal_error",
      message: "The ticket could not be resolved.",
      retryable: false,
    };
  }

  switch (error.code) {
    case "timeout":
      return {
        status: 504,
        code: "provider_timeout",
        message: "The model request timed out. Try again.",
        retryable: true,
      };
    case "unavailable":
      return {
        status: 503,
        code: "provider_unavailable",
        message: "The model service is temporarily unavailable. Try again.",
        retryable: true,
      };
    case "refused":
      return {
        status: 502,
        code: "model_refused",
        message: "The model could not produce a proposal. Human review is required.",
        retryable: false,
      };
    case "truncated":
      return {
        status: 502,
        code: "model_truncated",
        message: "The model returned an incomplete proposal.",
        retryable: false,
      };
    case "invalid_output":
      return {
        status: 502,
        code: "model_output_invalid",
        message: "The model returned a proposal that could not be validated.",
        retryable: false,
      };
    case "configuration":
      return {
        status: 500,
        code: "configuration_error",
        message: "The resolution service is not configured.",
        retryable: false,
      };
    case "unexpected":
      return {
        status: 500,
        code: "internal_error",
        message: "The ticket could not be resolved.",
        retryable: false,
      };
  }
}

function normalizedTraceError(code: ApiErrorCode): NormalizedTraceErrorCode {
  switch (code) {
    case "invalid_request":
      return "invalid_input";
    case "provider_timeout":
      return "timeout";
    case "provider_unavailable":
      return "unavailable";
    case "retrieval_unavailable":
      return "retrieval_unavailable";
    case "model_refused":
      return "refused";
    case "model_truncated":
      return "truncated";
    case "model_output_invalid":
      return "invalid_output";
    case "configuration_error":
      return "configuration";
    default:
      return "internal_error";
  }
}

export function createResolveHandler(dependencies: HandlerDependencies = {}) {
  const admission = dependencies.admission ?? createAdmissionController();
  const resolve = dependencies.resolve ?? resolveTicketWithConfiguredProviders;
  const createSession = dependencies.createSession ?? getOrCreateResolutionSession;
  const persist = dependencies.persist ?? persistSuccessfulResolution;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const log = dependencies.log ?? logger;
  const appTracing = dependencies.tracing ?? tracing;

  return async function POST(request: Request): Promise<Response> {
    const traceId = createTraceId();
    const startedAt = Date.now();
    return appTracing.withSpan(
      "support.ticket.resolve",
      { root: true, attributes: { "support.trace_id": traceId, "support.task": "resolve" } },
      async (rootSpan) => {
        let body: unknown;

        try {
          body = await readGuardedJson(request, TICKET_BODY_BYTES);
        } catch (error) {
          const response = requestGuardResponse(error, traceId);
          const configuration = response.status === 500;
          rootSpan.setAttributes({
            "support.api.result_code": configuration ? "configuration_error" : "invalid_request",
            "support.retryable": false,
            "support.outcome": "rejected",
            "support.duration_ms": Math.max(0, Date.now() - startedAt),
          });
          rootSpan.fail(configuration ? "configuration" : "invalid_input");
          log.warn(
            withTraceCorrelation(
              {
                event: "resolve_request_rejected",
                traceId,
                reason: "request_security",
                status: response.status,
              },
              appTracing,
            ),
          );
          return response;
        }

        const input = TicketInputSchema.safeParse(body);
        if (!input.success) {
          rootSpan.setAttributes({
            "support.api.result_code": "invalid_request",
            "support.retryable": false,
            "support.outcome": "rejected",
            "support.duration_ms": Math.max(0, Date.now() - startedAt),
          });
          rootSpan.fail("invalid_input");
          log.warn(
            withTraceCorrelation(
              {
                event: "resolve_request_rejected",
                traceId,
                reason: "invalid_input",
              },
              appTracing,
            ),
          );
          return failure(traceId, {
            status: 400,
            code: "invalid_request",
            message: "Enter 10 to 10,000 characters and use a supported customer tier.",
            retryable: false,
          });
        }

        let release: (() => void) | undefined;
        try {
          const session = createSession(request, input.data.text);
          const permit = admission.acquire(session.cookie ? undefined : session.sessionHash);
          if (!permit.allowed) {
            rootSpan.setAttributes({
              "support.api.result_code": "rate_limited",
              "support.outcome": "rejected",
            });
            const response = failure(traceId, {
              status: 429,
              code: "rate_limited",
              message: `Too many resolution requests. Try again in ${permit.retryAfter} seconds.`,
              retryable: true,
            });
            response.headers.set("Retry-After", String(permit.retryAfter));
            return response;
          }
          release = permit.release;
          const execution = ResolutionExecutionSchema.parse(await resolve(input.data, { traceId }));
          await appTracing.withSpan(
            "support.resolution.persist",
            {
              attributes: {
                "support.trace_id": traceId,
                "support.operation": "resolution_persistence",
              },
            },
            async (span) => {
              try {
                await persist({
                  traceId,
                  sessionHash: session.sessionHash,
                  ticketHash: session.ticketHash,
                  classification: {
                    category: execution.proposal.category,
                    priority: execution.proposal.priority,
                    summary: execution.proposal.summary,
                    confidence: execution.proposal.confidence,
                  },
                  action:
                    execution.proposal.action === "request_refund_review"
                      ? {
                          type: execution.proposal.action,
                          reason: execution.proposal.reason,
                          proposal: execution.proposal.actionProposal,
                        }
                      : {
                          type: execution.proposal.action,
                          reason: execution.proposal.reason,
                        },
                  citedSources: execution.citedSources,
                  metadata: execution.metadata,
                });
                span.setAttributes({
                  "support.persistence.outcome": "persisted",
                  "support.outcome": "completed",
                });
              } catch (error) {
                span.setAttributes({
                  "support.persistence.outcome": "failed",
                  "support.outcome": "failed",
                });
                span.fail("persistence_error");
                throw new ResolutionPersistenceError(error);
              }
            },
          );
          const result: ApiResult<ResolutionProposal> = {
            ok: true,
            traceId,
            data: execution.proposal,
          };

          rootSpan.setAttributes({
            "support.api.result_code": "success",
            "support.retryable": false,
            "support.outcome": "completed",
            "support.category": execution.proposal.category,
            "support.priority": execution.proposal.priority,
            "support.confidence": execution.proposal.confidence,
            "support.action": execution.proposal.action,
            "support.citation_count": execution.citedSources.length,
            "support.duration_ms": Math.max(0, Date.now() - startedAt),
          });
          log.info(
            withTraceCorrelation({ event: "resolve_request_completed", traceId }, appTracing),
          );
          const response = NextResponse.json(ResolutionApiResultSchema.parse(result), {
            status: 200,
            headers: PRIVATE_NO_STORE,
          });
          if (session.cookie) {
            response.cookies.set(session.cookie.name, session.cookie.value, session.cookie.options);
          }
          return response;
        } catch (error) {
          const responseError = mapResolutionError(error);
          rootSpan.setAttributes({
            "support.api.result_code": responseError.code,
            "support.retryable": responseError.retryable,
            "support.outcome": "failed",
            "support.duration_ms": Math.max(0, Date.now() - startedAt),
          });
          rootSpan.fail(normalizedTraceError(responseError.code));
          log.error(
            withTraceCorrelation(
              {
                event: "resolve_request_failed",
                traceId,
                code: responseError.code,
                retryable: responseError.retryable,
              },
              appTracing,
            ),
          );
          return failure(traceId, responseError);
        } finally {
          release?.();
        }
      },
    );
  };
}

export const POST = createResolveHandler();
