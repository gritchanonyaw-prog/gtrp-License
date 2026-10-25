import type { PaymentRow } from "./types.js";

export function getPaymentByProviderRef(db: D1Database, provider: string, providerRef: string) {
  return db.prepare("SELECT * FROM payments WHERE provider = ? AND provider_ref = ?").bind(provider, providerRef).first<PaymentRow>();
}

export function getPayment(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<PaymentRow>();
}

export interface PaymentFilters {
  status?: string | undefined;
  user_id?: string | undefined;
  license_id?: string | undefined;
}

export async function listAdminPayments(db: D1Database, f: PaymentFilters, page: number, pageSize: number) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) (where.push("p.status = ?"), args.push(f.status));
  if (f.user_id) (where.push("p.user_id = ?"), args.push(f.user_id));
  if (f.license_id) (where.push("p.license_id = ?"), args.push(f.license_id));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.user_id, u.email, p.license_id, p.plan_id, pl.code AS plan_code, p.provider, p.provider_ref,
                p.amount_minor, p.currency, p.status, p.paid_at, p.refunded_at, p.created_at
         FROM payments p JOIN users u ON u.id = p.user_id JOIN plans pl ON pl.id = p.plan_id
         ${w} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM payments p ${w}`).bind(...args),
  ]);
  return { rows: rows!.results, total: (total!.results[0] as { n: number }).n };
}
