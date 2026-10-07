import { useSyncExternalStore } from "react";

/* -------------------------------------------------------------------------- *
 * Tema
 *
 * El claro es el que se sirve, siempre —en escritorio y en la mano—, y el
 * oscuro es una elección que se toma y se recuerda. Antes esto lo decidía
 * `prefers-color-scheme` a solas: un iPhone en «automático» abría la app de
 * noche en oscuro sin que nadie lo hubiera pedido y sin forma de volver.
 *
 * El juego de color entero cuelga de `data-theme` en `<html>` (`styles.css`),
 * así que cambiarlo es escribir un atributo: no hay repintado en JS ni una
 * segunda hoja que cargar.
 *
 * La preferencia vive en `localStorage` y la aplica el script en línea de
 * `index.html` **antes** de que pinte nada. Sin él, quien tiene el oscuro
 * elegido vería un destello claro en cada arranque.
 * -------------------------------------------------------------------------- */

export type Theme = "light" | "dark";

/** La misma clave que lee el script en línea de `index.html`. Si cambia aquí,
 *  cambia allí. */
const KEY = "nr.theme";

/** El `--bg` de cada juego: es el color con el que el sistema pinta su barra. */
const BAR: Record<Theme, string> = { light: "#fbfbfb", dark: "#121211" };

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    // Safari en navegación privada tira al tocar `localStorage`. El claro es el
    // suelo y no depende de que se pueda leer nada.
    return "light";
  }
}

let current: Theme = stored();
const listeners = new Set<() => void>();

/**
 * Escribe el tema en el documento: el atributo del que cuelgan los tokens y el
 * color de la barra del sistema, que en una PWA instalada es cromo de la app y
 * no del navegador.
 */
function paint(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
}

/**
 * Deja el documento de acuerdo con lo guardado. Lo normal es que el script en
 * línea ya lo haya hecho; esto cubre el `index.html` rancio que se sirvió antes
 * de que ese script existiera y que el service worker todavía puede tener.
 */
export function initTheme() {
  paint(current);
}

export function setTheme(theme: Theme) {
  if (theme === current) return;
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Sin sitio donde guardarlo el cambio vale para esta sesión, que es mejor
    // que no dejar cambiarlo.
  }
  paint(theme);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * El tema y su conmutador, desde donde haga falta.
 *
 * Sin proveedor a propósito: los dos sitios que lo tocan —el pie de la barra
 * lateral y la fila de «Más»— están en ramas distintas del árbol y no comparten
 * nada más. Un almacén de módulo con `useSyncExternalStore` los mantiene en
 * sincronía sin envolver la app entera en otro contexto.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  return {
    theme,
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}
