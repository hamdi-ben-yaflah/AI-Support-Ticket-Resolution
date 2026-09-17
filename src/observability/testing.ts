import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { observationType } from "@/observability/tracing";
import type {
  ActiveTraceSpan,
  AppTracing,
  NormalizedTraceErrorCode,
  RetryTraceEvent,
  SafeTraceAttributes,
  TraceCorrelation,
  TraceSpanName,
} from "@/observability/tracing";

export type InMemoryTraceEvent = { name: "support.retry"; attributes: RetryTraceEvent };
export type InMemorySpanRecord = {
  id: string;
  parentId?: string;
  name: TraceSpanName;
  attributes: SafeTraceAttributes;
  events: InMemoryTraceEvent[];
  errorCode?: NormalizedTraceErrorCode;
  ended: boolean;
};

export class InMemoryTracing implements AppTracing {
  readonly spans: InMemorySpanRecord[] = [];
  private readonly active = new AsyncLocalStorage<InMemorySpanRecord>();

  async withSpan<T>(
    name: TraceSpanName,
    options: { attributes?: SafeTraceAttributes; root?: boolean },
    callback: (span: ActiveTraceSpan) => Promise<T>,
  ): Promise<T> {
    const parent = options.root ? undefined : this.active.getStore();
    const record: InMemorySpanRecord = {
      id: String(this.spans.length + 1),
      ...(parent ? { parentId: parent.id } : {}),
      name,
      attributes: {
        "langfuse.observation.type": observationType(name),
        ...(options.attributes ?? {}),
      },
      events: [],
      ended: false,
    };
    this.spans.push(record);
    const span = this.createSpan(record);
    return this.active.run(record, async () => {
      try {
        return await callback(span);
      } finally {
        record.ended = true;
      }
    });
  }

  getActiveSpan(): ActiveTraceSpan | undefined {
    const record = this.active.getStore();
    return record ? this.createSpan(record) : undefined;
  }

  getActiveCorrelation(): TraceCorrelation | undefined {
    const record = this.active.getStore();
    return record
      ? { otelTraceId: `trace-${record.id}`, otelSpanId: `span-${record.id}` }
      : undefined;
  }

  private createSpan(record: InMemorySpanRecord): ActiveTraceSpan {
    return {
      setAttributes: (attributes) => Object.assign(record.attributes, attributes),
      addRetryEvent: (attributes) => record.events.push({ name: "support.retry", attributes }),
      fail: (code) => {
        record.errorCode = code;
        record.attributes["error.type"] = code;
      },
    };
  }
}
