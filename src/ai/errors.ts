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
  cause?: unknown;
};

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly retryCount: number;
  readonly finishReason?: string;

  constructor(code: LlmErrorCode, message: string, options: LlmErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "LlmError";
    this.code = code;
    this.retryable = options.retryable;
    this.retryCount = options.retryCount ?? 0;
    this.finishReason = options.finishReason;
  }
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
