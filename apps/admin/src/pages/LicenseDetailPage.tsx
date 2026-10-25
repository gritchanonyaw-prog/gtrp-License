import { allowedLicenseActions, type LicenseStatus } from "@gtrp/shared";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, fieldErrors } from "../components/Field";
import { KeyReveal } from "../components/KeyReveal";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Alert, EmptyState, ErrorState, Loading, errorMessage } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { ApiError, api, type LicenseDetail } from "../services/api";
import { fmtDate, isoToLocalInput, localInputToIso, shortId } from "../services/format";
import type { Activation } from "../types";

type StatusAction = "activate" | "suspend" | "reactivate" | "revoke";

const ACTION_COPY: Record<StatusAction, { label: string; done: string; title: string; message: string; danger: boolean }> = {
  activate: { label: "Activate", done: "License activated.", title: "Activate this license?", message: "The customer can start using the Web App and EAs allowed by the plan.", danger: false },
  suspend: { label: "Suspend", done: "License suspended.", title: "Suspend this license?", message: "The Web App and EAs stop allowing new use on their next check. EAs keep managing open positions. You can reactivate later.", danger: true },
  reactivate: { label: "Reactivate", done: "License reactivated.", title: "Reactivate this license?", message: "Access is restored immediately if the license has not expired.", danger: false },
  revoke: { label: "Revoke", done: "License revoked.", title: "Revoke this license permanently?", message: "All devices are deactivated and the key stops working. A revoked license can never be reactivated; you would have to create a new one.", danger: true },
};

