import { useState } from "react";
import { Link } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { Alert, EmptyState, ErrorState, Loading } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { useQueryState } from "../hooks/useQueryState";
import { api, type AdminActivationRow } from "../services/api";
import { fmtDate, shortId } from "../services/format";
import { t } from "../i18n";

const TABS = [
  { value: "", label: "All" },
  { value: "web", label: "Web App" },
  { value: "mt4", label: "MT4" },
  { value: "mt5", label: "MT5" },
];

export function ActivationsPage() {
  const { values, page, set } = useQueryState(["activation_type", "status"] as const);
  const status = values.status || "active";
  const { data, error, loading, reload } = useAsync(() => api.activations({ activation_type: values.activation_type, status, page, page_size: 25 }), [values.activation_type, status, page]);
  const [target, setTarget] = useState<AdminActivationRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section>
      <div className="page-head">
        <h1>{t("Activations")}</h1>
      </div>
      <div className="tabs" role="tablist" aria-label={t("Activation type")}>
        {TABS.map((tab) => (
          <button key={tab.value} type="button" role="tab" aria-selected={values.activation_type === tab.value} className={values.activation_type === tab.value ? "tab active" : "tab"} onClick={() => set({ activation_type: tab.value })}>
            {t(tab.label)}
          </button>
        ))}
        <label className="field inline push-right">
          <span>{t("Status")}</span>
          <select value={status} onChange={(e) => set({ status: e.target.value })}>
            <option value="active">{t("Active")}</option>
            <option value="revoked">{t("Revoked")}</option>
          </select>
        </label>
      </div>
      {notice && (
        <Alert kind="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {loading && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && !loading && (
        <>
          {data.data.length === 0 ? (
            <EmptyState>{t("No activations.")}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("Type")}</th>
                    <th>{t("Customer")}</th>
                    <th>{t("Label")}</th>
                    <th>{t("Status")}</th>
                    <th>{t("Last seen")}</th>
                    <th>{t("License")}</th>
                    <th>
                      <span className="sr-only">{t("Actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((a) => (
                    <tr key={a.id}>
                      <td>{a.activation_type.toUpperCase()}</td>
                      <td>
                        <Link to={`/customers/${a.user_id}`}>{a.email}</Link>
                      </td>
                      <td>{a.label ?? <span className="muted">{shortId(a.id)}</span>}</td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                      <td>{fmtDate(a.last_seen_at)}</td>
                      <td>
                        <Link to={`/licenses/${a.license_id}`}>{shortId(a.license_id)}</Link>
                      </td>
                      <td>
                        {a.status === "active" && (
                          <button type="button" className="btn btn-small btn-warn" onClick={() => setTarget(a)}>
                            {t("Revoke")}
                          </button>
                        )}
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
      {target && (
        <ConfirmDialog
          title={t("Revoke this activation?")}
          message={t("{email}'s {type} activation is deactivated and its slot is freed.", { email: target.email, type: target.activation_type.toUpperCase() })}
          confirmLabel={t("Revoke activation")}
          danger
          onConfirm={async (reason) => {
            await api.revokeActivation(target.id, reason);
            setNotice(t("Activation revoked."));
            reload();
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
