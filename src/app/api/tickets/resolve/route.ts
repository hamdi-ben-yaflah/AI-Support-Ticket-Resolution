import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLlmError } from "@/ai/errors";
import {
  resolveTicketWithConfiguredProviders,
  type ResolutionContext,
} from "@/ai/pipeline/resolve-ticket";
import { createApiResultSchema, type ApiErrorCode, type ApiResult } from "@/domain/api-result";
import { ResolutionProposalSchema, type ResolutionProposal } from "@/domain/grounded-reply";
import { TicketInputSchema, type TicketInput } from "@/domain/ticket";
import { logger, type AppLogger } from "@/observability/logger";
import { isRetrievalError } from "@/retrieval/errors";

type Resolver = (
  input: TicketInput,
  context: ResolutionContext,
) => Promise<ResolutionProposal>;

type HandlerDependencies = {
  resolve?: Resolver;
  createTraceId?: () => string;
  log?: AppLogger;
};

type ErrorResponse = {
  status: number;
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
};

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
      const proposal = await resolve(input.data, { traceId });
      const result: ApiResult<ResolutionProposal> = {
        ok: true,
        traceId,
        data: proposal,
      };

      log.info({ event: "resolve_request_completed", traceId });
      return NextResponse.json(ResolutionApiResultSchema.parse(result), { status: 200 });
    } catch (error) {
      const mapped = mapResolutionError(error);
      log.error({
        event: "resolve_request_failed",
        traceId,
        code: mapped.code,
        retryable: mapped.retryable,
      });
      return failure(traceId, mapped);
    }
  };
}

export const POST = createResolveHandler();
