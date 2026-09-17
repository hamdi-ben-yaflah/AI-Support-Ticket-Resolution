import "server-only";

import { z } from "zod";

import {
  InvestigationToolNameSchema,
  InvestigationToolPurposeSchema,
  InvestigationToolResultSchema,
  InvestigationToolStatusSchema,
  InvestigationValidationOutcomeSchema,
  TOOL_SCHEMA_VERSION,
  type InvestigationToolPurpose,
  type InvestigationToolResult,
} from "@/domain/investigation-tools";
import { InvestigationToolError, InvestigationToolTimeoutError } from "@/investigation/errors";
import type { InvestigationToolCatalog } from "@/investigation/catalog";
import {
  addValidatedResultProvenance,
  authorizeToolArguments,
  type IdentifierProvenance,
} from "@/investigation/provenance";

export const MAX_INVESTIGATION_TOOL_RESULT_BYTES = 16_384;

const ToolDecisionEnvelopeSchema = z
  .object({
    toolName: z.unknown(),
    purpose: z.unknown(),
    arguments: z.unknown(),
  })
  .strict();

export const ToolAttemptSchema = z
  .object({
    toolName: InvestigationToolNameSchema.nullable(),
    purpose: InvestigationToolPurposeSchema.nullable(),
    status: InvestigationToolStatusSchema,
    durationMs: z.number().int().nonnegative().max(30_000),
    validation: InvestigationValidationOutcomeSchema,
    resultCount: z.number().int().nonnegative().max(5),
    evidenceKeys: z.array(z.string().min(1).max(100)).max(5),
  })
  .strict();

export const ToolAttemptTelemetrySchema = ToolAttemptSchema.omit({ evidenceKeys: true }).strict();

export type ToolAttempt = z.infer<typeof ToolAttemptSchema>;
export type ToolAttemptTelemetry = z.infer<typeof ToolAttemptTelemetrySchema>;

export type ToolDispatchOutcome = Readonly<{
  attempt: ToolAttempt;
  result: InvestigationToolResult | null;
  provenance: IdentifierProvenance;
}>;

export interface ToolDeadlineRunner {
  run<T>(input: {
    timeoutMs: number;
    parentSignal?: AbortSignal;
    operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T>;
}

export const defaultToolDeadlineRunner: ToolDeadlineRunner = {
  run<T>(input: {
    timeoutMs: number;
    parentSignal?: AbortSignal;
    operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanUp = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        input.parentSignal?.removeEventListener("abort", abortFromParent);
      };
      const resolveOnce = (value: T) => {
        if (settled) return;
        settled = true;
        cleanUp();
        resolve(value);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(error);
      };
      const abortFromParent = () => {
        const reason = input.parentSignal?.reason ?? new DOMException("Aborted", "AbortError");
        controller.abort(reason);
        rejectOnce(reason);
      };

      if (input.parentSignal?.aborted) {
        abortFromParent();
        return;
      }

      input.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
      timeoutHandle = setTimeout(() => {
        const error = new InvestigationToolTimeoutError();
        controller.abort(error);
        rejectOnce(error);
      }, input.timeoutMs);

      Promise.resolve()
        .then(() => input.operation(controller.signal))
        .then(resolveOnce, rejectOnce);
    });
  },
};

function monotonicNow(): number {
  return performance.now();
}

function safeKnownName(rawDecision: unknown) {
  if (typeof rawDecision !== "object" || rawDecision === null) return null;
  const parsed = InvestigationToolNameSchema.safeParse(Reflect.get(rawDecision, "toolName"));
  return parsed.success ? parsed.data : null;
}

function invalidAttempt(input: {
  toolName: ReturnType<typeof safeKnownName>;
  purpose: InvestigationToolPurpose | null;
  durationMs: number;
}): ToolAttempt {
  return ToolAttemptSchema.parse({
    toolName: input.toolName,
    purpose: input.purpose,
    status: "invalid_request",
    durationMs: input.durationMs,
    validation: "failed",
    resultCount: 0,
    evidenceKeys: [],
  });
}

function elapsedMilliseconds(startedAt: number, now: () => number): number {
  return Math.min(30_000, Math.max(0, Math.round(now() - startedAt)));
}

