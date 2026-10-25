import { z } from "zod";
import { USER_ROLES, USER_STATUSES } from "../constants/index.js";
import { email, id, isoUtc } from "./common.js";

export const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters");

export const registerInput = z.object({ email, password }).strict();
export type RegisterInput = z.input<typeof registerInput>;

export const loginInput = z
  .object({
    email,
    password: z.string().min(1).max(128),
    /** 6-digit TOTP code; required for administrators with MFA enabled. */
    totp_code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    /**
     * cookie (default): HttpOnly session cookie, used by the admin dashboard.
     * token: session token returned in the body for the Web App / API clients. Not allowed for admins.
     */
    session_mode: z.enum(["cookie", "token"]).default("cookie"),
  })
  .strict();
export type LoginInput = z.input<typeof loginInput>;

export const changePasswordInput = z
  .object({ current_password: z.string().min(1).max(128), new_password: password })
  .strict();

export const mfaEnableInput = z.object({ totp_code: z.string().regex(/^\d{6}$/) }).strict();

export const deleteAccountInput = z.object({ password: z.string().min(1).max(128) }).strict();

export const publicUser = z.object({
  id,
  email: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  mfa_enabled: z.boolean(),
  created_at: isoUtc,
});
export type PublicUser = z.infer<typeof publicUser>;

export const meResponse = z.object({
  user: publicUser,
  session: z.object({ expires_at: isoUtc, mfa_verified: z.boolean() }),
});
export type MeResponse = z.infer<typeof meResponse>;
