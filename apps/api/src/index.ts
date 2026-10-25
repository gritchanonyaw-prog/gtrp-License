import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { AppError } from "./errors/index.js";
import type { AppEnv, Env } from "./env.js";
import { loadSession } from "./middleware/auth.js";
import { allowedOrigins, csrfProtection } from "./middleware/csrf.js";
import { notFound, onError } from "./middleware/errorHandler.js";
import { requestId, securityHeaders } from "./middleware/requestContext.js";
import { adminRoutes } from "./routes/admin/index.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { licenseRoutes } from "./routes/licenses.js";
import { runScheduledMaintenance } from "./services/maintenance.js";
import { ERROR_CODES } from "@gtrp/shared";

export const app = new Hono<AppEnv>();

app.use("*", requestId, securityHeaders);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: () => {
      throw new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, "The request body is too large.");
    },
  }),
);
// CORS only for the customer Web App origins (bearer-token clients). Admin endpoints are same-origin only.
app.use("/api/v1/*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/admin")) return next();
  const allowed = allowedOrigins(c.env.APP_ORIGINS, c.req.url);
  return cors({
    origin: (o) => (allowed.has(o) ? o : null),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
    credentials: false,
  })(c, next);
});
app.use("/api/*", csrfProtection, loadSession);

app.route("/api/v1", healthRoutes);
app.route("/api/v1", authRoutes);
app.route("/api/v1", licenseRoutes);
app.route("/api/v1/admin", adminRoutes);

app.notFound(notFound);
app.onError(onError);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
