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
        <h1>Activations</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="Activation type">
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={values.activation_type === t.value} className={values.activation_type === t.value ? "tab active" : "tab"} onClick={() => set({ activation_type: t.value })}>
            {t.label}
          </button>
        ))}
        <label className="field inline push-right">
          <span>Status</span>
          <select value={status} onChange={(e) => set({ status: e.target.value })}>
            <option value="active">Active</option>
            <option value="revoked">Revoked</option>
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
            <EmptyState>No activations.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Customer</th>
                    <th>Label</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>License</th>
                    <th>
                      <span className="sr-only">Actions</span>
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
                            Revoke
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
          title="Revoke this activation?"
          message={`${target.email}'s ${target.activation_type.toUpperCase()} activation is deactivated and its slot is freed.`}
          confirmLabel="Revoke activation"
          danger
          onConfirm={async (reason) => {
            await api.revokeActivation(target.id, reason);
            setNotice("Activation revoked.");
            reload();
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