export function LicenseDetailPage() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.license(id), [id]);
  const [eventsPage, setEventsPage] = useState(1);
  const events = useAsync(() => api.licenseEvents(id, { page: eventsPage, page_size: 20 }), [id, eventsPage, data]);
  const [action, setAction] = useState<StatusAction | null>(null);
  const [dialog, setDialog] = useState<null | "renew" | "edit" | "reissue">(null);
  const [resetTarget, setResetTarget] = useState<Activation | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error !== null) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const l = data.license;
  const actions = allowedLicenseActions(l.status as LicenseStatus);

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="muted small">
            <Link to="/licenses">Licenses</Link> / {shortId(l.id)}
          </p>
          <h1>
            {l.plan.name} license <StatusBadge status={l.effective_status} /> {l.in_grace && <StatusBadge status="expired" label="in grace period" />}
          </h1>
          {l.user && (
            <p>
              Customer: <Link to={`/customers/${l.user.id}`}>{l.user.email}</Link>
            </p>
          )}
        </div>
        <div className="actions">
          {(["activate", "reactivate", "suspend", "revoke"] as const)
            .filter((a) => actions.includes(a))
            .map((a) => (
              <button key={a} type="button" className={`btn ${ACTION_COPY[a].danger ? (a === "revoke" ? "btn-danger" : "btn-warn") : "btn-primary"}`} onClick={() => setAction(a)}>
                {ACTION_COPY[a].label}
              </button>
            ))}
          {actions.includes("renew") && (
            <button type="button" className="btn" onClick={() => setDialog("renew")}>
              Renew
            </button>
          )}
          {l.status !== "revoked" && (
            <>
              <button type="button" className="btn" onClick={() => setDialog("edit")}>
                Edit plan / dates
              </button>
              <button type="button" className="btn btn-warn" onClick={() => setDialog("reissue")}>
                Reissue key
              </button>
            </>
          )}
        </div>
      </div>
      {notice && (
        <Alert kind="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <dl className="facts">
        <div>
          <dt>License ID</dt>
          <dd>
            <code>{l.id}</code>
          </dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd>
            <code>{l.key_hint ?? "not issued"}</code>
          </dd>
        </div>
        <div>
          <dt>Stored status</dt>
          <dd>{l.status}</dd>
        </div>
        <div>
          <dt>Starts</dt>
          <dd>{fmtDate(l.starts_at)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{l.expires_at ? fmtDate(l.expires_at) : "Never (lifetime)"}</dd>
        </div>
        <div>
          <dt>Grace until</dt>
          <dd>{fmtDate(l.grace_until)}</dd>
        </div>
        <div>
          <dt>Web devices</dt>
          <dd>
            {l.usage.web.used} / {l.usage.web.max}
          </dd>
        </div>
        <div>
          <dt>EA activations</dt>
          <dd>
            {l.usage.ea.used} / {l.usage.ea.max}
          </dd>
        </div>
        <div>
          <dt>Trading accounts</dt>
          <dd>
            {l.usage.trading_accounts.used} / {l.usage.trading_accounts.max}
          </dd>
        </div>
        <div>
          <dt>Features</dt>
          <dd>{l.entitlements.features.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>EA products / platforms</dt>
          <dd>
            {l.entitlements.ea_products.join(", ") || "—"} / {l.entitlements.ea_platforms.join(", ") || "—"}
          </dd>
        </div>
        {l.note && (
          <div>
            <dt>Note</dt>
            <dd>{l.note}</dd>
          </div>
        )}
      </dl>

      <h2>Activations</h2>
      <ActivationTable activations={data.activations} onReset={setResetTarget} />

      <h2>History</h2>
      {events.loading && !events.data && <Loading />}
      {events.error !== null && <ErrorState error={events.error} onRetry={events.reload} />}
      {events.data &&
        (events.data.data.length === 0 ? (
          <EmptyState>No events.</EmptyState>
        ) : (
          <>
            <ul className="timeline">
              {events.data.data.map((e) => (
                <li key={e.id}>
                  <span className="muted small">{fmtDate(e.created_at)}</span> <strong>{e.event_type}</strong> <span className="muted">by {e.actor_email ?? e.actor_type}</span>
                  {Object.keys(e.details).length > 0 && <pre className="details-json">{JSON.stringify(e.details, null, 2)}</pre>}
                </li>
              ))}
            </ul>
            <Pagination meta={events.data.pagination} onPage={setEventsPage} />
          </>
        ))}

      {action && (
        <ConfirmDialog
          title={ACTION_COPY[action].title}
          message={ACTION_COPY[action].message}
          confirmLabel={ACTION_COPY[action].label}
          danger={ACTION_COPY[action].danger}
          onConfirm={async (reason) => {
            await api.licenseAction(l.id, action, reason);
            setNotice(ACTION_COPY[action].done);
            reload();
          }}
          onClose={() => setAction(null)}
        />
      )}
      {dialog === "reissue" && (
        <ConfirmDialog
          title="Reissue the license key?"
          message="A new key is generated and the current key stops working immediately. The customer must enter the new key in every EA."
          confirmLabel="Reissue key"
          danger
          requireReason={false}
          onConfirm={async () => {
            const r = await api.reissueKey(l.id);
            setNewKey(r.license_key);
            reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "renew" && <RenewDialog license={l} onClose={() => setDialog(null)} onDone={() => (setNotice("License renewed."), reload())} />}
      {dialog === "edit" && <EditDialog license={l} onClose={() => setDialog(null)} onDone={() => (setNotice("License updated."), reload())} />}
      {resetTarget && (
        <ConfirmDialog
          title="Reset this activation?"
          message={`The ${resetTarget.activation_type.toUpperCase()} activation "${resetTarget.label ?? shortId(resetTarget.id)}" is deactivated and its slot is freed. That device must activate again to keep working.`}
          confirmLabel="Reset activation"
          danger
          onConfirm={async (reason) => {
            await api.revokeActivation(resetTarget.id, reason);
            setNotice("Activation reset.");
            reload();
          }}
          onClose={() => setResetTarget(null)}
        />
      )}
      {newKey && <KeyReveal licenseKey={newKey} onClose={() => setNewKey(null)} />}
    </section>
  );
}

export function ActivationTable({ activations, onReset }: { activations: Activation[]; onReset: (a: Activation) => void }) {
  if (activations.length === 0) return <EmptyState>No devices or EAs have been activated.</EmptyState>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Label</th>
            <th>Product</th>
            <th>Status</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {activations.map((a) => (
            <tr key={a.id}>
              <td>{a.activation_type.toUpperCase()}</td>
              <td>
                {a.label ?? <span className="muted">{shortId(a.id)}</span>}
                {a.has_account_ref && <span className="muted small"> · account-bound</span>}
              </td>
              <td>{a.product}</td>
              <td>
                <StatusBadge status={a.status} />
              </td>
              <td>{fmtDate(a.first_seen_at)}</td>
              <td>{fmtDate(a.last_seen_at)}</td>
              <td>
                {a.status === "active" && (
                  <button type="button" className="btn btn-small btn-warn" onClick={() => onReset(a)}>
                    Reset
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RenewDialog({ license, onClose, onDone }: { license: LicenseDetail["license"]; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"periods" | "date">("periods");
  const [periods, setPeriods] = useState(1);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = reason.trim().length >= 3 && (mode === "periods" ? periods >= 1 : !!date);
  return (
    <Modal
      title="Renew license"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.renewLicense(license.id, mode === "periods" ? { periods, reason: reason.trim() } : { expires_at: localInputToIso(date), reason: reason.trim() });
                onDone();
                onClose();
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            {busy ? "Renewing…" : "Renew"}
          </button>
        </>
      }
    >
      <p>Current expiry: {fmtDate(license.expires_at)}. Renewal adds time from the later of today and the current expiry.</p>
      <label className="check">
        <input type="radio" checked={mode === "periods"} onChange={() => setMode("periods")} /> Add billing periods
      </label>
      {mode === "periods" && (
        <Field label="Number of periods">
          <input type="number" min={1} max={36} value={periods} onChange={(e) => setPeriods(Number(e.target.value))} />
        </Field>
      )}
      <label className="check">
        <input type="radio" checked={mode === "date"} onChange={() => setMode("date")} /> Set a specific expiry date
      </label>
      {mode === "date" && (
        <Field label="New expiry">
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
      <Field label="Reason (saved in the audit log)">
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error !== null && (
        <p className="error-text" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </Modal>
  );
}

function EditDialog({ license, onClose, onDone }: { license: LicenseDetail["license"]; onClose: () => void; onDone: () => void }) {
  const plans = useAsync(() => api.plans(), []);
  const [planId, setPlanId] = useState(license.plan.id);
  const [startsAt, setStartsAt] = useState(isoToLocalInput(license.starts_at));
  const [expiresAt, setExpiresAt] = useState(isoToLocalInput(license.expires_at));
  const [graceUntil, setGraceUntil] = useState(isoToLocalInput(license.grace_until));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errs = error instanceof ApiError ? fieldErrors(error.details) : {};

  async function save() {
    setBusy(true);
    setError(null);
    // Compare the form strings (minute precision) so untouched fields are never resent.
    const body: Record<string, unknown> = {};
    if (planId !== license.plan.id) body.plan_id = planId;
    if (startsAt && startsAt !== isoToLocalInput(license.starts_at)) body.starts_at = localInputToIso(startsAt);
    if (expiresAt !== isoToLocalInput(license.expires_at)) body.expires_at = expiresAt ? localInputToIso(expiresAt) : null;
    if (graceUntil !== isoToLocalInput(license.grace_until)) body.grace_until = graceUntil ? localInputToIso(graceUntil) : null;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    if (note.trim()) body.note = note.trim();
    try {
      await api.updateLicense(license.id, body);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit license"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      {plans.loading && <Loading />}
      {plans.data && (
        <div className="form-grid">
          <Field label="Plan" hint="Changing the plan changes limits and features immediately." error={errs.plan_id}>
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {plans.data.data.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.is_active && p.id !== license.plan.id}>
                  {p.name} ({p.code}){p.is_active ? "" : " – disabled"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Starts" error={errs.starts_at}>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Expires" hint="Empty = never (lifetime plans only)." error={errs.expires_at}>
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
          <Field label="Grace until" error={errs.grace_until}>
            <input type="datetime-local" value={graceUntil} onChange={(e) => setGraceUntil(e.target.value)} />
          </Field>
          <Field label="Note for the audit log (optional)">
            <textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
      {error !== null && (
        <p className="error-text" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </Modal>
  );
}
