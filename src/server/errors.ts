import type { ZodError } from "zod";

/**
 * Stable, machine-readable error codes shared by server actions and the REST API.
 * UI layers map codes to localized messages; raw internal messages are never shown.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "BUSINESS_RULE_VIOLATION"
  | "INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  BUSINESS_RULE_VIOLATION: 422,
  INTERNAL: 500,
};

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export const unauthenticated = (message = "Authentication required") =>
  new AppError("UNAUTHENTICATED", message);

export const forbidden = (message = "You do not have permission to perform this action") =>
  new AppError("FORBIDDEN", message);

/**
 * Also used when a resource exists but belongs to another tenant, so that
 * responses never reveal whether another organization's record exists.
 */
export const notFound = (resource: string) =>
  new AppError("NOT_FOUND", `${resource} not found`, { resource });

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError("CONFLICT", message, details);

export const businessRuleViolation = (
  rule: string,
  message: string,
  details?: Record<string, unknown>,
) => new AppError("BUSINESS_RULE_VIOLATION", message, { rule, ...details });

export function validationFailed(error: ZodError): AppError {
  const issues: FieldIssue[] = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return new AppError("VALIDATION_FAILED", "Input validation failed", { issues });
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

/**
 * Convert any thrown value into a safe response body. Unknown errors become a
 * generic INTERNAL error so stack traces and internals never leak to clients.
 */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.httpStatus,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "An unexpected error occurred" } },
  };
}
