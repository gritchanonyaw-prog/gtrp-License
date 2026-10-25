import { useState } from "react";
import { useAsync } from "../hooks/useAsync";
import { ApiError, api } from "../services/api";
import { fmtMoney, localInputToIso } from "../services/format";
import { Field, fieldErrors } from "./Field";
import { Modal } from "./Modal";
import { ErrorState, Loading, errorMessage } from "./States";
import { t } from "../i18n";

export function CreateLicenseDialog({ fixedUserId, onClose, onCreated }: { fixedUserId?: string; onClose: () => void; onCreated: (key: string, licenseId: string) => void }) {
  const plans = useAsync(() => api.plans(), []);
  const [email, setEmail] = useState("");
  const [planId, setPlanId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [expiryMode, setExpiryMode] = useState<"plan" | "custom">("plan");
  const [expiresAt, setExpiresAt] = useState("");
  const [graceDays, setGraceDays] = useState(3);
  const [activate, setActivate] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const activePlans = plans.data?.data.filter((p) => p.is_active) ?? [];
  const errs = error instanceof ApiError ? fieldErrors(error.details) : {};

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { plan_id: planId, grace_days: graceDays, activate };
      if (fixedUserId) body.user_id = fixedUserId;
      else body.email = email.trim();
      if (startsAt) body.starts_at = localInputToIso(startsAt);
      if (expiryMode === "custom" && expiresAt) body.expires_at = localInputToIso(expiresAt);
      if (note.trim()) body.note = note.trim();
      const r = await api.createLicense(body);
      onCreated(r.license_key, r.license.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("Create license")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !planId || (!fixedUserId && !email) || (expiryMode === "custom" && !expiresAt)}>
            {busy ? t("Creating…") : t("Create license")}
          </button>
        </>
      }
    >
      {plans.loading && <Loading label={t("Loading plans…")} />}
      {plans.error !== null && <ErrorState error={plans.error} onRetry={plans.reload} />}
      {plans.data && (
        <div className="form-grid">
          {!fixedUserId && (
            <Field label={t("Customer email")} hint={t("The customer must already have registered an account.")} error={errs.email ?? errs.user_id}>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
          )}
          <Field label={t("Plan")} error={errs.plan_id}>
            <select value={planId} onChange={(e) => setPlanId(e.target.value)} required>
              <option value="">{t("Choose a plan…")}</option>
              {activePlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code}) · {fmtMoney(p.price_minor, p.currency)} / {t(p.billing_period)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Start date")} hint={t("Leave empty to start now.")} error={errs.starts_at}>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <fieldset className="field">
            <legend>{t("Expiration")}</legend>
            <label className="check">
              <input type="radio" name="exp" checked={expiryMode === "plan"} onChange={() => setExpiryMode("plan")} /> {t("One billing period from the start (lifetime plans never expire)")}
            </label>
            <label className="check">
              <input type="radio" name="exp" checked={expiryMode === "custom"} onChange={() => setExpiryMode("custom")} /> {t("Custom date")}
            </label>
            {expiryMode === "custom" && <input type="datetime-local" aria-label={t("Expiration date")} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
            {errs.expires_at && <small className="error-text">{errs.expires_at}</small>}
          </fieldset>
          <Field label={t("Grace period (days)")} hint={t("Access continues this many days after expiry.")} error={errs.grace_days}>
            <input type="number" min={0} max={60} value={graceDays} onChange={(e) => setGraceDays(Number(e.target.value))} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> {t("Active immediately (untick to create it as “created”, e.g. awaiting payment)")}
          </label>
          <Field label={t("Internal note (optional)")} error={errs.note}>
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
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
