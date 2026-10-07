import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import {
  IconAnalytics,
  IconDealers,
  IconKey,
  IconMail,
  IconModels,
  IconOffers,
  IconSettings,
} from "./icons";
import { Logo } from "./Logo";
import { NoticesProvider, NotificationsNav } from "./Notifications";
import { TabBar } from "./TabBar";
import { ThemeIcon, themeLabel } from "./ThemeToggle";

const NAV = [
  { to: "/offers", label: "Ofertas", Icon: IconOffers },
  { to: "/analytics", label: "Analítica", Icon: IconAnalytics },
  { to: "/models", label: "Modelos", Icon: IconModels },
  { to: "/dealers", label: "Dealers", Icon: IconDealers },
];

const SETTINGS_NAV = [
  { to: "/settings", label: "Ajustes", Icon: IconSettings },
  { to: "/api-keys", label: "API Keys", Icon: IconKey },
];

/** Solo la ve un superusuario: a los demás el servidor les diría 403. */
const ADMIN_NAV = [{ to: "/invitations", label: "Invitaciones", Icon: IconMail }];

const COLLAPSED_KEY = "nr.sidebar_collapsed";

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
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
            <Logo size={22} className="brand-mark" />
            <span className="nav-label">cochesradar</span>
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
              <span className="nav-icon">
                <item.Icon size={16} />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}

          <div className="nav-section">Sistema</div>
          {/* Antes que Ajustes: el aviso es lo que manda a Ajustes, no al revés. */}
          <NotificationsNav collapsed={collapsed} />
          {[...SETTINGS_NAV, ...(user?.is_superuser ? ADMIN_NAV : [])].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              aria-label={item.label}
              title={tip(item.label)}
            >
              <span className="nav-icon">
                <item.Icon size={16} />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}

          <div className="sidebar-footer">
            <div className="user-chip" title={tip(user?.email ?? "")}>
              <span className="avatar">{initials}</span>
              <span className="user-email">{user?.email}</span>
            </div>
            {/* El rótulo dice a dónde se va, no dónde se está: es un botón que
                hace una cosa, no un interruptor con dos estados que leer. */}
            <button
              className="btn btn-ghost btn-sm theme-toggle"
              onClick={toggleTheme}
              aria-label={themeLabel(theme)}
              title={tip(themeLabel(theme))}
            >
              <ThemeIcon dark={theme === "dark"} />
              <span className="nav-label">{themeLabel(theme)}</span>
            </button>
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

/**
 * Acción de la barra superior: icono y rótulo en escritorio, solo icono en la
 * mano.
 *
 * En 390 pt los rótulos escritos no cabían junto al titular: Modelos apilaba
 * tres botones a lo ancho en dos líneas y Dealers dos, y la cabecera se comía
 * cien píxeles del pliegue para decir «Actualizar». Con el icono solo la barra
 * vuelve a ser una línea, con el titular a la izquierda y las acciones a la
 * derecha, que es donde iOS las pone. El rótulo sigue siendo el nombre
 * accesible y el `title`, así que nada se pierde para quien no ve el dibujo.
 */
export function HeaderButton({
  icon: Icon,
  label,
  onClick,
  primary = false,
  disabled = false,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-sm header-btn${primary ? " btn-primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon size={16} />
      <span className="header-btn-label">{label}</span>
    </button>
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
