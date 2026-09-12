import {
  EVALUATION_THRESHOLD_VERSION,
  type EvaluationQualityMetrics,
} from "@/evals/contracts";

export const EVALUATION_THRESHOLDS = {
  schemaValidity: 1,
  categoryAccuracy: 0.9,
  retrievalRecallAt5: 0.9,
  citationSupport: 0.85,
  abstentionAccuracy: 0.85,
} as const;

export function evaluateThresholds(metrics: EvaluationQualityMetrics) {
  return (Object.entries(EVALUATION_THRESHOLDS) as Array<
    [keyof typeof EVALUATION_THRESHOLDS, number]
  >).map(([metric, threshold]) => {
    const actual = metrics[metric].value;
    return {
      metric,
      threshold,
      actual,
      passed: actual !== null && actual >= threshold,
    };
  });
}

export { EVALUATION_THRESHOLD_VERSION };
