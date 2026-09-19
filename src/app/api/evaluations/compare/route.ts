import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { isLiveEvaluationEnabled } from "@/config/deployment";
import { EvaluationRepositoryError, loadEvaluationRunPair } from "@/db/evaluation-runs";
import { createApiResultSchema, type ApiErrorCode, type ApiResult } from "@/domain/api-result";
import {
  EvaluationComparisonRequestSchema,
  EvaluationComparisonSchema,
  type EvaluationComparison,
  type PersistedEvaluationRun,
} from "@/evals/comparison-contracts";
import { compareEvaluationRuns, EvaluationComparisonError } from "@/evals/comparison";
import { logger, type AppLogger } from "@/observability/logger";
import { isLocalEvaluationRequest } from "@/security/http";

const ResultSchema = createApiResultSchema(EvaluationComparisonSchema);

type Dependencies = {
  load?: (
    baselineId: string,
    candidateId: string,
  ) => Promise<[PersistedEvaluationRun, PersistedEvaluationRun]>;
  compare?: typeof compareEvaluationRuns;
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
  body: ApiResult<EvaluationComparison>,
  status: number,
): NextResponse<ApiResult<EvaluationComparison>> {
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

function parseRequest(request: Request) {
  const search = new URL(request.url).searchParams;
  if (
    [...search.keys()].some((key) => key !== "baseline" && key !== "candidate") ||
    search.getAll("baseline").length !== 1 ||
    search.getAll("candidate").length !== 1
  )
    return null;
  const parsed = EvaluationComparisonRequestSchema.safeParse({
    baseline: search.get("baseline"),
    candidate: search.get("candidate"),
  });
  return parsed.success ? parsed.data : null;
}

export function createEvaluationCompareHandler(dependencies: Dependencies = {}) {
  const load = dependencies.load ?? loadEvaluationRunPair;
  const compare = dependencies.compare ?? compareEvaluationRuns;
  const createTraceId = dependencies.createTraceId ?? randomUUID;
  const isEnabled = dependencies.isEnabled ?? isLiveEvaluationEnabled;
  const log = dependencies.log ?? logger;

  return async function GET(request: Request): Promise<Response> {
    if (!isLocalEvaluationRequest(request) || !isEnabled()) return disabledResponse();

    const traceId = createTraceId();
    const input = parseRequest(request);
    if (!input) {
      return failure(
        traceId,
        400,
        "invalid_request",
        "Baseline and candidate must be different evaluation run UUIDs.",
        false,
      );
    }
    try {
      const [baseline, candidate] = await load(input.baseline, input.candidate);
      return response({ ok: true, traceId, data: compare(baseline, candidate) }, 200);
    } catch (error) {
      if (error instanceof EvaluationRepositoryError && error.code === "not_found") {
        return failure(
          traceId,
          404,
          "evaluation_not_found",
          "One or both evaluation runs were not found.",
          false,
        );
      }
      if (error instanceof EvaluationComparisonError) {
        return failure(
          traceId,
          409,
          "evaluation_incompatible",
          "The selected runs use incompatible report, dataset, or case-set versions.",
          false,
        );
      }
      const unavailable =
        error instanceof EvaluationRepositoryError && error.code === "unavailable";
      log.error({
        event: "evaluation_comparison_failed",
        traceId,
        code: unavailable ? "unavailable" : "invalid_data",
      });
      return failure(
        traceId,
        unavailable ? 503 : 500,
        unavailable ? "configuration_error" : "internal_error",
        unavailable
          ? "Evaluation history is not configured or is unavailable."
          : "The evaluation comparison could not be completed.",
        unavailable,
      );
    }
  };
}

export const GET = createEvaluationCompareHandler();
