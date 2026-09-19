import "server-only";

import { z } from "zod";

const OriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  });
const optionalNumber = (schema: z.ZodType<number>) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

const SecurityConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ORIGIN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      OriginSchema.optional(),
    ),
    RESOLUTION_RATE_PER_MINUTE: optionalNumber(
      z.coerce.number().int().min(1).max(1_000).default(20),
    ),
    RESOLUTION_MAX_CONCURRENT: optionalNumber(z.coerce.number().int().min(1).max(20).default(2)),
    RESOLUTION_SESSION_RATE_PER_MINUTE: optionalNumber(
      z.coerce.number().int().min(1).max(100).default(5),
    ),
  })
  .refine((value) => value.NODE_ENV !== "production" || value.APP_ORIGIN !== undefined);

export class SecurityConfigurationError extends Error {
  constructor() {
    super("Request security configuration is invalid.");
  }
}

export function getSecurityConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = SecurityConfigSchema.safeParse(environment);
  if (!parsed.success) throw new SecurityConfigurationError();
  return {
    origin: parsed.data.APP_ORIGIN,
    requestsPerMinute: parsed.data.RESOLUTION_RATE_PER_MINUTE,
    maxConcurrent: parsed.data.RESOLUTION_MAX_CONCURRENT,
    sessionRequestsPerMinute: parsed.data.RESOLUTION_SESSION_RATE_PER_MINUTE,
  };
}
