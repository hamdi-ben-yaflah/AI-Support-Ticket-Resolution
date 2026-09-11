import "server-only";

import { z } from "zod";

const ResolutionPolicyConfigSchema = z.object({
  RESOLUTION_MINIMUM_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.65),
});

export type ResolutionPolicy = {
  minimumConfidence: number;
  version: "resolution-policy.v1";
};

export function getResolutionPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): ResolutionPolicy {
  const parsed = ResolutionPolicyConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Resolution policy configuration is invalid.");
  }

  return {
    minimumConfidence: parsed.data.RESOLUTION_MINIMUM_CONFIDENCE,
    version: "resolution-policy.v1",
  };
}
