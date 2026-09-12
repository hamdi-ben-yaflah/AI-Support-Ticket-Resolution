import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  EvaluationRepositoryError,
  listRecentEvaluationRuns,
} from "@/db/evaluation-runs";
import { createApiResultSchema, type ApiErrorCode, type ApiResult } from "@/domain/api-result";
import {
  EvaluationRunListSchema,
  type EvaluationRunSummary,
} from "@/evals/comparison-contracts";
import { logger, type AppLogger } from "@/observability/logger";

const ResultSchema = createApiResultSchema(EvaluationRunListSchema);

type Dependencies = {
  list?: (limit: number) => Promise<EvaluationRunSummary[]>;
  createTraceId?: () => string;
  log?: AppLogger;
};

function response(
  body: ApiResult<{ runs: EvaluationRunSummary[] }>,
  status: number,
): NextResponse<ApiResult<{ runs: EvaluationRunSummary[] }>> {
  return NextResponse.json(ResultSchema.parse(body), {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(
  traceId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
) {
  return response({ ok: false, traceId, error: { code, message, retryable } }, status);
}

function parseLimit(request: Request): number | null {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => key !== "limit") || search.getAll("limit").length > 1) {
    return null;
  }
  if (!search.has("limit")) return 20;
  const raw = search.get("limit");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : null;
}

export function createEvaluationRunsHandler(dependencies: Dependencies = {}) {
  const list = dependencies.list ?? listRecentEvaluationRuns;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const log = dependencies.log ?? logger;

  return async function GET(request: Request): Promise<Response> {
    const traceId = createTraceId();
    const limit = parseLimit(request);
    if (limit === null) {
      return failure(
        traceId,
        400,
        "invalid_request",
        "Limit must be a single integer from 1 to 50 and no other query fields are allowed.",
        false,
      );
    }
    try {
      const runs = await list(limit);
      return response({ ok: true, traceId, data: { runs } }, 200);
    } catch (error) {
      const configuration = error instanceof EvaluationRepositoryError && error.code === "unavailable";
      log.error({
        event: "evaluation_history_failed",
        traceId,
        code: configuration ? "unavailable" : "invalid_data",
      });
      return failure(
        traceId,
        configuration ? 503 : 500,
        configuration ? "configuration_error" : "internal_error",
        configuration
          ? "Evaluation history is not configured or is unavailable."
          : "Evaluation history could not be loaded.",
        configuration,
      );
    }
  };
}

export const GET = createEvaluationRunsHandler();
