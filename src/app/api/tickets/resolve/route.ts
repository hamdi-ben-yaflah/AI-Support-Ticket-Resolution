import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLlmError } from "@/ai/errors";
import {
  resolveTicketWithConfiguredProviders,
  type ResolutionContext,
} from "@/ai/pipeline/resolve-ticket";
import {
  getOrCreateResolutionSession,
  type ResolutionSession,
} from "@/auth/session";
import { SessionConfigurationError } from "@/config/session";
import { persistSuccessfulResolution } from "@/db/resolution-runs";
import { createApiResultSchema, type ApiErrorCode, type ApiResult } from "@/domain/api-result";
import { ResolutionProposalSchema, type ResolutionProposal } from "@/domain/grounded-reply";
import type {
  PersistedResolutionRun,
  ResolutionExecution,
} from "@/domain/resolution-run";
import { ResolutionExecutionSchema } from "@/domain/resolution-run";
import { TicketInputSchema, type TicketInput } from "@/domain/ticket";
import { logger, type AppLogger } from "@/observability/logger";
import { isRetrievalError } from "@/retrieval/errors";

type Resolver = (
  input: TicketInput,
  context: ResolutionContext,
) => Promise<ResolutionExecution>;

type HandlerDependencies = {
  resolve?: Resolver;
  createSession?: (request: Request, ticketText: string) => ResolutionSession;
  persist?: (run: PersistedResolutionRun) => Promise<void>;
  createTraceId?: () => string;
  log?: AppLogger;
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

  return NextResponse.json(ResolutionApiResultSchema.parse(body), { status: error.status });
}

function mapResolutionError(error: unknown): ErrorResponse {
  if (error instanceof SessionConfigurationError) {
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

  if (isRetrievalError(error)) {
    return error.code === "insufficient_evidence"
      ? {
          status: 422,
          code: "insufficient_evidence",
          message: "The knowledge base does not contain enough evidence for a safe reply.",
          retryable: false,
        }
      : {
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

export function createResolveHandler(dependencies: HandlerDependencies = {}) {
  const resolve = dependencies.resolve ?? resolveTicketWithConfiguredProviders;
  const createSession = dependencies.createSession ?? getOrCreateResolutionSession;
  const persist = dependencies.persist ?? persistSuccessfulResolution;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const log = dependencies.log ?? logger;

  return async function POST(request: Request): Promise<Response> {
    const traceId = createTraceId();
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      log.warn({ event: "resolve_request_rejected", traceId, reason: "malformed_json" });
      return failure(traceId, {
        status: 400,
        code: "invalid_request",
        message: "Request body must be valid JSON.",
        retryable: false,
      });
    }

    const input = TicketInputSchema.safeParse(body);
    if (!input.success) {
      log.warn({ event: "resolve_request_rejected", traceId, reason: "invalid_input" });
      return failure(traceId, {
        status: 400,
        code: "invalid_request",
        message: "Enter 10 to 10,000 characters and use a supported customer tier.",
        retryable: false,
      });
    }

    try {
      const session = createSession(request, input.data.text);
      const execution = ResolutionExecutionSchema.parse(
        await resolve(input.data, { traceId }),
      );
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
          action: { type: "reply" },
          citedSources: execution.citedSources,
          metadata: execution.metadata,
        });
      } catch (error) {
        throw new ResolutionPersistenceError(error);
      }
      const result: ApiResult<ResolutionProposal> = {
        ok: true,
        traceId,
        data: execution.proposal,
      };

      log.info({ event: "resolve_request_completed", traceId });
      const response = NextResponse.json(ResolutionApiResultSchema.parse(result), {
        status: 200,
      });
      if (session.cookie) {
        response.cookies.set(
          session.cookie.name,
          session.cookie.value,
          session.cookie.options,
        );
      }
      return response;
    } catch (error) {
      const responseError = mapResolutionError(error);
      log.error({
        event: "resolve_request_failed",
        traceId,
        code: responseError.code,
        retryable: responseError.retryable,
      });
      return failure(traceId, responseError);
    }
  };
}

export const POST = createResolveHandler();
