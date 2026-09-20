import "server-only";

import { z } from "zod";

const OriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  });
const SecurityConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ORIGIN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      OriginSchema.optional(),
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
  };
}
