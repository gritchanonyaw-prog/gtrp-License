import { changePasswordInput, deleteAccountInput, loginInput, mfaEnableInput, registerInput } from "@gtrp/shared";
import { Hono } from "hono";
import { nowIso } from "../clock.js";
import type { AppEnv } from "../env.js";
import { requireAuth, requireSession } from "../middleware/auth.js";
import { revokeSession } from "../repositories/sessions.js";
import * as auth from "../services/authService.js";
import { validate } from "../validators/index.js";

export const authRoutes = new Hono<AppEnv>()
  .post("/auth/register", validate("json", registerInput), async (c) => {
    const { email, password } = c.req.valid("json");
    const user = await auth.register(c, email, password);
    return c.json({ user }, 201);
  })
  .post("/auth/login", validate("json", loginInput), async (c) => {
    const input = c.req.valid("json");
    const r = await auth.login(c, input);
    const session = { expires_at: r.expiresAt, mfa_verified: r.mfaVerified };
    if (input.session_mode === "token") return c.json({ user: r.user, session, token: r.token });
    auth.setSessionCookie(c, r.token, r.expiresAt);
    return c.json({ user: r.user, session });
  })
  .post("/auth/logout", async (c) => {
    const s = c.get("session");
    if (s) await revokeSession(c.env.DB, s.id, nowIso());
    auth.clearSessionCookie(c);
    return c.body(null, 204);
  })
  .post("/auth/change-password", requireAuth, validate("json", changePasswordInput), async (c) => {
    const b = c.req.valid("json");
    await auth.changePassword(c, requireSession(c), b.current_password, b.new_password);
    return c.body(null, 204);
  })
  .post("/auth/mfa/setup", requireAuth, async (c) => {
    return c.json(await auth.beginMfaSetup(c, requireSession(c)));
  })
  .post("/auth/mfa/enable", requireAuth, validate("json", mfaEnableInput), async (c) => {
    await auth.enableMfa(c, requireSession(c), c.req.valid("json").totp_code);
    return c.json({ mfa_enabled: true });
  })
  .get("/me", requireAuth, (c) => {
    const s = requireSession(c);
    return c.json({ user: s.user, session: { expires_at: s.expiresAt, mfa_verified: s.mfaVerified } });
  })
  /** Customer self-service deletion request (re-authenticated with the password). */
  .post("/me/delete", requireAuth, validate("json", deleteAccountInput), async (c) => {
    await auth.deleteOwnAccount(c, requireSession(c), c.req.valid("json").password);
    auth.clearSessionCookie(c);
    return c.body(null, 204);
  });
