/**
 * El icono de la app dibujado en línea: la misma geometría que
 * `public/icons/source/icon.svg`, con su esquina redondeada.
 *
 * Los colores van fijos, no por token: la marca es la versión clara en los dos
 * temas, igual que el icono de la pantalla de inicio y las de arranque.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx="115" fill="#ffffff" />
      <g transform="translate(-13.5 13.5)">
        <path
          d="M371.9 225A120 120 0 1 1 287.1 140.1"
          fill="none"
          stroke="#1b1b18"
          strokeWidth="56"
          strokeLinecap="round"
        />
        <circle cx="397.4" cy="114.6" r="34" fill="#1961ed" />
      </g>
    </svg>
  );
}
