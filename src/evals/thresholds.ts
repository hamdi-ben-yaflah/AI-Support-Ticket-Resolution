import { EVALUATION_THRESHOLD_VERSION, type EvaluationQualityMetrics } from "@/evals/contracts";

export const EVALUATION_THRESHOLDS = {
  schemaValidity: 0.88,
  categoryAccuracy: 0.78,
  retrievalRecallAt5: 0.55,
  citationSupport: 0.85,
  abstentionAccuracy: 0.55,
} as const;

export function evaluateThresholds(metrics: EvaluationQualityMetrics) {
  return (
    Object.entries(EVALUATION_THRESHOLDS) as Array<[keyof typeof EVALUATION_THRESHOLDS, number]>
  ).map(([metric, threshold]) => {
    const { value: actual, lowerBound } = metrics[metric];
    const gateValue = lowerBound ?? actual;
    return {
      metric,
      threshold,
      actual,
      lowerBound,
      passed: gateValue !== null && gateValue >= threshold,
    };
  });
}

export { EVALUATION_THRESHOLD_VERSION };
