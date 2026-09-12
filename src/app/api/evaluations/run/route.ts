import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { createApiResultSchema, type ApiResult } from "@/domain/api-result";
import {
  EvaluationReportSchema,
  EvaluationRunRequestSchema,
  type EvaluationReport,
} from "@/evals/contracts";
import { isEvaluationSetupError } from "@/evals/errors";
import { runConfiguredEvaluation } from "@/evals/service";
import { logger, type AppLogger } from "@/observability/logger";

const EvaluationApiResultSchema = createApiResultSchema(EvaluationReportSchema);
const MAX_REQUEST_BYTES = 1_024;

type EvaluationRunner = (concurrency: number) => Promise<EvaluationReport>;

type HandlerDependencies = {
  run?: EvaluationRunner;
  createTraceId?: () => string;
  log?: AppLogger;
};

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
  const log = dependencies.log ?? logger;
  let active = false;

  return async function POST(request: Request): Promise<Response> {
    const traceId = createTraceId();
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return failure(
        traceId,
        415,
        "invalid_request",
        "Content-Type must be application/json.",
        false,
      );
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return failure(traceId, 413, "invalid_request", "Request body is too large.", false);
    }

    let raw: string;
    let body: unknown;
    try {
      raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
        return failure(traceId, 413, "invalid_request", "Request body is too large.", false);
      }
      body = JSON.parse(raw);
    } catch {
      return failure(traceId, 400, "invalid_request", "Request body must be valid JSON.", false);
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
