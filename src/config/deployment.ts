import "server-only";

import { z } from "zod";

const DeploymentConfigSchema = z.object({
  APP_VERSION: z
    .string()
    .trim()
    .regex(/^(?:development|unknown|[a-f0-9]{7,64})$/)
    .default("development"),
  DATABASE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3_000),
  ENABLE_LIVE_EVALUATIONS: z.enum(["true", "false"]).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const BuildVersionSchema = DeploymentConfigSchema.pick({ APP_VERSION: true });

export type DeploymentConfig = {
  appVersion: string;
  databaseReadinessTimeoutMs: number;
  liveEvaluationsEnabled: boolean;
};

export function getDeploymentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  const parsed = DeploymentConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Deployment configuration is invalid.");
  }

  return {
    appVersion: parsed.data.APP_VERSION,
    databaseReadinessTimeoutMs: parsed.data.DATABASE_READINESS_TIMEOUT_MS,
    liveEvaluationsEnabled:
      parsed.data.ENABLE_LIVE_EVALUATIONS === undefined
        ? parsed.data.NODE_ENV !== "production"
        : parsed.data.ENABLE_LIVE_EVALUATIONS === "true",
  };
}

export function isLiveEvaluationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return getDeploymentConfig(environment).liveEvaluationsEnabled;
}

export function getBuildVersion(environment: NodeJS.ProcessEnv = process.env): string {
  const parsed = BuildVersionSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Build version is invalid.");
  return parsed.data.APP_VERSION;
}
