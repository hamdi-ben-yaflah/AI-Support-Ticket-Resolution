export type EvaluationSetupErrorCode = "configuration" | "dataset" | "unexpected";

export class EvaluationSetupError extends Error {
  readonly code: EvaluationSetupErrorCode;

  constructor(code: EvaluationSetupErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "EvaluationSetupError";
    this.code = code;
  }
}

export function isEvaluationSetupError(error: unknown): error is EvaluationSetupError {
  return error instanceof EvaluationSetupError;
}
