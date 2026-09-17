import "server-only";

import { z } from "zod";

const InvestigationToolConfigSchema = z.object({
  INVESTIGATION_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1).max(10_000).default(3_000),
});

export type InvestigationToolConfig = {
  timeoutMs: number;
};

export function getInvestigationToolConfig(
  environment: NodeJS.ProcessEnv = process.env,
): InvestigationToolConfig {
  const parsed = InvestigationToolConfigSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Investigation tool configuration is invalid.");
  return { timeoutMs: parsed.data.INVESTIGATION_TOOL_TIMEOUT_MS };
}
