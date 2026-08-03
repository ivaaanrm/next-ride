import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { NoticesProvider, NotificationsNav } from "./Notifications";
import { TabBar } from "./TabBar";

const NAV = [
  { to: "/offers", label: "Ofertas", icon: "◱" },
  { to: "/analytics", label: "Analítica", icon: "◫" },
  { to: "/models", label: "Modelos", icon: "◈" },
  { to: "/dealers", label: "Dealers", icon: "◇" },
];

const SETTINGS_NAV = [
  { to: "/settings", label: "Ajustes", icon: "⚙" },
  { to: "/api-keys", label: "API Keys", icon: "⚿" },
];

const COLLAPSED_KEY = "nr.sidebar_collapsed";

export function Layout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const initials = (user?.full_name || user?.email || "?").slice(0, 2);

  // Se recuerda entre recargas: plegarla es una preferencia, no un estado de paso.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === "1",
  );

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // ⌘/Ctrl+B: el atajo habitual para plegar la navegación.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Plegada, los iconos son lo único visible: el tooltip es la única etiqueta. */
  const tip = (label: string) => (collapsed ? label : undefined);

  return (
    <NoticesProvider>
      <div className="app">
        <nav id="app-sidebar" className={`sidebar${collapsed ? " collapsed" : ""}`}>
          <div className="brand">
            <span className="brand-mark">NR</span>
            <span className="nav-label">next-ride</span>
            <div className="spacer" />
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((value) => !value)}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              aria-label={collapsed ? "Expandir la navegación" : "Plegar la navegación"}
              title={`${collapsed ? "Expandir" : "Plegar"} la navegación (⌘B)`}
            >
              {collapsed ? "»" : "«"}
            </button>
          </div>

          <div className="nav-section">Espacio de trabajo</div>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              aria-label={item.label}
              title={tip(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}

          <div className="nav-section">Sistema</div>
          {/* Antes que Ajustes: el aviso es lo que manda a Ajustes, no al revés. */}
          <NotificationsNav collapsed={collapsed} />
          {SETTINGS_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              aria-label={item.label}
              title={tip(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}

          <div className="sidebar-footer">
            <div className="user-chip" title={tip(user?.email ?? "")}>
              <span className="avatar">{initials}</span>
              <span className="user-email">{user?.email}</span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={logout}
              aria-label="Cerrar sesión"
              title={tip("Cerrar sesión")}
            >
              {collapsed ? <span aria-hidden="true">⏻</span> : "Cerrar sesión"}
            </button>
          </div>
        </nav>

        <div className="main">
          {/* La clave por ruta remonta la vista, y ese remontaje es lo que dispara
              sola la animación de entrada. El envoltorio no pinta caja
              (`display: contents`): la cabecera y el cuerpo siguen siendo hijos
              directos de `.main`, así que ni el `sticky` de `.topbar` ni el
              `flex: 1` de `.content` cambian de sitio. */}
          <div className="view" key={pathname}>
            <Outlet />
          </div>
        </div>

        {/* Fuera de `.main` y fija a la ventana: la barra no entra en el reparto
            de alto de la vista, así que una página con la tabla a pantalla
            completa no tiene que descontarla dos veces. */}
        <TabBar />
      </div>
    </NoticesProvider>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      {meta ? <span className="topbar-meta">{meta}</span> : null}
      {actions ? <div className="topbar-actions">{actions}</div> : null}
    </header>
  );
}
