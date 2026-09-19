import { z } from "zod";

export const ApiErrorCodeSchema = z.enum([
  "invalid_request",
  "rate_limited",
  "provider_timeout",
  "provider_unavailable",
  "retrieval_unavailable",
  "model_refused",
  "model_truncated",
  "model_output_invalid",
  "source_not_found",
  "source_unavailable",
  "action_not_found",
  "action_unavailable",
  "configuration_error",
  "evaluation_not_found",
  "evaluation_incompatible",
  "internal_error",
]);

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});

const apiBaseSchema = z.object({
  traceId: z.string().uuid(),
});

export function createApiResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion("ok", [
    apiBaseSchema.extend({
      ok: z.literal(true),
      data: dataSchema,
    }),
    apiBaseSchema.extend({
      ok: z.literal(false),
      error: ApiErrorSchema,
    }),
  ]);
}

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiResult<T> =
  { ok: true; traceId: string; data: T } | { ok: false; traceId: string; error: ApiError };
