import { NavLink, useLocation } from "react-router-dom";

import { noticeCountLabel, useNotices } from "./Notifications";
import { scrollBehavior } from "./SwipeRow";

/**
 * Barra de pestañas inferior.
 *
 * Es la navegación del móvil entera: por debajo de 860 px la barra lateral hace
 * `display: none` y sin esto cinco de las siete rutas —y «Cerrar sesión»— no se
 * alcanzan de ninguna manera. Por encima de 860 px es la barra la que
 * desaparece y el escritorio se queda exactamente como estaba, con su plegado y
 * su ⌘B.
 *
 * Cuatro destinos y no seis: es lo que cabe con un objetivo táctil honesto. La
 * cola —Dealers, Ajustes, API keys, avisos, sesión— se pliega en «Más», que es
 * lo que hacen Apple Music, Mail y Things con el mismo problema.
 *
 * Los iconos son los mismos glifos geométricos que ya usa `NAV` en la barra
 * lateral, y llevan **siempre** su rótulo debajo: cuatro cuadrados con distinta
 * partición no se distinguen sin la palabra.
 */
const TABS = [
  { to: "/offers", label: "Ofertas", icon: "◱" },
  { to: "/analytics", label: "Analítica", icon: "◫" },
  { to: "/models", label: "Modelos", icon: "◈" },
  { to: "/more", label: "Más", icon: "⋯" },
];

/**
 * Rutas que cuelgan de «Más».
 *
 * La pestaña se queda encendida mientras se está en una de ellas: si no, en
 * Dealers o en Ajustes no habría ninguna pestaña marcada y el «estás aquí» se
 * quedaría en una sola señal, el `<h1>`. El `aria-current="page"` sigue siendo
 * solo de la ruta exacta —marcarlo aquí sería decir que esta es la página, y no
 * lo es—, así que la señal accesible en esas rutas es el encabezado.
 */
const MORE_ROUTES = ["/more", "/dealers", "/settings", "/api-keys"];

export function TabBar() {
  const { pathname } = useLocation();
  const { count } = useNotices();

  /**
   * Tocar la pestaña en la que ya se está sube su lista al principio.
   *
   * Es la convención de iOS, y aquí además cubre lo que se pierde en modo
   * instalado: sin barra de estado del navegador no existe el «toca arriba para
   * volver al principio», y la lista de ofertas hace scroll dentro de su propio
   * carril, así que `window.scrollTo` no la alcanzaría.
   */
  function scrollToTopIfCurrent(to: string) {
    if (pathname !== to) return;
    const scroller = document.querySelector<HTMLElement>(".table-wrap");
    const behavior = scrollBehavior();
    scroller?.scrollTo({ top: 0, behavior });
    window.scrollTo({ top: 0, behavior });
  }

  return (
    <nav className="tabbar" aria-label="Navegación principal">
      {TABS.map((tab) => {
        // El contador entra en el nombre accesible de la pestaña: la insignia es
        // decorativa y un lector de pantalla no la anunciaría de otro modo.
        const badge = tab.to === "/more" && count > 0;
        const inSection = tab.to === "/more" && MORE_ROUTES.includes(pathname);
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `tabbar-item${isActive || inSection ? " active" : ""}`}
            aria-label={badge ? `${tab.label}: ${noticeCountLabel(count)}` : undefined}
            onClick={() => scrollToTopIfCurrent(tab.to)}
          >
            <span className="tabbar-icon" aria-hidden="true">
              {tab.icon}
              {badge ? <span className="tabbar-badge">{count}</span> : null}
            </span>
            <span className="tabbar-label">{tab.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
