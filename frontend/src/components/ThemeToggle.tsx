import type { Theme } from "../lib/theme";

/* -------------------------------------------------------------------------- *
 * Las piezas del conmutador de tema, compartidas por sus dos superficies: el
 * pie de la barra lateral en escritorio y la fila de «Más» en la mano. El
 * estado lo pone `useTheme()`; aquí solo está lo que se ve.
 * -------------------------------------------------------------------------- */

/**
 * Lo que hace el botón, no lo que hay puesto.
 *
 * Un control que dice «Oscuro» estando en claro es ambiguo —¿es el estado o es
 * el destino?—, y como en la barra plegada este texto es además el único rótulo
 * accesible, la ambigüedad se cobraría en VoiceOver.
 */
export function themeLabel(theme: Theme): string {
  return theme === "dark" ? "Tema claro" : "Tema oscuro";
}

/**
 * Sol o luna, dibujados y no glifos: ☀ y ☾ salen a color desde la fuente de
 * emoji en unos sistemas y como recuadro vacío en otros. Mismo lienzo, mismo
 * grosor y mismo remate que los iconos de `OfferActions`.
 *
 * Enseña **el destino**, igual que el rótulo: en claro se ve la luna.
 */
export function ThemeIcon({ dark }: { dark: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {dark ? (
        <>
          <circle cx="8" cy="8" r="3.1" />
          <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
        </>
      ) : (
        <path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.8 5.8 0 1 0 7 7Z" />
      )}
    </svg>
  );
}
