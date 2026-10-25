import { Link } from "react-router";
import { Pagination } from "../components/Pagination";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { useQueryState } from "../hooks/useQueryState";
import { api } from "../services/api";
import { fmtDate, fmtMoney, shortId } from "../services/format";
import { t } from "../i18n";

/** Read-only: payment status changes only through verified provider webhooks. */
export function PaymentsPage() {
  const { values, page, set } = useQueryState(["status"] as const);
  const { data, error, loading, reload } = useAsync(() => api.payments({ status: values.status, page, page_size: 25 }), [values.status, page]);
  return (
    <section>
      <div className="page-head">
        <h1>{t("Payments")}</h1>
      </div>
      <p className="muted">{t("Statuses shown here come only from provider webhooks with verified signatures. A customer returning from a checkout page does not mark a payment as paid.")}</p>
      <div className="filters">
        <label className="field inline">
          <span>{t("Status")}</span>
          <select value={values.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">{t("All")}</option>
            {["pending", "paid", "failed", "refunded"].map((s) => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && !loading && (
        <>
          {data.data.length === 0 ? (
            <EmptyState>{t("No payments yet.")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("Created")}</th>
                    <th>{t("Customer")}</th>
                    <th>{t("Plan")}</th>
                    <th>{t("Amount")}</th>
                    <th>{t("Status")}</th>
                    <th>{t("Paid")}</th>
                    <th>{t("License")}</th>
                    <th>{t("Provider")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((p) => (
                    <tr key={p.id}>
                      <td>{fmtDate(p.created_at)}</td>
                      <td>
                        <Link to={`/customers/${p.user_id}`}>{p.email ?? shortId(p.user_id)}</Link>
                      </td>
                      <td>{p.plan_code}</td>
                      <td>{fmtMoney(p.amount_minor, p.currency)}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td>{fmtDate(p.paid_at)}</td>
                      <td>{p.license_id ? <Link to={`/licenses/${p.license_id}`}>{shortId(p.license_id)}</Link> : "—"}</td>
                      <td>
                        <code>
                          {p.provider}:{p.provider_ref}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination meta={data.pagination} onPage={(p) => set({ page: String(p) })} />
        </>
      )}
    </section>
  );
}
