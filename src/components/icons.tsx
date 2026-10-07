import type { SVGProps } from "react";

/**
 * Iconos de trazo, uno por destino o acción.
 *
 * Sustituyen a los glifos geométricos (◱ ◫ ◈ ⋯) que hacían de iconos: cuatro
 * cuadrados con distinta partición no se distinguían sin el rótulo, cada
 * sistema los dibujaba con su fuente y a 20 px quedaban desalineados con el
 * texto. Estos son SVG en línea, de 24 × 24 con trazo de 1,75 y `currentColor`:
 * siguen al tema, al estado activo y al tamaño de quien los pinta.
 *
 * Son siempre decorativos (`aria-hidden`): el nombre accesible lo pone el
 * control que los lleva, nunca el dibujo.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Ofertas: una lista de fichas. */
export const IconOffers = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4" width="17" height="6" rx="1.5" />
    <rect x="3.5" y="14" width="17" height="6" rx="1.5" />
  </Svg>
);

/** Analítica: barras. */
export const IconAnalytics = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20h16" />
    <path d="M7 16v-5" />
    <path d="M12 16V6" />
    <path d="M17 16v-8" />
  </Svg>
);

/** Modelos: un coche de perfil. */
export const IconModels = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 16H3.5v-3.2a2 2 0 0 1 1.2-1.83L6.5 10l1.8-3.2A2 2 0 0 1 10.04 6h3.92a2 2 0 0 1 1.74 1L17.5 10l1.8.97a2 2 0 0 1 1.2 1.83V16H19" />
    <path d="M9 16h6" />
    <circle cx="7" cy="16" r="2" />
    <circle cx="17" cy="16" r="2" />
  </Svg>
);

export const IconMore = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="5.5" cy="12" r="1.25" fill="currentColor" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.25" fill="currentColor" />
  </Svg>
);

/** Dealers: un escaparate. */
export const IconDealers = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 9.5 5.5 4h13L20 9.5" />
    <path d="M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0" />
    <path d="M5 12v8h14v-8" />
    <path d="M10 20v-4.5h4V20" />
  </Svg>
);

export const IconSettings = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h10" />
    <path d="M18 7h2" />
    <circle cx="16" cy="7" r="2" />
    <path d="M4 17h2" />
    <path d="M10 17h10" />
    <circle cx="8" cy="17" r="2" />
  </Svg>
);

export const IconKey = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.85 12.15 8.65-8.65" />
    <path d="m16 7 2.5 2.5" />
    <path d="m14 9 1.5 1.5" />
  </Svg>
);

export const IconBell = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
    <path d="M10.3 20a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

export const IconRefresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 11a8 8 0 0 0-14.8-3.5" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.8 3.5" />
    <path d="M20 20v-4h-4" />
  </Svg>
);

export const IconPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

/** Captación: el radar que da nombre a la app. */
export const IconRadar = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19.07 4.93A10 10 0 1 0 22 12" />
    <path d="M16.24 7.76A6 6 0 1 0 18 12" />
    <circle cx="12" cy="12" r="1.5" />
    <path d="m13 11 6-6" />
  </Svg>
);

export const IconSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Svg>
);

export const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);

export const IconExternal = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Svg>
);

/** Seguir: un marcador. Relleno cuando se sigue. */
export const IconFollow = ({ filled = false, ...props }: IconProps & { filled?: boolean }) => (
  <Svg {...props}>
    <path
      d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1Z"
      fill={filled ? "currentColor" : "none"}
    />
  </Svg>
);

export const IconSparkle = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5 13.9 9a1.5 1.5 0 0 0 1.1 1.1l5.5 1.9-5.5 1.9a1.5 1.5 0 0 0-1.1 1.1L12 20.5 10.1 15a1.5 1.5 0 0 0-1.1-1.1L3.5 12 9 10.1A1.5 1.5 0 0 0 10.1 9Z" />
  </Svg>
);
