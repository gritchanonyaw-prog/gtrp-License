import { Link } from "react-router";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { fmtDate } from "../services/format";
import { currentLocale, t } from "../i18n";

function Stat({ label, value, to }: { label: string; value: number; to?: string }) {
  const body = (
    <>
      <span className="stat-value">{value.toLocaleString(currentLocale())}</span>
      <span className="stat-label">{label}</span>
    </>
  );
  return to ? (
    <Link className="stat" to={to}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = useAsync(() => api.metrics(), []);
  return (
    <section>
      <div className="page-head">
        <h1>{t("Overview")}</h1>
        <button type="button" className="btn" onClick={reload}>
          {t("Refresh")}
        </button>
      </div>
      {loading && !data && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <>
          <div className="stats">
            <Stat label={t("Total customers")} value={data.total_customers} to="/customers" />
            <Stat label={t("Active licenses")} value={data.active_licenses} to="/licenses?status=active" />
            <Stat label={t("Expired licenses")} value={data.expired_licenses} to="/licenses?status=expired" />
            <Stat label={t("Suspended licenses")} value={data.suspended_licenses} to="/licenses?status=suspended" />
            <Stat label={t("Expiring within 7 days")} value={data.expiring_within_7_days} to="/licenses?expiring_within_days=7" />
            <Stat label={t("Activation failures (24 h)")} value={data.activation_failures_24h} to="/audit?event_type=activation.failed" />
          </div>
          <div className="stats">
            <Stat label={t("Active Web devices")} value={data.active_activations.web ?? 0} to="/activations?activation_type=web" />
            <Stat label={t("Active MT4 EAs")} value={data.active_activations.mt4 ?? 0} to="/activations?activation_type=mt4" />
            <Stat label={t("Active MT5 EAs")} value={data.active_activations.mt5 ?? 0} to="/activations?activation_type=mt5" />
          </div>
          <h2>{t("Recent activation failures")}</h2>
          {data.recent_activation_failures.length === 0 ? (
            <EmptyState>{t("No recent activation failures.")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("Time")}</th>
                    <th>{t("Customer")}</th>
                    <th>{t("Operation")}</th>
                    <th>{t("Platform")}</th>
                    <th>{t("Reason")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_activation_failures.map((f) => (
                    <tr key={f.id}>
                      <td>{fmtDate(f.created_at)}</td>
                      <td>{f.license_id ? <Link to={`/licenses/${f.license_id}`}>{f.customer_email ?? t("license")}</Link> : <span className="muted">{t("unknown key")}</span>}</td>
                      <td>{f.operation ?? "—"}</td>
                      <td>{f.platform ?? "—"}</td>
                      <td>
                        <code>{f.code ?? "—"}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">{t("Figures computed by the server at {time}.", { time: fmtDate(data.generated_at) })}</p>
        </>
      )}
    </section>
  );
}
