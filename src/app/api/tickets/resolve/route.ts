import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLlmError } from "@/ai/errors";
import {
  classifyTicketWithConfiguredProvider,
  type ClassificationContext,
} from "@/ai/pipeline/classify-ticket";
import type { ApiErrorCode, ApiResult } from "@/domain/api-result";
import type { Classification } from "@/domain/classification";
import { TicketInputSchema, type TicketInput } from "@/domain/ticket";
import { logger, type AppLogger } from "@/observability/logger";

type Classifier = (
  input: TicketInput,
  context: ClassificationContext,
) => Promise<Classification>;

type HandlerDependencies = {
  classify?: Classifier;
  createTraceId?: () => string;
  log?: AppLogger;
};

type ErrorResponse = {
  status: number;
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
};

function failure(traceId: string, error: ErrorResponse) {
  const body: ApiResult<Classification> = {
    ok: false,
    traceId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };

  return NextResponse.json(body, { status: error.status });
}

function mapClassificationError(error: unknown): ErrorResponse {
  if (!isLlmError(error)) {
    return {
      status: 500,
      code: "internal_error",
      message: "The ticket could not be classified.",
      retryable: false,
    };
  }

  switch (error.code) {
    case "timeout":
      return {
        status: 504,
        code: "provider_timeout",
        message: "The classification request timed out. Try again.",
        retryable: true,
      };
    case "unavailable":
      return {
        status: 503,
        code: "provider_unavailable",
        message: "The classification service is temporarily unavailable. Try again.",
        retryable: true,
      };
    case "refused":
      return {
        status: 502,
        code: "model_refused",
        message: "The model could not classify this ticket. Human review is required.",
        retryable: false,
      };
    case "truncated":
      return {
        status: 502,
        code: "model_truncated",
        message: "The model returned an incomplete classification.",
        retryable: false,
      };
    case "invalid_output":
      return {
        status: 502,
        code: "model_output_invalid",
        message: "The model returned a classification that could not be validated.",
        retryable: false,
      };
    case "configuration":
      return {
        status: 500,
        code: "configuration_error",
        message: "The classification service is not configured.",
        retryable: false,
      };
    case "unexpected":
      return {
        status: 500,
        code: "internal_error",
        message: "The ticket could not be classified.",
        retryable: false,
      };
  }
}

export function createResolveHandler(dependencies: HandlerDependencies = {}) {
  const classify = dependencies.classify ?? classifyTicketWithConfiguredProvider;
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
      const classification = await classify(input.data, { traceId });
      const result: ApiResult<Classification> = {
        ok: true,
        traceId,
        data: classification,
      };

      log.info({ event: "resolve_request_completed", traceId });
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      const mapped = mapClassificationError(error);
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
