export type RetrievalErrorCode = "unavailable" | "insufficient_evidence";

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RetrievalErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "RetrievalError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

export function isRetrievalError(error: unknown): error is RetrievalError {
  return error instanceof RetrievalError;
}
