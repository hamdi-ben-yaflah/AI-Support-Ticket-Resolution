export type LlmErrorCode =
  | "timeout"
  | "unavailable"
  | "refused"
  | "truncated"
  | "invalid_output"
  | "configuration"
  | "unexpected";

type LlmErrorOptions = {
  retryable: boolean;
  retryCount?: number;
  finishReason?: string;
  providerRequestId?: string;
  providerStatusCode?: number;
  cause?: unknown;
};

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly retryCount: number;
  readonly finishReason?: string;
  readonly providerRequestId?: string;
  readonly providerStatusCode?: number;

  constructor(code: LlmErrorCode, message: string, options: LlmErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.code = code;
    this.retryable = options.retryable;
    this.retryCount = options.retryCount ?? 0;
    this.finishReason = options.finishReason;
    this.providerRequestId = options.providerRequestId;
    this.providerStatusCode = options.providerStatusCode;
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
