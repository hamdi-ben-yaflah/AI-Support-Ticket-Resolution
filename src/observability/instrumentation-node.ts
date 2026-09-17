import "server-only";

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { getObservabilityConfig } from "@/config/observability";
import { logger } from "@/observability/logger";
import { TRACE_INSTRUMENTATION_SCOPE } from "@/observability/tracing";

let initialization: Promise<void> | undefined;

export function initializeObservability(): Promise<void> {
  initialization ??= initializeOnce();
  return initialization;
}

async function initializeOnce(): Promise<void> {
  try {
    const config = getObservabilityConfig();
    if (!config.enabled) return;

    const sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          baseUrl: config.baseUrl,
          environment: config.environment,
          release: config.release,
          exportMode: "batched",
          mediaUploadEnabled: false,
          timeout: 2,
          shouldExportSpan: ({ otelSpan }) =>
            otelSpan.instrumentationScope.name === TRACE_INSTRUMENTATION_SCOPE,
        }),
      ],
    });
    sdk.start();
  } catch {
    logger.warn({
      event: "observability_initialization_failed",
      code: "configuration_or_exporter",
    });
  }
}
