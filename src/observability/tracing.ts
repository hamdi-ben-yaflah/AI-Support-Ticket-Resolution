import "server-only";

import { z } from "zod";

import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Span,
} from "@opentelemetry/api";

export const TRACE_INSTRUMENTATION_SCOPE = "support-copilot";

export type TraceSpanName =
  | "support.ticket.resolve"
  | "support.ai.classification"
  | "support.retrieval"
  | "support.embedding.query"
  | "support.vector_search"
  | "support.ai.resolution"
  | "support.grounding.validate"
  | "support.resolution.persist";

export type NormalizedTraceErrorCode =
  | "configuration"
  | "internal_error"
  | "invalid_input"
  | "invalid_json"
  | "invalid_output"
  | "persistence_error"
  | "rate_limited"
  | "refused"
  | "retrieval_insufficient_evidence"
  | "retrieval_unavailable"
  | "timeout"
  | "truncated"
  | "unavailable"
  | "unexpected";

export type SafeTraceAttributes = {
  "langfuse.observation.type"?:
    "CHAIN" | "GENERATION" | "RETRIEVER" | "EMBEDDING" | "GUARDRAIL" | "TOOL";
  "support.trace_id"?: string;
  "support.task"?: string;
  "support.operation"?: string;
  "support.prompt.version"?: string;
  "support.policy.version"?: string;
  "support.retrieval.version"?: string;
  "support.deployment.revision"?: string;
  "gen_ai.provider.name"?: string;
  "gen_ai.request.model"?: string;
  "gen_ai.response.model"?: string;
  "gen_ai.usage.input_tokens"?: number;
  "gen_ai.usage.output_tokens"?: number;
  "support.usage.cached_input_tokens"?: number;
  "support.usage.cache_write_tokens"?: number;
  "support.provider.request_id"?: string;
  "support.provider.message_id"?: string;
  "support.provider.status_code"?: number;
  "support.finish_reason"?: string;
  "support.attempt"?: number;
  "support.retry_count"?: number;
  "support.retry_delay_ms"?: number;
  "support.duration_ms"?: number;
  "support.provider_attempt_duration_ms"?: number;
  "support.validation.passed"?: boolean;
  "support.validation.outcome"?: string;
  "support.outcome"?: string;
  "support.api.result_code"?: string;
  "support.retryable"?: boolean;
  "support.category"?: string;
  "support.priority"?: string;
  "support.confidence"?: number;
  "support.action"?: string;
  "support.abstention.reason_code"?: string;
  "support.citation_count"?: number;
  "support.embedding.input_type"?: string;
  "support.embedding.input_count"?: number;
  "support.embedding.dimensions"?: number;
  "support.embedding.token_count"?: number;
  "support.retrieval.category_filter"?: string;
  "support.retrieval.fallback_used"?: boolean;
  "support.retrieval.candidate_count"?: number;
  "support.retrieval.selected_count"?: number;
  "support.retrieval.minimum_similarity"?: number;
  "support.retrieval.maximum_context_tokens"?: number;
  "support.retrieval.context_token_count"?: number;
  "support.retrieval.similarities"?: number[];
  "support.persistence.outcome"?: string;
  "error.type"?: NormalizedTraceErrorCode;
};

export type RetryTraceEvent = {
  attempt: number;
  retryCount: number;
  delayMs: number;
  errorCode: NormalizedTraceErrorCode;
};

export type TraceCorrelation = { otelTraceId: string; otelSpanId: string };

export interface ActiveTraceSpan {
  setAttributes(attributes: SafeTraceAttributes): void;
  addRetryEvent(event: RetryTraceEvent): void;
  fail(code: NormalizedTraceErrorCode): void;
}

export interface AppTracing {
  withSpan<T>(
    name: TraceSpanName,
    options: { attributes?: SafeTraceAttributes; root?: boolean },
    callback: (span: ActiveTraceSpan) => Promise<T>,
  ): Promise<T>;
  getActiveSpan(): ActiveTraceSpan | undefined;
  getActiveCorrelation(): TraceCorrelation | undefined;
}

