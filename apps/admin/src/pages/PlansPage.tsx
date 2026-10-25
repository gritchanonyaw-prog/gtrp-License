import { KNOWN_FEATURES } from "@gtrp/shared";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field, fieldErrors } from "../components/Field";
import { Modal } from "../components/Modal";
import { Alert, EmptyState, ErrorState, Loading, errorMessage } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useAsync } from "../hooks/useAsync";
import { ApiError, api } from "../services/api";
import { fmtMoney } from "../services/format";
import type { Plan } from "../types";
import { t } from "../i18n";

export function PlansPage() {
  const { data, error, loading, reload } = useAsync(() => api.plans(), []);
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [toggling, setToggling] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <section>
      <div className="page-head">
        <h1>{t("Plans")}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          {t("New plan")}
        </button>
      </div>
      <p className="muted">Changes to a plan apply to every license on it from the next request. Lowering a limit does not remove existing activations; it blocks new ones until usage drops.</p>
      {notice && (
        <Alert kind="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {loading && !data && <Loading />}
      {error !== null && <ErrorState error={error} onRetry={reload} />}
      {data &&
        (data.data.length === 0 ? (
          <EmptyState>{t("No plans yet. Create the first plan to start issuing licenses.")}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("Plan")}</th>
                  <th>{t("Price")}</th>
                  <th>{t("Web devices")}</th>
                  <th>{t("EA activations")}</th>
                  <th>{t("Trading accounts")}</th>
                  <th>{t("Features")}</th>
                  <th>{t("Status")}</th>
                  <th>
                    <span className="sr-only">{t("Actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <br />
                      <code className="small">{p.code}</code>
                    </td>
                    <td>
                      {fmtMoney(p.price_minor, p.currency)} / {t(p.billing_period)}
                    </td>
                    <td>{p.entitlements.web_access ? p.max_web_devices : "—"}</td>
                    <td>
                      {p.max_ea_activations} {p.entitlements.ea_platforms.length > 0 && <span className="muted small">({p.entitlements.ea_platforms.join(", ")})</span>}
                    </td>
                    <td>
                      {p.max_trading_accounts}
                      {p.entitlements.require_account_binding ? "" : <span className="muted small"> {t("(not enforced)")}</span>}
                    </td>
                    <td className="small">{p.entitlements.features.join(", ") || "—"}</td>
                    <td>
                      <StatusBadge status={p.is_active ? "active" : "suspended"} label={p.is_active ? t("enabled") : t("disabled")} />
                    </td>
                    <td className="nowrap">
                      <button type="button" className="btn btn-small" onClick={() => setEditing(p)}>
                        {t("Edit")}
                      </button>{" "}
                      <button type="button" className={`btn btn-small ${p.is_active ? "btn-warn" : ""}`} onClick={() => setToggling(p)}>
                        {p.is_active ? t("Disable") : t("Enable")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {editing && (
        <PlanForm
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            reload();
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={toggling.is_active ? t("Disable {name}?", { name: toggling.name }) : t("Enable {name}?", { name: toggling.name })}
          message={
            toggling.is_active
              ? t("The plan is hidden from the public plan list and cannot be used for new licenses or purchases. Existing licenses on this plan keep working.")
              : t("The plan becomes available for new licenses and purchases.")
          }
          confirmLabel={toggling.is_active ? t("Disable plan") : t("Enable plan")}
          danger={toggling.is_active}
          requireReason={false}
          onConfirm={async () => {
            await api.updatePlan(toggling.id, { is_active: !toggling.is_active });
            setNotice(toggling.is_active ? t("Plan disabled.") : t("Plan enabled."));
            reload();
          }}
          onClose={() => setToggling(null)}
        />
      )}
    </section>
  );
}

function splitList(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function PlanForm({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: (message: string) => void }) {
  const e0 = plan?.entitlements;
  const [code, setCode] = useState(plan?.code ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [price, setPrice] = useState(plan ? (plan.price_minor / 100).toFixed(2) : "0.00");
  const [currency, setCurrency] = useState(plan?.currency ?? "THB");
  const [billing, setBilling] = useState(plan?.billing_period ?? "monthly");
  const [maxWeb, setMaxWeb] = useState(plan?.max_web_devices ?? 1);
  const [maxEa, setMaxEa] = useState(plan?.max_ea_activations ?? 0);
  const [maxAcc, setMaxAcc] = useState(plan?.max_trading_accounts ?? 0);
  const [webAccess, setWebAccess] = useState(e0?.web_access ?? true);
  const [features, setFeatures] = useState<string[]>(e0?.features ?? []);
  const [extraFeatures, setExtraFeatures] = useState((e0?.features ?? []).filter((f) => !(KNOWN_FEATURES as readonly string[]).includes(f)).join(", "));
  const [eaProducts, setEaProducts] = useState((e0?.ea_products ?? []).join(", "));
  const [platforms, setPlatforms] = useState<string[]>(e0?.ea_platforms ?? []);
  const [binding, setBinding] = useState(e0?.require_account_binding ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errs = error instanceof ApiError ? fieldErrors(error.details) : {};

  function toggle(list: string[], v: string, set: (l: string[]) => void) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const priceMinor = Math.round(Number(price) * 100);
    const allFeatures = [...features.filter((f) => (KNOWN_FEATURES as readonly string[]).includes(f)), ...splitList(extraFeatures)];
    const body: Record<string, unknown> = {
      name: name.trim(),
      price_minor: Number.isFinite(priceMinor) ? priceMinor : -1,
      currency: currency.trim().toUpperCase(),
      billing_period: billing,
      max_web_devices: maxWeb,
      max_ea_activations: maxEa,
      max_trading_accounts: maxAcc,
      entitlements: { web_access: webAccess, features: allFeatures, ea_products: splitList(eaProducts), ea_platforms: platforms, require_account_binding: binding },
    };
    try {
      if (plan) {
        if (body.billing_period === plan.billing_period) delete body.billing_period;
        await api.updatePlan(plan.id, body);
        onSaved(t("Plan saved."));
      } else {
        await api.createPlan({ ...body, code: code.trim().toUpperCase(), is_active: true });
        onSaved(t("Plan created."));
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={plan ? t("Edit {name}", { name: plan.name }) : t("New plan")}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !name || (!plan && !code)}>
            {busy ? t("Saving…") : t("Save plan")}
          </button>
        </>
      }
    >
      <div className="form-grid two">
        <Field label={t("Code")} hint={t("UPPER_SNAKE_CASE, cannot be changed later")} error={errs.code}>
          <input value={code} onChange={(e) => setCode(e.target.value)} disabled={!!plan} placeholder="QUANT_PRO" />
        </Field>
        <Field label={t("Display name")} error={errs.name}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("Price")} error={errs.price_minor}>
          <input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label={t("Currency")} error={errs.currency}>
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </Field>
        <Field label={t("Billing period")} hint={plan ? t("Switching to or from lifetime is not allowed") : undefined} error={errs.billing_period}>
          <select value={billing} onChange={(e) => setBilling(e.target.value as typeof billing)}>
            <option value="monthly">{t("Monthly")}</option>
            <option value="yearly">{t("Yearly")}</option>
            <option value="lifetime">{t("Lifetime")}</option>
          </select>
        </Field>
        <Field label={t("Max Web App devices")} error={errs.max_web_devices}>
          <input type="number" min={0} max={1000} value={maxWeb} onChange={(e) => setMaxWeb(Number(e.target.value))} />
        </Field>
        <Field label={t("Max EA activations (MT4 + MT5)")} error={errs.max_ea_activations}>
          <input type="number" min={0} max={1000} value={maxEa} onChange={(e) => setMaxEa(Number(e.target.value))} />
        </Field>
        <Field label={t("Max trading accounts")} hint={t("Enforced only when account binding is on")} error={errs.max_trading_accounts}>
          <input type="number" min={0} max={1000} value={maxAcc} onChange={(e) => setMaxAcc(Number(e.target.value))} />
        </Field>
      </div>
      <fieldset className="field">
        <legend>{t("Web App")}</legend>
        <label className="check">
          <input type="checkbox" checked={webAccess} onChange={(e) => setWebAccess(e.target.checked)} /> {t("Web App access")}
        </label>
        {KNOWN_FEATURES.map((f) => (
          <label className="check" key={f}>
            <input type="checkbox" checked={features.includes(f)} onChange={() => toggle(features, f, setFeatures)} disabled={!webAccess} /> {f}
          </label>
        ))}
        <Field label={t("Other feature keys (comma separated)")} error={errs.entitlements}>
          <input value={extraFeatures} onChange={(e) => setExtraFeatures(e.target.value)} disabled={!webAccess} />
        </Field>
      </fieldset>
      <fieldset className="field">
        <legend>{t("Expert Advisors")}</legend>
        <Field label={t("EA product IDs (comma separated)")} hint={t("e.g. gtrp_ea")}>
          <input value={eaProducts} onChange={(e) => setEaProducts(e.target.value)} />
        </Field>
        {(["mt4", "mt5"] as const).map((p) => (
          <label className="check" key={p}>
            <input type="checkbox" checked={platforms.includes(p)} onChange={() => toggle(platforms, p, setPlatforms)} /> {p.toUpperCase()}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={binding} onChange={(e) => setBinding(e.target.checked)} /> {t("Bind each EA to a trading account (required to enforce the trading-account limit)")}
        </label>
      </fieldset>
      {error !== null && (
        <p className="error-text" role="alert">
          {errorMessage(error)}
        </p>
      )}
    </Modal>
  );
}
