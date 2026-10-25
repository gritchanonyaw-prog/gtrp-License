import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CreateLicenseDialog } from "../components/CreateLicenseDialog";
import { KeyReveal } from "../components/KeyReveal";
import { Alert, EmptyState, ErrorState, Loading } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { api } from "../services/api";
import { fmtDate, fmtMoney } from "../services/format";

export function CustomerDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(() => api.customer(id), [id]);
  const [dialog, setDialog] = useState<null | "suspend" | "activate" | "delete" | "license">(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error !== null) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const c = data.customer;

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="muted small">
            <Link to="/customers">Customers</Link> /
          </p>
          <h1>{c.email}</h1>
          <p className="muted small">
            ID <code>{c.id}</code> · joined {fmtDate(c.created_at)} · <StatusBadge status={c.status} />
          </p>
        </div>
        {c.status !== "deleted" && (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setDialog("license")}>
              New license
            </button>
            {c.status === "active" ? (
              <button type="button" className="btn btn-warn" onClick={() => setDialog("suspend")}>
                Suspend account
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setDialog("activate")}>
                Reactivate account
              </button>
            )}
            <button type="button" className="btn btn-danger" onClick={() => setDialog("delete")}>
              Delete account
            </button>
          </div>
        )}
      </div>
      {notice && (
        <Alert kind="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <h2>Licenses</h2>
      {data.licenses.length === 0 ? (
        <EmptyState>This customer has no licenses.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Status</th>
                <th>Key</th>
                <th>Expires</th>
                <th>Web / EA / Accounts</th>
              </tr>
            </thead>
            <tbody>
              {data.licenses.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/licenses/${l.id}`}>{l.plan.name}</Link>
                  </td>
                  <td>
                    <StatusBadge status={l.effective_status} />
                    {l.in_grace && <StatusBadge status="expired" label="grace" />}
                  </td>
                  <td>
                    <code>{l.key_hint ?? "not issued"}</code>
                  </td>
                  <td>{fmtDate(l.expires_at)}</td>
                  <td>
                    {l.usage.web.used}/{l.usage.web.max} · {l.usage.ea.used}/{l.usage.ea.max} · {l.usage.trading_accounts.used}/{l.usage.trading_accounts.max}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Payments and renewals</h2>
      {data.payments.length === 0 ? (
        <EmptyState>No payments recorded.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Paid</th>
                <th>Provider ref</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.created_at)}</td>
                  <td>{fmtMoney(p.amount_minor, p.currency)}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{fmtDate(p.paid_at)}</td>
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
      <p>
        <Link to={`/audit?target_user_id=${c.id}`}>View this customer’s audit history</Link>
      </p>

      {dialog === "license" && (
        <CreateLicenseDialog
          fixedUserId={c.id}
          onClose={() => setDialog(null)}
          onCreated={(key) => {
            setDialog(null);
            setNewKey(key);
            reload();
          }}
        />
      )}
      {newKey && <KeyReveal licenseKey={newKey} onClose={() => setNewKey(null)} />}
      {(dialog === "suspend" || dialog === "activate") && (
        <ConfirmDialog
          title={dialog === "suspend" ? "Suspend this account?" : "Reactivate this account?"}
          message={
            dialog === "suspend"
              ? "The customer is signed out everywhere and all of their licenses stop working until the account is reactivated."
              : "The customer can sign in again and their licenses work according to their own status."
          }
          confirmLabel={dialog === "suspend" ? "Suspend account" : "Reactivate"}
          danger={dialog === "suspend"}
          onConfirm={async (reason) => {
            await api.setCustomerStatus(c.id, dialog === "suspend" ? "suspended" : "active", reason);
            setNotice(dialog === "suspend" ? "Account suspended." : "Account reactivated.");
            reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete this account permanently?"
          message={
            <>
              <p>The email and password are erased, all licenses are revoked, and all devices are deactivated. Payment records and the audit log are kept for legal retention.</p>
              <p>
                <strong>This cannot be undone.</strong>
              </p>
            </>
          }
          confirmLabel="Delete account"
          danger
          onConfirm={async (reason) => {
            await api.deleteCustomer(c.id, reason);
            navigate("/customers");
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
