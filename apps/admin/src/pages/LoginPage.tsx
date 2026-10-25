import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { Field } from "../components/Field";
import { errorMessage } from "../components/States";
import { useAuth } from "../hooks/useAuth";
import { ApiError, api } from "../services/api";

export function LoginPage() {
  const { user, refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password, needCode ? code : undefined);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_REQUIRED") {
        setNeedCode(true);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit} noValidate>
        <h1>GTRP License Admin</h1>
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {needCode && (
          <Field label="Authentication code" hint="6-digit code from your authenticator app">
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
          </Field>
        )}
        {error !== null && (
          <p className="error-text" role="alert">
            {errorMessage(error)}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !email || !password || (needCode && code.length !== 6)}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
