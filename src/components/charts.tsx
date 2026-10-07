/**
 * Piezas de gráfico compartidas entre páginas.
 *
 * Aquí solo vive lo que se pinta en más de un sitio. Cada página sigue armando
 * sus ejes —los rótulos y los formatos son suyos—; lo común es cómo se dibuja el
 * radar y cómo se lee, que es justo lo que no puede divergir entre la Analítica
 * y el panel de una oferta.
 *
 * **Este fichero no importa recharts, y eso es una condición, no una casualidad.**
 * El radar se dibuja con SVG a mano: son ~120 líneas de trigonometría contra los
 * 33 KB en crudo que costaba el juego polar de recharts (`RadarChart`, `Radar`,
 * `PolarGrid`, `PolarAngleAxis`, `PolarRadiusAxis`, `Sector`) dentro del chunk
 * diferido de Analítica. Y mientras la pantalla de ofertas siga importando de
 * aquí, cualquier import de recharts en este fichero vuelve a arrastrar la
 * librería entera al chunk de entrada, que es exactamente lo que el presupuesto
 * de arranque prohíbe.
 */

import { useLayoutEffect, useRef, useState } from "react";

import { extremeAxis, RADAR_MID, type RadarRow } from "../lib/radar";

/* -------------------------------------------------------------------------- *
 * Medida del contenedor
 * -------------------------------------------------------------------------- */

export interface Box {
  width: number;
  height: number;
}

/**
 * El tamaño real de un contenedor, para que los ejes se dimensionen contra él y
 * no contra un número pensado para una tarjeta de 900 px.
 *
 * `ResizeObserver` y no un listener de `resize`: el ancho útil depende también
 * de si la barra lateral está plegada, y eso no cambia el tamaño del viewport.
 * La primera medida se toma en `useLayoutEffect` para que el primer fotograma ya
 * se pinte con el tamaño bueno y no haya un salto de escritorio a móvil.
 */
