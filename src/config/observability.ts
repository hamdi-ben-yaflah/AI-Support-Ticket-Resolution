import "server-only";

import { z } from "zod";

const OptionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const ObservabilityEnvironmentSchema = z
  .object({
    LANGFUSE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    LANGFUSE_PUBLIC_KEY: OptionalNonEmptyString,
    LANGFUSE_SECRET_KEY: OptionalNonEmptyString,
    LANGFUSE_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    LANGFUSE_ENVIRONMENT: OptionalNonEmptyString,
    LANGFUSE_RELEASE: OptionalNonEmptyString,
  })
  .superRefine((value, context) => {
    const hasPublicKey = value.LANGFUSE_PUBLIC_KEY !== undefined;
    const hasSecretKey = value.LANGFUSE_SECRET_KEY !== undefined;
    if (hasPublicKey !== hasSecretKey) {
      context.addIssue({
        code: "custom",
        message: "Langfuse credentials must be configured together.",
      });
    }
    if (value.LANGFUSE_ENABLED && (!hasPublicKey || !hasSecretKey)) {
      context.addIssue({
        code: "custom",
        message: "Enabled Langfuse tracing requires both credentials.",
      });
    }
  });

export type ObservabilityConfig =
  | { enabled: false }
  | {
      enabled: true;
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
      environment?: string;
      release?: string;
    };

export function getObservabilityConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  const parsed = ObservabilityEnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Observability configuration is invalid.");
  if (!parsed.data.LANGFUSE_ENABLED) return { enabled: false };

  return {
    enabled: true,
    publicKey: parsed.data.LANGFUSE_PUBLIC_KEY as string,
    secretKey: parsed.data.LANGFUSE_SECRET_KEY as string,
    ...(parsed.data.LANGFUSE_BASE_URL === undefined
      ? {}
      : { baseUrl: parsed.data.LANGFUSE_BASE_URL }),
    ...(parsed.data.LANGFUSE_ENVIRONMENT === undefined
      ? {}
      : { environment: parsed.data.LANGFUSE_ENVIRONMENT }),
    ...(parsed.data.LANGFUSE_RELEASE === undefined
      ? {}
      : { release: parsed.data.LANGFUSE_RELEASE }),
  };
}
