import { useEffect, useState, type FormEvent } from "react";
import { Field } from "../components/Field";
import { ErrorState, Loading, errorMessage } from "../components/States";
import { useAuth } from "../hooks/useAuth";
import { api } from "../services/api";
import { t } from "../i18n";

/** Administrators must enroll TOTP MFA. Skipping is offered only on the development environment. */
export function MfaSetupPage({ onSkip }: { onSkip: () => void }) {
  const { user, refresh, logout } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/v1/health")
      .then((r) => r.json() as Promise<{ environment: string }>)
      .then((h) => setEnv(h.environment))
      .catch(() => setEnv(null));
  }, []);

  if (user?.mfa_enabled) {
    return (
      <div className="login-wrap">
        <div className="card login">
          <h1>{t("Sign in again")}</h1>
          <p>{t("This session was not verified with MFA. Sign out and sign in with your authentication code.")}</p>
          <button type="button" className="btn btn-primary" onClick={() => void logout()}>
            {t("Sign out")}
          </button>
        </div>
      </div>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.mfaSetup());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.mfaEnable(code);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>{t("Set up two-factor authentication")}</h1>
        <p>{t("Administrator accounts must use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, etc.).")}</p>
        {!setup && (
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? <Loading label={t("Preparing…")} /> : t("Start setup")}
          </button>
        )}
        {setup && (
          <form onSubmit={enable}>
            <p>{t("Add this key in your authenticator app (choose “enter a setup key”, time-based):")}</p>
            <div className="key-box">
              <code>{setup.secret}</code>
            </div>
            <p className="muted small">{t("Setup link for apps that accept it:")} <code className="wrap">{setup.otpauth_uri}</code></p>
            <Field label={t("6-digit code from the app")}>
              <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
            </Field>
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
              {t("Turn on MFA")}
            </button>
          </form>
        )}
        {error !== null && (setup ? <p className="error-text" role="alert">{errorMessage(error)}</p> : <ErrorState error={error} />)}
        {env === "development" && (
          <button type="button" className="btn-link" onClick={onSkip}>
            {t("Skip for now (development only)")}
          </button>
        )}
      </div>
    </div>
  );
}
