import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useAuth } from "../hooks/useAuth";
import { LanguageSwitcher, t } from "../i18n";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/customers", label: "Customers" },
  { to: "/licenses", label: "Licenses" },
  { to: "/activations", label: "Activations" },
  { to: "/plans", label: "Plans" },
  { to: "/payments", label: "Payments" },
  { to: "/audit", label: "Audit log" },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="layout">
      <header className="topbar">
        <button type="button" className="btn menu-toggle" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((o) => !o)}>
          {t("Menu")}
        </button>
        <span className="brand">{t("GTRP License Admin")}</span>
        <span className="topbar-user">
          <LanguageSwitcher />
          <span className="muted">{user?.email}</span>
          <button type="button" className="btn" onClick={() => void logout()}>
            {t("Sign out")}
          </button>
        </span>
      </header>
      <nav id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label={t("Main")}>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}>
            {t(n.label)}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