const SAFE_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "langfuse.observation.type",
  "support.trace_id",
  "support.task",
  "support.operation",
  "support.prompt.version",
  "support.policy.version",
  "support.retrieval.version",
  "support.deployment.revision",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "support.usage.cached_input_tokens",
  "support.usage.cache_write_tokens",
  "support.provider.request_id",
  "support.provider.message_id",
  "support.provider.status_code",
  "support.finish_reason",
  "support.attempt",
  "support.retry_count",
  "support.retry_delay_ms",
  "support.duration_ms",
  "support.provider_attempt_duration_ms",
  "support.validation.passed",
  "support.validation.outcome",
  "support.outcome",
  "support.api.result_code",
  "support.retryable",
  "support.category",
  "support.priority",
  "support.confidence",
  "support.action",
  "support.abstention.reason_code",
  "support.citation_count",
  "support.embedding.input_type",
  "support.embedding.input_count",
  "support.embedding.dimensions",
  "support.embedding.token_count",
  "support.retrieval.category_filter",
  "support.retrieval.fallback_used",
  "support.retrieval.candidate_count",
  "support.retrieval.selected_count",
  "support.retrieval.minimum_similarity",
  "support.retrieval.maximum_context_tokens",
  "support.retrieval.context_token_count",
  "support.retrieval.similarities",
  "support.persistence.outcome",
  "error.type",
]);

const TraceAttributeValueSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.array(z.number().finite()).max(100),
]);

function definedAttributes(attributes: SafeTraceAttributes): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTE_NAMES.has(name)) continue;
    const parsed = TraceAttributeValueSchema.safeParse(value);
    if (parsed.success) result[name] = parsed.data;
  }
  return result;
}

export function observationType(
  name: TraceSpanName,
): SafeTraceAttributes["langfuse.observation.type"] {
  switch (name) {
    case "support.ai.classification":
    case "support.ai.resolution":
      return "GENERATION";
    case "support.embedding.query":
      return "EMBEDDING";
    case "support.retrieval":
    case "support.vector_search":
      return "RETRIEVER";
    case "support.grounding.validate":
      return "GUARDRAIL";
    case "support.resolution.persist":
      return "TOOL";
    case "support.ticket.resolve":
      return "CHAIN";
  }
}

function wrapSpan(span: Span, onFail?: () => void): ActiveTraceSpan {
  return {
    setAttributes(attributes) {
      span.setAttributes(definedAttributes(attributes));
    },
    addRetryEvent(event) {
      span.addEvent(
        "support.retry",
        definedAttributes({
          "support.attempt": event.attempt,
          "support.retry_count": event.retryCount,
          "support.retry_delay_ms": Math.max(0, Math.round(event.delayMs)),
          "error.type": event.errorCode,
        }),
      );
    },
    fail(code) {
      onFail?.();
      span.setAttribute("error.type", code);
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
  };
}

class OpenTelemetryTracing implements AppTracing {
  private readonly tracer = trace.getTracer(TRACE_INSTRUMENTATION_SCOPE);

  async withSpan<T>(
    name: TraceSpanName,
    options: { attributes?: SafeTraceAttributes; root?: boolean },
    callback: (span: ActiveTraceSpan) => Promise<T>,
  ): Promise<T> {
    const parentContext = options.root ? ROOT_CONTEXT : context.active();
    const attributes = {
      "langfuse.observation.type": observationType(name),
      ...(options.attributes ?? {}),
    };
    return this.tracer.startActiveSpan(
      name,
      { attributes: definedAttributes(attributes) },
      parentContext,
      async (otelSpan) => {
        let failed = false;
        const span = wrapSpan(otelSpan, () => {
          failed = true;
        });
        try {
          const result = await callback(span);
          if (otelSpan.isRecording() && !failed) {
            otelSpan.setStatus({ code: SpanStatusCode.OK });
          }
          return result;
        } catch (error) {
          if (otelSpan.isRecording()) otelSpan.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          otelSpan.end();
        }
      },
    );
  }

  getActiveSpan(): ActiveTraceSpan | undefined {
    const span = trace.getActiveSpan();
    return span ? wrapSpan(span) : undefined;
  }

  getActiveCorrelation(): TraceCorrelation | undefined {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
    return { otelTraceId: spanContext.traceId, otelSpanId: spanContext.spanId };
  }
}

export const tracing: AppTracing = new OpenTelemetryTracing();

export function withTraceCorrelation<T extends Record<string, unknown>>(
  fields: T,
  appTracing: AppTracing = tracing,
): T & Partial<TraceCorrelation> {
  return { ...fields, ...appTracing.getActiveCorrelation() };
}
