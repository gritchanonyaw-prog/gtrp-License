import { ERROR_CODES } from "@gtrp/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { nowIso } from "../clock.js";
import { AppError } from "../errors/index.js";
import { log } from "../security/redact.js";

export function errorBody(c: Context<AppEnv>, e: AppError) {
  return {
    error: {
      code: e.code,
      message: e.message,
      request_id: c.get("requestId") ?? "unknown",
      retryable: e.retryable,
      /** Lets EA/web clients correct their clock offset after a CLOCK_SKEW error. */
      server_time: nowIso(),
      ...(e.details ? { details: e.details } : {}),
    },
  };
}

export function onError(err: Error, c: Context<AppEnv>) {
  let e: AppError;
  if (err instanceof AppError) {
    e = err;
  } else if (err instanceof HTTPException) {
    const status = err.status;
    e =
      status === 413
        ? new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, "The request body is too large.")
        : status === 400
          ? new AppError(400, ERROR_CODES.VALIDATION_FAILED, "The request body is not valid JSON.")
          : new AppError(500, ERROR_CODES.INTERNAL_ERROR, "An unexpected error occurred.");
  } else {
    // Log the real error server-side (redacted); return nothing internal to the client.
    log("error", "unhandled_error", { request_id: c.get("requestId"), name: err.name, message: err.message, path: c.req.path });
    e = new AppError(500, ERROR_CODES.INTERNAL_ERROR, "An unexpected error occurred.");
  }
  for (const [k, v] of Object.entries(e.headers ?? {})) c.header(k, v);
  return c.json(errorBody(c, e), e.status);
}

export function notFound(c: Context<AppEnv>) {
  return c.json(errorBody(c, new AppError(404, ERROR_CODES.NOT_FOUND, "Endpoint not found.")), 404);
}
