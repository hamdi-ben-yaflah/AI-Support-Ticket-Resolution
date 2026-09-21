import "server-only";

import { z } from "zod";

const OptionalPriceSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().nonnegative().optional(),
);

const EvaluationConfigSchema = z
  .object({
    EVAL_ANTHROPIC_INPUT_USD_PER_MILLION: OptionalPriceSchema,
    EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION: OptionalPriceSchema,
    EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION: OptionalPriceSchema,
    EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION: OptionalPriceSchema,
  })
  .refine(
    (value) =>
      new Set([
        value.EVAL_ANTHROPIC_INPUT_USD_PER_MILLION === undefined,
        value.EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION === undefined,
        value.EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION === undefined,
        value.EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION === undefined,
      ]).size === 1,
    { message: "All evaluation price values must be configured together." },
  );

export type EvaluationPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
} | null;

export function getEvaluationPricing(
  environment: NodeJS.ProcessEnv = process.env,
): EvaluationPricing {
  const parsed = EvaluationConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Evaluation pricing configuration is invalid.");
  }
  if (parsed.data.EVAL_ANTHROPIC_INPUT_USD_PER_MILLION === undefined) return null;
  return {
    inputUsdPerMillion: parsed.data.EVAL_ANTHROPIC_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: parsed.data.EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION ?? 0,
    cacheReadUsdPerMillion: parsed.data.EVAL_ANTHROPIC_CACHE_READ_USD_PER_MILLION ?? 0,
    cacheWriteUsdPerMillion: parsed.data.EVAL_ANTHROPIC_CACHE_WRITE_USD_PER_MILLION ?? 0,
  };
}
