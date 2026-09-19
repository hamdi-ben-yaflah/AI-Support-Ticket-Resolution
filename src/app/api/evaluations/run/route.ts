import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLiveEvaluationEnabled } from "@/config/deployment";
import { createApiResultSchema, type ApiResult } from "@/domain/api-result";
import {
  EvaluationReportSchema,
  EvaluationRunRequestSchema,
  type EvaluationReport,
} from "@/evals/contracts";
import { isEvaluationSetupError } from "@/evals/errors";
import { runConfiguredEvaluation } from "@/evals/service";
import { logger, type AppLogger } from "@/observability/logger";
import {
  isLocalEvaluationRequest,
  readGuardedJson,
  requestGuardResponse,
  SMALL_BODY_BYTES,
} from "@/security/http";

const EvaluationApiResultSchema = createApiResultSchema(EvaluationReportSchema);

type EvaluationRunner = (concurrency: number) => Promise<EvaluationReport>;

type HandlerDependencies = {
  run?: EvaluationRunner;
  createTraceId?: () => string;
  isEnabled?: () => boolean;
  log?: AppLogger;
};

function disabledResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function response(
  body: ApiResult<EvaluationReport>,
  status: number,
): NextResponse<ApiResult<EvaluationReport>> {
  return NextResponse.json(EvaluationApiResultSchema.parse(body), {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(
  traceId: string,
  status: number,
  code: "invalid_request" | "configuration_error" | "internal_error",
  message: string,
  retryable: boolean,
) {
  return response({ ok: false, traceId, error: { code, message, retryable } }, status);
}

export function createEvaluationRunHandler(dependencies: HandlerDependencies = {}) {
  const run = dependencies.run ?? runConfiguredEvaluation;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const isEnabled = dependencies.isEnabled ?? isLiveEvaluationEnabled;
  const log = dependencies.log ?? logger;
  let active = false;

  return async function POST(request: Request): Promise<Response> {
    if (!isLocalEvaluationRequest(request) || !isEnabled()) return disabledResponse();

    const traceId = createTraceId();
    let body: unknown;
    try {
      body = await readGuardedJson(request, SMALL_BODY_BYTES);
    } catch (error) {
      return requestGuardResponse(error, traceId);
    }

    const input = EvaluationRunRequestSchema.safeParse(body);
    if (!input.success) {
      return failure(
        traceId,
        400,
        "invalid_request",
        "Concurrency must be an integer from 1 to 5 and no other fields are allowed.",
        false,
      );
    }
    if (active) {
      return failure(
        traceId,
        409,
        "invalid_request",
        "An evaluation is already running in this process.",
        true,
      );
    }

    active = true;
    try {
      const report = EvaluationReportSchema.parse(await run(input.data.concurrency));
      log.info({
        event: "evaluation_completed",
        traceId,
        runId: report.runId,
        status: report.status,
        caseCount: report.dataset.caseCount,
        errorCount: report.metrics.operations.errorCount,
        latencyP95Ms: report.metrics.operations.latencyP95Ms,
      });
      return response({ ok: true, traceId, data: report }, 200);
    } catch (error) {
      const configuration = isEvaluationSetupError(error) && error.code === "configuration";
      log.error({
        event: "evaluation_failed",
        traceId,
        code: configuration ? "configuration" : "internal",
      });
      return failure(
        traceId,
        500,
        configuration ? "configuration_error" : "internal_error",
        configuration
          ? "The evaluation service is not configured."
          : "The evaluation could not be completed.",
        false,
      );
    } finally {
      active = false;
    }
  };
}

export const POST = createEvaluationRunHandler();
