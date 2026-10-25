import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api, setUnauthenticatedHandler } from "../services/api";
import type { PublicUser } from "../types";

interface AuthState {
  user: PublicUser | null;
  mfaVerified: boolean;
  checking: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [mfaVerified, setMfaVerified] = useState(false);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setMfaVerified(me.session.mfa_verified);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 401) setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
    void refresh();
    return () => setUnauthenticatedHandler(null);
  }, [refresh]);

  const value = useMemo(() => ({ user, mfaVerified, checking, refresh, logout }), [user, mfaVerified, checking, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
