import { zValidator } from "@hono/zod-validator";
import { id } from "@gtrp/shared";
import { z } from "zod";
import { errors } from "../errors/index.js";

type Target = "json" | "query" | "param";

export function issuesToDetails(issues: readonly z.core.$ZodIssue[]) {
  // Never echo submitted values back (they may contain keys or passwords).
  return issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message }));
}

/** zod validation for every endpoint; failures become a uniform VALIDATION_FAILED error. */
export function validate<T extends z.ZodType, K extends Target>(target: K, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw errors.validation(issuesToDetails(result.error.issues));
  });
}

export const idParam = z.object({ id });
