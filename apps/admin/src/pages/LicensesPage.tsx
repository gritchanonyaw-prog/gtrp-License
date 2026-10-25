import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { CreateLicenseDialog } from "../components/CreateLicenseDialog";
import { KeyReveal } from "../components/KeyReveal";
import { Pagination } from "../components/Pagination";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { useQueryState } from "../hooks/useQueryState";
import { api } from "../services/api";
import { fmtDate } from "../services/format";

export function LicensesPage() {
  const { values, page, set } = useQueryState(["status", "plan_id", "email", "expiring_within_days"] as const);
  const [email, setEmail] = useState(values.email);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; id: string } | null>(null);
  const navigate = useNavigate();
  const plans = useAsync(() => api.plans(), []);
  const { data, error, loading, reload } = useAsync(
    () => api.licenses({ ...values, page, page_size: 25 }),
    [values.status, values.plan_id, values.email, values.expiring_within_days, page],
  );

  return (
    <section>
      <div className="page-head">
        <h1>Licenses</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Create license
        </button>
      </div>
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ email: email.trim() });
        }}
      >
        <label className="field inline">
          <span>Customer email</span>
          <input type="search" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field inline">
          <span>Status</span>
          <select value={values.status} onChange={(e) => set({ status: e.target.value, expiring_within_days: "" })}>
            <option value="">All</option>
            {["created", "active", "expired", "suspended", "revoked"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Plan</span>
          <select value={values.plan_id} onChange={(e) => set({ plan_id: e.target.value })}>
            <option value="">All</option>
            {plans.data?.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Expiring</span>
          <select value={values.expiring_within_days} onChange={(e) => set({ expiring_within_days: e.target.value, status: "" })}>
            <option value="">Any time</option>
            <option value="7">Within 7 days</option>
            <option value="30">Within 30 days</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {loading && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data && !loading && (
        <>
          {data.data.length === 0 ? (
            <EmptyState>No licenses match these filters.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Key</th>
                    <th>Starts</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link to={`/licenses/${l.id}`}>{l.email}</Link>
                      </td>
                      <td>{l.plan_name}</td>
                      <td>
                        <StatusBadge status={l.status} />
                      </td>
                      <td>
                        <code>{l.key_hint ? `…${l.key_hint}` : "—"}</code>
                      </td>
                      <td>{fmtDate(l.starts_at)}</td>
                      <td>{fmtDate(l.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination meta={data.pagination} onPage={(p) => set({ page: String(p) })} />
        </>
      )}
      {creating && (
        <CreateLicenseDialog
          onClose={() => setCreating(false)}
          onCreated={(key, id) => {
            setCreating(false);
            setCreated({ key, id });
            reload();
          }}
        />
      )}
      {created && (
        <KeyReveal
          licenseKey={created.key}
          onClose={() => {
            const id = created.id;
            setCreated(null);
            navigate(`/licenses/${id}`);
          }}
        />
      )}
    </section>
  );
}