function unavailableResult(toolName: NonNullable<ReturnType<typeof safeKnownName>>) {
  return InvestigationToolResultSchema.parse({
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolName,
    status: "unavailable",
    evidence: [],
  });
}

function validateResult(rawResult: unknown, maximumBytes: number): InvestigationToolResult {
  const parsed = InvestigationToolResultSchema.safeParse(rawResult);
  if (!parsed.success) throw new InvestigationToolError("invalid_result");
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > maximumBytes) {
    throw new InvestigationToolError("result_too_large");
  }
  return parsed.data;
}

export function toToolAttemptTelemetry(attempt: ToolAttempt): ToolAttemptTelemetry {
  return ToolAttemptTelemetrySchema.parse({
    toolName: attempt.toolName,
    purpose: attempt.purpose,
    status: attempt.status,
    durationMs: attempt.durationMs,
    validation: attempt.validation,
    resultCount: attempt.resultCount,
  });
}

export async function dispatchInvestigationTool(
  rawDecision: unknown,
  options: {
    catalog: InvestigationToolCatalog;
    provenance: IdentifierProvenance;
    traceId: string;
    timeoutMs: number;
    parentSignal?: AbortSignal;
    deadlineRunner?: ToolDeadlineRunner;
    now?: () => number;
    maximumResultBytes?: number;
  },
): Promise<ToolDispatchOutcome> {
  const now = options.now ?? monotonicNow;
  const startedAt = now();
  const knownName = safeKnownName(rawDecision);
  const entry = knownName ? options.catalog.entries[knownName] : undefined;
  const envelope = ToolDecisionEnvelopeSchema.safeParse(rawDecision);

  if (!entry || !envelope.success) {
    return {
      attempt: invalidAttempt({
        toolName: knownName,
        purpose: entry?.purpose ?? null,
        durationMs: elapsedMilliseconds(startedAt, now),
      }),
      result: null,
      provenance: options.provenance,
    };
  }

  const suppliedPurpose = InvestigationToolPurposeSchema.safeParse(envelope.data.purpose);
  const parsedArguments = entry.argumentsSchema.safeParse(envelope.data.arguments);
  if (
    !suppliedPurpose.success ||
    suppliedPurpose.data !== entry.purpose ||
    !parsedArguments.success ||
    !authorizeToolArguments(entry.name, parsedArguments.data, options.provenance)
  ) {
    return {
      attempt: invalidAttempt({
        toolName: entry.name,
        purpose: entry.purpose,
        durationMs: elapsedMilliseconds(startedAt, now),
      }),
      result: null,
      provenance: options.provenance,
    };
  }

  let rawResult: unknown;
  try {
    rawResult = await (options.deadlineRunner ?? defaultToolDeadlineRunner).run({
      timeoutMs: options.timeoutMs,
      ...(options.parentSignal ? { parentSignal: options.parentSignal } : {}),
      operation: (signal) =>
        entry.handler(parsedArguments.data, { traceId: options.traceId, signal }),
    });
  } catch (error) {
    if (error instanceof InvestigationToolTimeoutError) {
      rawResult = unavailableResult(entry.name);
    } else if (options.parentSignal?.aborted) {
      throw error;
    } else {
      throw new InvestigationToolError("source_failure");
    }
  }

  const entryResult = entry.resultSchema.safeParse(rawResult);
  if (!entryResult.success) throw new InvestigationToolError("invalid_result");
  const result = validateResult(
    entryResult.data,
    options.maximumResultBytes ?? MAX_INVESTIGATION_TOOL_RESULT_BYTES,
  );
  const evidenceKeys = result.evidence.map((evidence) => evidence.evidenceKey);
  const attempt = ToolAttemptSchema.parse({
    toolName: entry.name,
    purpose: entry.purpose,
    status: result.status,
    durationMs: elapsedMilliseconds(startedAt, now),
    validation: "passed",
    resultCount: result.evidence.length,
    evidenceKeys,
  });

  return {
    attempt,
    result,
    provenance: addValidatedResultProvenance(options.provenance, result),
  };
}
