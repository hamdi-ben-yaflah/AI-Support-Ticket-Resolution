export type ConfidenceInterval = {
  lowerBound: number;
  upperBound: number;
};

const Z_95 = 1.959963984540054;

export function wilsonScoreInterval(
  successes: number,
  trials: number,
  z = Z_95,
): ConfidenceInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error("Wilson interval counts must be integers.");
  }
  if (trials < 0 || successes < 0 || successes > trials || !Number.isFinite(z) || z <= 0) {
    throw new Error("Wilson interval inputs are invalid.");
  }
  if (trials === 0) return null;

  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / trials + zSquared / (4 * trials * trials));

  return {
    lowerBound: Math.min(proportion, Math.max(0, center - margin)),
    upperBound: Math.max(proportion, Math.min(1, center + margin)),
  };
}
