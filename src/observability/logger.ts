import "server-only";

import pino from "pino";

import type { AiConfig } from "@/config/ai";

const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "apiKey",
  "anthropicApiKey",
  "ticket",
  "ticketText",
  "prompt",
  "system",
  "input",
  "providerResponse",
  "embedding",
  "embeddings",
  "vector",
  "vectors",
  "content",
  "chunks",
  "*.content",
];

export type AppLogger = Pick<pino.Logger, "info" | "warn" | "error">;

export function createLogger(logLevel: AiConfig["logLevel"] = "info"): pino.Logger {
  return pino({
    level: logLevel,
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
  });
}

export const logger = createLogger();
