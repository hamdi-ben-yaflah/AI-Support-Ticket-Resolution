export type InvestigationToolErrorCode = "invalid_result" | "result_too_large" | "source_failure";

export class InvestigationToolError extends Error {
  readonly code: InvestigationToolErrorCode;

  constructor(code: InvestigationToolErrorCode) {
    super("The investigation tool returned an unsafe result.");
    this.name = "InvestigationToolError";
    this.code = code;
  }
}

export class ToolSourceUnavailableError extends Error {
  constructor() {
    super("The investigation source is unavailable.");
    this.name = "ToolSourceUnavailableError";
  }
}

export function isToolSourceUnavailableError(error: unknown): error is ToolSourceUnavailableError {
  return error instanceof ToolSourceUnavailableError;
}

export class InvestigationToolTimeoutError extends Error {
  constructor() {
    super("The investigation tool exceeded its deadline.");
    this.name = "InvestigationToolTimeoutError";
  }
}
