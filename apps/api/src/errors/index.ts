import { CONFIRMED_DENIAL_CODES, ERROR_CODES, type ErrorCode } from "@gtrp/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The only error type whose message is ever shown to clients. Anything else
 * becomes a generic INTERNAL_ERROR so database errors, stack traces and
 * secrets never leak.
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }

  get retryable(): boolean {
    if (CONFIRMED_DENIAL_CODES.includes(this.code)) return false;
    return this.status === 429 || this.status >= 500 || this.code === ERROR_CODES.CLOCK_SKEW;
  }
}

export const errors = {
  validation: (details: ErrorDetail[]) =>
    new AppError(400, ERROR_CODES.VALIDATION_FAILED, "The request is invalid.", details),
  unauthenticated: () => new AppError(401, ERROR_CODES.UNAUTHENTICATED, "Authentication is required."),
  invalidCredentials: () => new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, "Email or password is incorrect."),
  forbidden: () => new AppError(403, ERROR_CODES.FORBIDDEN, "You do not have permission to perform this action."),
  notFound: (what = "Resource") => new AppError(404, ERROR_CODES.NOT_FOUND, `${what} was not found.`),
  conflict: (message = "The resource was modified concurrently. Reload and try again.") =>
    new AppError(409, ERROR_CODES.CONFLICT, message),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, ERROR_CODES.RATE_LIMITED, "Too many requests. Try again later.", undefined, {
      "Retry-After": String(retryAfterSeconds),
    }),
  invalidTransition: (from: string, action: string) =>
    new AppError(409, ERROR_CODES.INVALID_TRANSITION, `Cannot ${action} a license that is ${from}.`),
  license: (code: ErrorCode, message: string, status: ContentfulStatusCode = 403) => new AppError(status, code, message),
};