export function useMeasuredBox<T extends HTMLElement>(): [React.RefObject<T>, Box] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const apply = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setBox((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    const rect = node.getBoundingClientRect();
    apply(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      apply(rect.width, rect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, box];
}

/* -------------------------------------------------------------------------- *
 * Medida de texto
 * -------------------------------------------------------------------------- */

let measureCtx: CanvasRenderingContext2D | null | undefined;
let bodyFont: string | null = null;

/**
 * Cuánto mide un rótulo, de verdad.
 *
 * Los rótulos de eje se recortan contra el ancho que les queda, y ese recorte
 * decide si dos etiquetas contiguas se pisan. Estimar por número de caracteres
 * falla justo en los nombres que importan («OcasionPlus Madrid - Alcalá de
 * Henares» mide 56 caracteres y ninguno es una eme). Un canvas fuera de pantalla
 * lo mide con la misma tipografía que el documento y no toca el layout.
 */
export function measureText(text: string, fontSize: number): number {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * fontSize * 0.55;
  if (bodyFont === null) {
    bodyFont =
      typeof getComputedStyle === "function"
        ? getComputedStyle(document.body).fontFamily || "sans-serif"
        : "sans-serif";
  }
  measureCtx.font = `${fontSize}px ${bodyFont}`;
  return measureCtx.measureText(text).width;
}

/**
 * El rótulo recortado a lo que cabe, con puntos suspensivos.
 *
 * El nombre entero nunca se pierde: vive en la tabla de «Ver los datos» de la
 * tarjeta, que es el equivalente en texto del dibujo. Recortar aquí es lo que
 * evita que un eje de nombres de dealer se coma dos tercios de la tarjeta.
 */
export function fitLabel(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0 || measureText(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  const room = maxWidth - measureText(ellipsis, fontSize);
  if (room <= 0) return ellipsis;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureText(text.slice(0, mid), fontSize) <= room) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trimEnd()}${ellipsis}`;
}

/* -------------------------------------------------------------------------- *
 * Tooltip
 * -------------------------------------------------------------------------- */

/** Una línea de tooltip: rótulo a la izquierda, cifra a la derecha. */
export function TipRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={`chart-tip-row${strong ? " strong" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export interface RadarSeries {
  key: string;
  label: string;
  color: string;
}

/* -------------------------------------------------------------------------- *
 * Radar
 * -------------------------------------------------------------------------- */

/** Los anillos de rejilla, en la misma escala 0-100 que los radios. */
const GRID_RINGS = [20, 40, 60, 80, 100];
const LABEL_SIZE = 11;
/** Alto de una línea de rótulo: lo que hay que reservar arriba y abajo. */
const LABEL_LINE = 13;

/** Arriba y en el sentido de las agujas, que es como lo dibujaba recharts. */
function axisAngle(index: number, count: number): number {
  return -Math.PI / 2 + (index * 2 * Math.PI) / count;
}

interface Geometry {
  cx: number;
  cy: number;
  radius: number;
  axes: { angle: number; cos: number; sin: number; label: string; width: number }[];
}

/**
 * Dónde cabe el polígono una vez colocados los rótulos.
 *
 * El radio no sale de un porcentaje fijo: sale de la restricción que primero se
 * cumple. Cada eje empuja hacia fuera su vértice **más** el ancho de su rótulo,
 * así que el eje que manda es el del nombre más largo en la dirección más
 * horizontal. Con un porcentaje fijo, en 326 px los rótulos laterales salían de
 * la caja; con esto, el polígono se encoge lo justo y nunca se recorta un nombre
 * que cabía.
 */
function geometryFor(box: Box, labels: string[]): Geometry {
  const count = labels.length;
  const cx = box.width / 2;
  const cy = box.height / 2;

  const axes = labels.map((label, index) => {
    const angle = axisAngle(index, count);
    return {
      angle,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      label,
      width: measureText(label, LABEL_SIZE),
    };
  });

  let radius = Math.min(cx, cy);
  for (const axis of axes) {
    const horizontal = Math.abs(axis.cos);
    const vertical = Math.abs(axis.sin);
    // Un rótulo centrado sobresale la mitad a cada lado; uno anclado al vértice,
    // entero hacia fuera. El umbral de 0,2 es el mismo con el que se elige el
    // `text-anchor` unas líneas más abajo: las dos decisiones son la misma.
    const reach = horizontal > 0.2 ? axis.width + 4 : axis.width / 2 + 2;
    if (horizontal > 0.01) radius = Math.min(radius, (cx - reach) / horizontal);
    if (vertical > 0.01) radius = Math.min(radius, (cy - LABEL_LINE - 4) / vertical);
  }

  return { cx, cy, radius: Math.max(radius, 24), axes };
}

/** Un punto del polígono: radio 0-100 sobre la geometría ya resuelta. */
function pointAt(geo: Geometry, index: number, value: number): [number, number] {
  const axis = geo.axes[index];
  const r = (Math.max(0, Math.min(100, value)) / 100) * geo.radius;
  return [geo.cx + axis.cos * r, geo.cy + axis.sin * r];
}

const polygon = (points: [number, number][]): string =>
  points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/**
 * Perfil radial de una o varias entidades sobre los mismos ejes.
 *
 * El anillo discontinuo del centro es la mediana del conjunto de referencia, y
 * es lo que convierte el polígono en una lectura: por fuera está lo que es mejor
 * que lo típico, por dentro lo que es peor. Sin él, un radar solo enseña que
 * unas cosas son distintas de otras.
 *
 * El eje radial no lleva números a propósito. Serían un 0-100 que se lee como
 * nota y no lo es —un 100 en «Precio» dice «el más barato de este conjunto», no
 * «barato»—, así que la cifra que se enseña es siempre la cruda: en el tooltip
 * con un puntero, y en la tabla de «Ver los datos» de la tarjeta, que es la que
 * queda cuando lo que hay es un dedo.
 */
export function RadarProfile({
  rows,
  series,
  referenceLabel,
  className = "chart-radar",
}: {
  rows: RadarRow[];
  series: RadarSeries[];
  /** Cómo se llama el anillo del centro. Es lo que da sentido al «fuera es mejor». */
  referenceLabel: string;
  className?: string;
}) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

  const ready = box.width > 0 && box.height > 0 && rows.length >= 3;
  const geo = ready ? geometryFor(box, rows.map((row) => row.axis)) : null;

  // Con una sola serie el relleno ayuda a leer la silueta; con tres se pisan y
  // lo que queda es un gris del que no sale ninguna de las tres.
  const fillOpacity = series.length > 1 ? 0.08 : 0.16;

  const active = hovered !== null && rows[hovered] ? rows[hovered] : null;
  const activePoint = geo && hovered !== null ? pointAt(geo, hovered, 100) : null;

  return (
    <div className={`${className} chart-radar-frame`} ref={ref}>
      {geo ? (
        <svg
          width={box.width}
          height={box.height}
          role="img"
          aria-label={`Perfil comparado sobre ${rows.length} ejes: ${rows
            .map((row) => row.axis.toLowerCase())
            .join(", ")}. Los valores están en «Ver los datos».`}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Rejilla: los anillos y los radios, del mismo filete que separa
              bloques en el resto de la app. */}
          {GRID_RINGS.map((ring) => (
            <polygon
              key={ring}
              points={polygon(rows.map((_, index) => pointAt(geo, index, ring)))}
              fill="none"
              stroke="var(--border)"
            />
          ))}
          {rows.map((row, index) => {
            const [x, y] = pointAt(geo, index, 100);
            return (
              <line
                key={row.axis}
                x1={geo.cx}
                y1={geo.cy}
                x2={x}
                y2={y}
                stroke="var(--border)"
              />
            );
          })}

          {/* El anillo de referencia va antes que las series: es el fondo contra
              el que se leen, no una serie más. */}
          <polygon
            points={polygon(rows.map((_, index) => pointAt(geo, index, RADAR_MID)))}
            fill="none"
            stroke="var(--text-tertiary)"
            strokeDasharray="4 4"
          />

          {series.map((item) => {
            const points = rows.map((row, index) =>
              pointAt(geo, index, Number(row[item.key] ?? RADAR_MID)),
            );
            return (
              <g key={item.key}>
                <polygon
                  points={polygon(points)}
                  fill={item.color}
                  fillOpacity={fillOpacity}
                  stroke={item.color}
                  strokeWidth={2}
                />
                {points.map(([x, y], index) => (
                  <circle key={index} cx={x} cy={y} r={2.5} fill={item.color} />
                ))}
              </g>
            );
          })}

          {/* Rótulos. El ancla sigue al coseno: a la derecha del dibujo el texto
              arranca en el vértice, a la izquierda termina en él. */}
          {geo.axes.map((axis, index) => {
            const [x, y] = pointAt(geo, index, 100);
            const anchor = axis.cos > 0.2 ? "start" : axis.cos < -0.2 ? "end" : "middle";
            const dx = axis.cos > 0.2 ? 4 : axis.cos < -0.2 ? -4 : 0;
            const dy = axis.sin < -0.5 ? -5 : axis.sin > 0.5 ? 11 : 4;
            return (
              <text
                key={axis.label}
                x={x + dx}
                y={y + dy}
                textAnchor={anchor}
                fontSize={LABEL_SIZE}
                fill="var(--text-secondary)"
              >
                {axis.label}
              </text>
            );
          })}

          {/* Zonas de escucha del puntero: un sector por eje, transparente, para
              que el tooltip de escritorio siga saliendo donde salía. Con un dedo
              no hacen nada, y por eso los valores están además en la tabla. */}
          {rows.map((row, index) => {
            const half = Math.PI / rows.length;
            const from = geo.axes[index].angle - half;
            const to = geo.axes[index].angle + half;
            const r = geo.radius;
            const x1 = geo.cx + Math.cos(from) * r;
            const y1 = geo.cy + Math.sin(from) * r;
            const x2 = geo.cx + Math.cos(to) * r;
            const y2 = geo.cy + Math.sin(to) * r;
            return (
              <path
                key={`hit-${row.axis}`}
                d={`M${geo.cx},${geo.cy} L${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} Z`}
                fill="transparent"
                onMouseEnter={() => setHovered(index)}
              />
            );
          })}
        </svg>
      ) : null}

      {active && activePoint ? (
        <div
          className="chart-radar-tip"
          style={{
            left: Math.max(0, Math.min(activePoint[0], box.width - 172)),
            top: Math.max(0, Math.min(activePoint[1], box.height - 96)),
          }}
        >
          <RadarTip row={active} series={series} referenceLabel={referenceLabel} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * La marca de color de una serie del radar, para la lista que hace de leyenda.
 * `dashed` es la del anillo de referencia, que en el gráfico no es un relleno
 * sino un trazo discontinuo.
 */
export function RadarMark({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <span
      className={`chart-note-dot${dashed ? " dashed" : ""}`}
      style={dashed ? { borderColor: color } : { background: color }}
      aria-hidden="true"
    />
  );
}

/**
 * El polígono leído en una línea, que es además su equivalente accesible: lo que
 * el radar codifica en posición, aquí es texto.
 *
 * Los umbrales no son decorativos. A menos de cinco puntos del centro la
 * diferencia cabe dentro del recorrido mínimo del eje, y llamar «destaca» a eso
 * sería inventarse una ventaja que los datos no sostienen.
 */
export function RadarReading({ rows, seriesKey }: { rows: RadarRow[]; seriesKey: string }) {
  const best = extremeAxis(rows, seriesKey, "best");
  const worst = extremeAxis(rows, seriesKey, "worst");

  // Polígono regular: no hay un eje que señalar, pero sí hay algo que decir, y no
  // es lo mismo estar empatado por arriba que por abajo.
  if (best && worst && best.radius === worst.radius) {
    return (
      <span className="muted">
        {best.radius > 55
          ? "por encima de la mediana en todos los ejes"
          : best.radius < 45
            ? "por debajo de la mediana en todos los ejes"
            : "cerca de la mediana en todos los ejes"}
      </span>
    );
  }

  const strong = best && best.radius > 55 ? best.axis : null;
  const weak = worst && worst.radius < 45 ? worst.axis : null;

  if (!strong && !weak) {
    return <span className="muted">cerca de la mediana en todos los ejes</span>;
  }

  return (
    <>
      {strong ? (
        <>
          destaca en <strong>{strong.toLowerCase()}</strong>
        </>
      ) : null}
      {strong && weak ? " · " : null}
      {weak ? (
        <>
          flojea en <strong>{weak.toLowerCase()}</strong>
        </>
      ) : null}
    </>
  );
}

/**
 * El tooltip del radar enseña el valor **crudo** de cada serie y el de la
 * mediana, no el radio: la posición ya está en el dibujo y lo que falta para
 * decidir es la cifra.
 */
function RadarTip({
  row,
  series,
  referenceLabel,
}: {
  row: RadarRow;
  series: RadarSeries[];
  referenceLabel: string;
}) {
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">
        {row.axis}
        {row.hint ? <span className="muted"> · {row.hint}</span> : null}
      </div>
      <dl className="chart-tip-rows">
        {row.cells.map((cell) => (
          <TipRow
            key={cell.key}
            label={series.find((item) => item.key === cell.key)?.label ?? cell.key}
            value={cell.raw}
            strong
          />
        ))}
        <TipRow label={referenceLabel} value={row.refRaw} />
      </dl>
    </div>
  );
}
