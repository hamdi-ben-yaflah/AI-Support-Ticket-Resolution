export type EmbeddingErrorCode =
  | "timeout"
  | "unavailable"
  | "configuration"
  | "invalid_output"
  | "unexpected";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly retryable: boolean;
  readonly retryCount: number;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options: { retryable: boolean; retryCount?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "EmbeddingError";
    this.code = code;
    this.retryable = options.retryable;
    this.retryCount = options.retryCount ?? 0;
  }
}

export function isEmbeddingError(error: unknown): error is EmbeddingError {
  return error instanceof EmbeddingError;
}
