import { z } from "zod";

/** ISO 8601 UTC timestamp with a trailing Z, e.g. 2026-10-25T09:57:41.000Z */
export const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "Must be an ISO 8601 UTC timestamp ending in Z")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date");

export const id = z.uuid();

export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "ISO 4217 currency code, e.g. THB or USD");

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const paginationMeta = z.object({
  page: z.number().int(),
  page_size: z.number().int(),
  total: z.number().int(),
});
export type PaginationMeta = z.infer<typeof paginationMeta>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), pagination: paginationMeta });
}

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
    retryable: z.boolean().optional(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;
