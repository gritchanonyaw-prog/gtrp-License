import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Loading } from "./components/States";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { AdminLayout } from "./layouts/AdminLayout";
import { ActivationsPage } from "./pages/ActivationsPage";
import { AuditPage } from "./pages/AuditPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { CustomersPage } from "./pages/CustomersPage";
import { LicenseDetailPage } from "./pages/LicenseDetailPage";
import { LicensesPage } from "./pages/LicensesPage";
import { LoginPage } from "./pages/LoginPage";
import { MfaSetupPage } from "./pages/MfaSetupPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PaymentsPage } from "./pages/PaymentsPage";
import { PlansPage } from "./pages/PlansPage";
import { I18nProvider, t, useI18n } from "./i18n";

/**
 * Route guard for usability only. Every admin API call is authorized on the
 * server; hiding screens here is not a security control.
 */
export function Guarded() {
  const { user, checking, mfaVerified } = useAuth();
  const [skippedMfa, setSkippedMfa] = useState(false);
  if (checking) return <Loading label={t("Checking session…")} />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <p className="state state-error">{t("This dashboard is for administrators only.")}</p>;
  if ((!user.mfa_enabled || !mfaVerified) && !skippedMfa) return <MfaSetupPage onSkip={() => setSkippedMfa(true)} />;
  return <AdminLayout />;
}

export function AppRoutes() {
  // Subscribing here re-renders the whole tree when the language changes.
  useI18n();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Guarded />}>
        <Route index element={<OverviewPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="licenses" element={<LicensesPage />} />
        <Route path="licenses/:id" element={<LicenseDetailPage />} />
        <Route path="activations" element={<ActivationsPage />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  );
}
