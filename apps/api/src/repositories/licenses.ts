import type { LicenseRow, PlanRow } from "./types.js";

export type LicenseWithPlan = LicenseRow & {
  plan_code: string;
  plan_name: string;
  plan_billing_period: PlanRow["billing_period"];
  plan_features_json: string;
  plan_max_web_devices: number;
  plan_max_ea_activations: number;
  plan_max_trading_accounts: number;
};

const SELECT_WITH_PLAN = `
  SELECT l.*, p.code AS plan_code, p.name AS plan_name, p.billing_period AS plan_billing_period,
         p.features_json AS plan_features_json, p.max_web_devices AS plan_max_web_devices,
         p.max_ea_activations AS plan_max_ea_activations, p.max_trading_accounts AS plan_max_trading_accounts
  FROM licenses l JOIN plans p ON p.id = l.plan_id`;

export function getLicense(db: D1Database, id: string) {
  return db.prepare(`${SELECT_WITH_PLAN} WHERE l.id = ?`).bind(id).first<LicenseWithPlan>();
}

export function getLicenseByKeyHash(db: D1Database, keyHash: string) {
  return db.prepare(`${SELECT_WITH_PLAN} WHERE l.key_hash = ?`).bind(keyHash).first<LicenseWithPlan>();
}

export async function listLicensesForUser(db: D1Database, userId: string) {
  const r = await db.prepare(`${SELECT_WITH_PLAN} WHERE l.user_id = ? ORDER BY l.created_at DESC`).bind(userId).all<LicenseWithPlan>();
  return r.results;
}

export interface Usage {
  web: number;
  ea: number;
  trading_accounts: number;
}

export async function getUsage(db: D1Database, licenseIds: string[]): Promise<Map<string, Usage>> {
  const out = new Map<string, Usage>();
  for (const id of licenseIds) out.set(id, { web: 0, ea: 0, trading_accounts: 0 });
  if (licenseIds.length === 0) return out;
  const placeholders = licenseIds.map(() => "?").join(",");
  const r = await db
    .prepare(
      `SELECT license_id,
              SUM(CASE WHEN activation_type = 'web' THEN 1 ELSE 0 END) AS web,
              SUM(CASE WHEN activation_type IN ('mt4','mt5') THEN 1 ELSE 0 END) AS ea,
              COUNT(DISTINCT account_ref_hash) AS trading_accounts
       FROM activations WHERE status = 'active' AND license_id IN (${placeholders}) GROUP BY license_id`,
    )
    .bind(...licenseIds)
    .all<{ license_id: string } & Usage>();
  for (const row of r.results) out.set(row.license_id, { web: row.web, ea: row.ea, trading_accounts: row.trading_accounts });
  return out;
}

export interface AdminLicenseFilters {
  status?: string | undefined;
  plan_id?: string | undefined;
  user_id?: string | undefined;
  email?: string | undefined;
  expiring_before?: string | undefined;
  now?: string | undefined;
}

export async function adminListLicenses(db: D1Database, f: AdminLicenseFilters, page: number, pageSize: number) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) (where.push("l.status = ?"), args.push(f.status));
  if (f.plan_id) (where.push("l.plan_id = ?"), args.push(f.plan_id));
  if (f.user_id) (where.push("l.user_id = ?"), args.push(f.user_id));
  if (f.email) (where.push("u.email LIKE ? ESCAPE '\\'"), args.push(`%${f.email.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
  if (f.expiring_before && f.now) {
    where.push("l.status = 'active' AND l.expires_at IS NOT NULL AND l.expires_at >= ? AND l.expires_at <= ?");
    args.push(f.now, f.expiring_before);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT l.id, l.user_id, u.email, l.plan_id, p.code AS plan_code, p.name AS plan_name, l.status, l.key_hint,
                l.starts_at, l.expires_at, l.grace_until, l.created_at, l.updated_at
         FROM licenses l JOIN plans p ON p.id = l.plan_id JOIN users u ON u.id = l.user_id
         ${w} ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM licenses l JOIN users u ON u.id = l.user_id ${w}`).bind(...args),
  ]);
  return { rows: rows!.results as Record<string, unknown>[], total: (total!.results[0] as { n: number }).n };
}
