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
  })
  .refine(
    (value) =>
      (value.EVAL_ANTHROPIC_INPUT_USD_PER_MILLION === undefined) ===
      (value.EVAL_ANTHROPIC_OUTPUT_USD_PER_MILLION === undefined),
    { message: "Both evaluation price values must be configured together." },
  );

export type EvaluationPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
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
  };
}
