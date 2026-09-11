import "server-only";

import { z } from "zod";

const SessionConfigSchema = z.object({
  SESSION_COOKIE_SECRET: z.string().min(32).max(1_024),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const SESSION_COOKIE_NAME = "support_copilot_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionConfig = {
  secret: string;
  secure: boolean;
};

export class SessionConfigurationError extends Error {
  constructor() {
    super("Session configuration is invalid or incomplete.");
    this.name = "SessionConfigurationError";
  }
}

export function getSessionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SessionConfig {
  const parsed = SessionConfigSchema.safeParse(environment);
  if (!parsed.success) throw new SessionConfigurationError();

  return {
    secret: parsed.data.SESSION_COOKIE_SECRET,
    secure: parsed.data.NODE_ENV !== "development",
  };
}
