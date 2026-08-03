/**
 * Analítica — comparar binomios marca-modelo.
 *
 * La unidad es el **binomio marca-modelo**, no la fila de `car_models`. El
 * catálogo se fragmenta por acabado (un «Audi A4 Allroad Quattro» son once
 * filas, una por versión) y comparar a ese nivel no responde ninguna pregunta:
 * las medianas salen de dos ofertas y el ruido tapa la señal.
 *
 * Se comparan hasta tres. No es una cifra redonda: son las ranuras de color que
 * la paleta puede separar bajo daltonismo con todos los pares en juego, que es
 * lo que exige la nube de puntos. El cuarto color no pasa el umbral, así que el
 * selector corta ahí en vez de pintar algo que no se puede leer.
 *
 * El color sigue al binomio, no a su posición en la lista: cada uno se queda con
 * su ranura hasta que se le quita, de modo que deseleccionar otro no repinta los
 * que quedan. Quien aprendió que el Audi es azul lo sigue viendo azul.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import {
  fitLabel,
  measureText,
  RadarMark,
  RadarProfile,
  RadarReading,
  TipRow,
  useMeasuredBox,
  type RadarSeries,
} from "../components/charts";
import { PageHeader } from "../components/Layout";
import { useTouchLayout } from "../components/SwipeRow";
import { Banner, Empty, Loading } from "../components/ui";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  FUEL_LABELS,
  TRANSMISSION_LABELS,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
} from "../lib/format";
import { useAsync } from "../lib/hooks";
import { buildRadar, RADAR_MIN_AXES, type RadarAxis } from "../lib/radar";
import type {
  AnalyticsSegments,
  FuelType,
  Segment,
  SegmentPoint,
  VehicleCondition,
} from "../types";

/** Tres ranuras fijas. Ver la cabecera del fichero: el tope es de la paleta. */
const SLOTS = 3;
const SERIES = ["s0", "s1", "s2"] as const;
const SERIES_COLOR = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
];

/** Por debajo de esto la recta ajusta tan mal que dibujarla sería afirmar de más. */
const MIN_R2 = 0.15;

// Rejilla y ejes discretos, pero las etiquetas del eje se leen: son dato, no
// adorno, y a 11 px el gris más claro se queda por debajo del contraste AA.
const AXIS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: "var(--text-secondary)" },
} as const;

/** Hueco de 2 px del color del fondo entre rellenos contiguos. */
const GAP = { stroke: "var(--surface)", strokeWidth: 2 } as const;

const kEur = (value: number): string =>
  `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(value / 1000)} k€`;

const kKm = (value: number): string =>
  `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(value / 1000)} mil`;

/** Un decimal, con la coma española: «2019,5», no «2019.5». */
const decimal = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const ratio = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Dominio con aire a los lados: pegar un punto al eje lo hace ilegible. */
function paddedDomain(values: number[], pad = 0.06): [number, number] {
  if (!values.length) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const margin = (hi - lo || Math.abs(hi) || 1) * pad;
  return [lo - margin, hi + margin];
}

/** Paso «redondo» más cercano: los tramos de 1.873 € no los lee nadie. */
function niceStep(raw: number): number {
  const steps = [250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
  return steps.find((step) => step >= raw) ?? steps[steps.length - 1];
}

/* -------------------------------------------------------------------------- *
 * La capa táctil
 *
 * El corte se decide por el **ancho medido de la tarjeta**, no por el del
 * viewport, y es deliberado: la rejilla de gráficos ya cambia de dos columnas a
 * una con una consulta de contenedor, y el ancho útil depende además de si la
 * barra lateral está plegada. Con 480 px, un iPhone de 390 (tarjeta de 326)
 * entra en la variante de la mano y la media tarjeta de un portátil de 1.440
 * (566 px) se queda exactamente como está hoy.
 * -------------------------------------------------------------------------- */

const NARROW_CARD = 480;

const isNarrow = (width: number): boolean => width > 0 && width < NARROW_CARD;

/**
 * El ancho del eje de categorías, en proporción a su contenedor.
 *
 * Los 208 px fijos del eje de dealers se comían el 66 % de una tarjeta de 316:
 * quedaban 108 px de barra para ocho dealers. Con una fracción, el eje ocupa lo
 * mismo en cualquier ancho y el dibujo se queda con el resto. El tope de arriba
 * es el valor de escritorio de hoy, así que por encima del corte nada se mueve;
 * el de abajo evita que en una tarjeta muy estrecha el eje sea un guion.
 */
function categoryAxisWidth(container: number, max: number, share = 0.32, min = 56): number {
  if (!container) return max;
  return Math.round(Math.max(min, Math.min(max, container * share)));
}

/**
 * Cada cuántas etiquetas se dibuja una, para que dos contiguas no se toquen.
 *
 * Se calcula midiendo los rótulos de verdad en vez de fiarlo al reparto por
 * defecto de Recharts: es la diferencia entre «suele caber» y «no se solapa».
 * Devuelve el `interval` de Recharts, que cuenta las etiquetas que se **saltan**
 * entre dos dibujadas, así que 0 significa dibujarlas todas.
 */
function tickInterval(labels: string[], available: number, fontSize = 11, gap = 8): number {
  if (!labels.length || available <= 0) return 0;
  const widest = Math.max(...labels.map((label) => measureText(label, fontSize)));
  const fits = Math.max(1, Math.floor(available / (widest + gap)));
  return Math.max(0, Math.ceil(labels.length / fits) - 1);
}

/**
 * El rótulo de una categoría en el eje Y, en **una** línea.
 *
 * El `Text` de Recharts parte el rótulo en varias líneas cuando no le cabe, y
 * mide para decidirlo con el tamaño heredado del documento, no con el `fontSize`
 * del propio tick: en móvil el cuerpo es de 15 px, así que creía que «OcasionPlus
 * Ma…» medía 131 px y lo rompía en dos renglones —«OcasionPlus» / «Ma…»— dentro
 * de una fila de 26 px. Un `<text>` liso no envuelve nunca, y el recorte lo hace
 * `fitLabel` contra el ancho real del eje.
 */
function CategoryTick(props: {
  x?: number;
  y?: number;
  width?: number;
  payload?: { value?: string | number };
}) {
  const { x = 0, y = 0, width = 0, payload } = props;
  return (
    <text
      x={x}
      y={y}
      dy="0.32em"
      textAnchor="end"
      fontSize={11}
      fill="var(--text-secondary)"
    >
      {fitLabel(String(payload?.value ?? ""), width - 10, 11)}
    </text>
  );
}

/* -------------------------------------------------------------------------- *
 * «Ver los datos»
 * -------------------------------------------------------------------------- */

interface DataColumn {
  key: string;
  label: string;
  /** Alineado a la derecha y con cifras de ancho fijo. */
  numeric?: boolean;
  /** La marca de color de la serie, la misma que en el dibujo. */
  color?: string;
}

interface DataTable {
  caption: string;
  columns: DataColumn[];
  rows: { key: string; cells: string[] }[];
  /** Filas por tramo cuando la tabla es larga. Sin él se dibuja entera. */
  chunk?: number;
}

/**
 * El desplegable con la lectura exacta de una tarjeta.
 *
 * Existe porque en un móvil **no hay `:hover`**: todo lo que hoy solo vive en un
 * tooltip —las cinco cifras de una caja, el precio de un punto de la nube, el
 * valor crudo de un eje del radar— es información que un dedo no puede invocar.
 * La tabla es la misma serie con los mismos valores, y de paso es el equivalente
 * accesible del dibujo para quien navega con VoiceOver.
 *
 * Se dibuja siempre, no al abrir: una tabla que solo existe cuando el
 * `<details>` está abierto no es un equivalente, es otro gesto escondido. Las
 * que pueden ser largas —la nube de puntos son una fila por oferta— salen por
 * tramos, con lo que ninguna tarjeta monta mil filas de golpe.
 */
function ChartData({ title, table }: { title: string; table: DataTable }) {
  const chunk = table.chunk ?? table.rows.length;
  const [shown, setShown] = useState(chunk);
  const rows = table.rows.slice(0, shown);
  const rest = table.rows.length - rows.length;

  return (
    <details className="chart-data">
      <summary>
        Ver los datos
        <span className="sr-only"> de «{title}»</span>
        <span className="chart-data-count">{formatNumber(table.rows.length)}</span>
      </summary>
      <div className="chart-data-wrap">
        <table className="chart-data-table">
          <caption className="sr-only">{table.caption}</caption>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? "num" : undefined}
                >
                  {column.color ? (
                    <span
                      className="chart-note-dot"
                      style={{ background: column.color }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, index) =>
                  index === 0 ? (
                    <th key={table.columns[index].key} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={table.columns[index].key}
                      className={table.columns[index]?.numeric ? "num" : undefined}
                    >
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rest > 0 ? (
        <button
          type="button"
          className="btn btn-sm chart-data-more"
          onClick={() => setShown((current) => current + chunk)}
        >
          Ver {formatNumber(Math.min(chunk, rest))} filas más · quedan{" "}
          {formatNumber(rest)}
        </button>
      ) : null}
    </details>
  );
}

/** Una columna por binomio comparado, con su marca de color. */
const seriesColumns = (series: Series): DataColumn[] =>
  series.map(({ slot, segment }) => ({
    key: segment.key,
    label: segment.label,
    numeric: true,
    color: SERIES_COLOR[slot],
  }));

export function AnalyticsPage() {
  // Una ranura por binomio comparado. `null` = libre. El índice **es** el color.
  const [slots, setSlots] = useState<(string | null)[]>(Array(SLOTS).fill(null));
  const [fuel, setFuel] = useState<FuelType | "">("");
  const [condition, setCondition] = useState<VehicleCondition | "">("");
  const [mixDimension, setMixDimension] = useState<keyof Segment["mix"]>("fuel");

  const selectedKeys = slots.filter((key): key is string => key !== null);
  const requestKeys = selectedKeys.join(",");

  const analytics = useAsync<AnalyticsSegments>(
    () =>
      api.get("/analytics/segments", {
        keys: requestKeys || undefined,
        fuel_type: fuel || undefined,
        condition: condition || undefined,
      }),
    [requestKeys, fuel, condition],
  );

  const data = analytics.data;

  // En cuanto se toca el selector deja de sembrarse solo: si no, quitar el
  // último binomio lo volvería a poner y no habría forma de vaciar la vista.
  const touched = useRef(false);

  useEffect(() => {
    if (!data) return;
    const known = new Set(data.segments.map((segment) => segment.key));

    setSlots((current) => {
      // Un binomio puede desaparecer entre dos cargas —se descarta su última
      // oferta, o se filtra por combustible—. Su ranura tiene que liberarse: si
      // no, queda ocupada por algo que ya no se ve y que no hay forma de quitar,
      // porque su chip tampoco está en la lista.
      const pruned = current.map((key) => (key && known.has(key) ? key : null));
      const same = pruned.every((key, index) => key === current[index]);

      // La primera carga llega sin selección y el backend elige los binomios
      // con más oferta: se adoptan tal cual para que las ranuras y lo que se
      // pinta coincidan, y para no gastar una segunda petición en decir lo mismo.
      if (!touched.current && !pruned.some(Boolean) && data.detail_keys.length) {
        const seed = data.detail_keys.slice(0, SLOTS);
        return Array.from({ length: SLOTS }, (_, index) => seed[index] ?? null);
      }
      return same ? current : pruned;
    });
  }, [data]);

  function toggle(key: string) {
    touched.current = true;
    setSlots((current) => {
      const taken = current.indexOf(key);
      if (taken >= 0) return current.map((value, i) => (i === taken ? null : value));
      const free = current.indexOf(null);
      if (free < 0) return current;
      return current.map((value, i) => (i === free ? key : value));
    });
  }

  const catalog = data?.segments ?? [];
  const byKey = useMemo(
    () => new Map(catalog.map((segment) => [segment.key, segment])),
    [catalog],
  );

  /** Los binomios comparados, en orden de ranura: el índice fija el color. */
  const series = useMemo(
    () =>
      slots
        .map((key, slot) => (key ? { slot, segment: byKey.get(key) } : null))
        .filter(
          (item): item is { slot: number; segment: Segment } => !!item && !!item.segment,
        ),
    [slots, byKey],
  );

  const config: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map(({ slot, segment }) => [
          SERIES[slot],
          { label: segment.label, color: SERIES_COLOR[slot] },
        ]),
      ),
    [series],
  );

  const full = slots.every(Boolean);
  const stale = analytics.loading && !!data;

  return (
    <>
      <PageHeader
        title="Analítica"
        meta={
          data
            ? `${formatNumber(data.offers)} ofertas · ${catalog.length} binomios marca-modelo`
            : undefined
        }
        actions={
          <button className="btn btn-sm" onClick={() => analytics.reload()}>
            Actualizar
          </button>
        }
      />

      <div className="content">
        {/* Un único juego de controles arriba de todo lo que alcanza: los seis
            gráficos y la tabla describen siempre el mismo corte. */}
        <section className="analytics-picker" aria-label="Binomios comparados">
          <div className="analytics-picker-head">
            <span className="section-title" style={{ margin: 0 }}>
              Binomio marca-modelo
            </span>
            <span className="tiny muted">
              {selectedKeys.length}/{SLOTS} ·{" "}
              {full
                ? "quita uno para comparar otro"
                : "el color acompaña al binomio en los seis gráficos"}
            </span>
            <div className="spacer" />
            <select
              className="input select-sm"
              aria-label="Combustible"
              value={fuel}
              onChange={(event) => setFuel(event.target.value as FuelType | "")}
            >
              <option value="">Todos los combustibles</option>
              {Object.entries(FUEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className="input select-sm"
              aria-label="Estado"
              value={condition}
              onChange={(event) =>
                setCondition(event.target.value as VehicleCondition | "")
              }
            >
              <option value="">Todos los estados</option>
              {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {catalog.length === 0 && !analytics.loading ? (
            <Empty
              title="No hay ofertas que analizar"
              hint="Ajusta los filtros o ingesta ofertas desde el scraper."
            />
          ) : (
            <div className="binomio-list" role="group">
              {catalog.map((segment) => {
                const slot = slots.indexOf(segment.key);
                const on = slot >= 0;
                return (
                  <button
                    key={segment.key}
                    type="button"
                    className={`binomio${on ? " on" : ""}`}
                    aria-pressed={on}
                    disabled={!on && full}
                    // El `title` no existe en un móvil: lo mismo va al nombre
                    // accesible, que sí llega a VoiceOver, y el aviso de las tres
                    // ranuras llenas está además escrito arriba, a la vista.
                    aria-label={`${segment.label} · ${segment.offers} ofertas · ${segment.trims} versiones`}
                    title={
                      !on && full
                        ? `Quita uno de los tres para comparar ${segment.label}`
                        : `${segment.label} · ${segment.offers} ofertas · ${segment.trims} versiones`
                    }
                    onClick={() => toggle(segment.key)}
                    style={
                      on
                        ? ({ "--slot": SERIES_COLOR[slot] } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <span className="binomio-dot" aria-hidden="true" />
                    <span className="binomio-name">{segment.label}</span>
                    <span className="binomio-count">{segment.offers}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {analytics.error ? <Banner kind="error">{analytics.error}</Banner> : null}

        {analytics.loading && !data ? (
          <Loading label="Calculando agregados…" />
        ) : series.length === 0 ? (
          catalog.length ? (
            <Empty
              title="Ningún binomio seleccionado"
              hint="Elige hasta tres arriba para compararlos."
            />
          ) : null
        ) : (
          // En una recarga se mantiene lo pintado a media opacidad: un esqueleto
          // en cada cambio de filtro salta la página entera de sitio.
          <div className="analytics" data-stale={stale || undefined}>
            <Headline series={series} />

            {/* La nube de puntos primero: es la que decide una compra. Lo demás
                la acota (dónde está el precio, de qué años, de quién). El radar
                cierra: resume en qué se diferencian los binomios una vez vistas
                las dimensiones una a una. */}
            <div className="chart-grid">
              <PriceVsKmChart series={series} config={config} />
              <PriceRangeChart series={series} config={config} />
              <DepreciationChart series={series} config={config} />
              <PriceHistogram series={series} config={config} />
              <MixChart
                series={series}
                config={config}
                dimension={mixDimension}
                onDimension={setMixDimension}
              />
              <DealerStockChart series={series} config={config} />
              <ProfileRadarChart series={series} catalog={catalog} />
            </div>

            <ComparisonTable series={series} />
          </div>
        )}
      </div>
    </>
  );
}

type Series = { slot: number; segment: Segment }[];

/* -------------------------------------------------------------------------- *
 * Cabecera
 * -------------------------------------------------------------------------- */

/**
 * Cifras del conjunto comparado. Sin tarjetas, como en Ofertas: son contexto de
 * los gráficos que vienen debajo, no seis objetos que comparar entre sí.
 */
function Headline({ series }: { series: Series }) {
  const offers = series.reduce((total, { segment }) => total + segment.offers, 0);
  const dealers = Math.max(...series.map(({ segment }) => segment.dealers));
  const cheapest = series.reduce((best, item) =>
    (item.segment.median_price ?? Infinity) < (best.segment.median_price ?? Infinity)
      ? item
      : best,
  );
  const widest = series.reduce((best, item) =>
    spread(item.segment) > spread(best.segment) ? item : best,
  );

  return (
    <section className="stat-bar" aria-label="Resumen de los binomios comparados">
      <div className="stat-figures">
        <Figure label="Ofertas comparadas" value={formatNumber(offers)} />
        <Figure
          label="Mediana más baja"
          value={formatPrice(cheapest.segment.median_price)}
          hint={cheapest.segment.label}
        />
        <Figure
          label="Mayor dispersión"
          value={formatPrice(spread(widest.segment))}
          hint={`${widest.segment.label} · mín. a máx.`}
        />
        <Figure label="Dealers (máx.)" value={formatNumber(dealers)} />
      </div>
    </section>
  );
}

const spread = (segment: Segment): number =>
  (segment.max_price ?? 0) - (segment.min_price ?? 0);

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className="figure-value">{value}</span>
      {hint ? <span className="figure-hint">{hint}</span> : null}
    </div>
  );
}

function ChartCard({
  title,
  hint,
  wide = false,
  actions,
  data,
  children,
}: {
  title: string;
  hint: string;
  wide?: boolean;
  actions?: React.ReactNode;
  /** La lectura exacta de lo dibujado. Sin ella, el tooltip sería la única. */
  data?: DataTable;
  children: React.ReactNode;
}) {
  return (
    <section className={`chart-card${wide ? " wide" : ""}`}>
      <header className="chart-card-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="chart-card-title">{title}</h2>
          <p className="chart-card-hint">{hint}</p>
        </div>
        {actions ? <div className="chart-card-actions">{actions}</div> : null}
      </header>
      {children}
      {data && data.rows.length ? <ChartData title={title} table={data} /> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * 1 · Rango de precio
 * -------------------------------------------------------------------------- */

interface RangeRow {
  label: string;
  slot: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

/** Lo que Recharts pasa a la `shape` de una barra: su rectángulo y su dato. */
interface ShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: RangeRow;
}

/**
 * Caja y bigotes, en **una sola** barra.
 *
 * Dos decisiones que costaron un rato:
 *
 * - No se apilan tramos. Apilados, Recharts escala cada tramo contra el total
 *   de la pila en vez de contra el eje, y las cajas salían de un píxel. Aquí la
 *   barra es de rango (`dataKey` devuelve `[mínimo, máximo]`) y la forma pinta
 *   lo de dentro interpolando sobre su propio rectángulo, sin tocar la escala.
 * - Y es *una* barra, no una para el bigote y otra para la caja: dos barras en
 *   la misma categoría Recharts las pone en paralelo, así que el bigote salía
 *   flotando encima de su caja en vez de atravesarla.
 */
function BoxWhisker({ x = 0, y = 0, width = 0, height = 0, payload }: ShapeProps) {
  if (!payload) return null;
  const color = SERIES_COLOR[payload.slot];
  const span = payload.max - payload.min;
  const mid = y + height / 2;

  // Con una sola oferta los cinco valores coinciden: el rango es de ancho cero
  // y no habría nada que ver. Se pinta una marca mínima, que es justo lo que
  // pasa —hay un precio y solo uno—, en vez de un hueco que parece un fallo.
  if (span <= 0) {
    return <rect x={x} y={y} width={3} height={height} rx={1.5} fill={color} />;
  }

  const at = (value: number) => x + ((value - payload.min) / span) * width;
  const boxStart = at(payload.p25);
  const boxWidth = Math.max(at(payload.p75) - boxStart, 3);
  const median = Math.min(Math.max(at(payload.median), boxStart), boxStart + boxWidth - 2);

  return (
    <g>
      {/* Bigote: de mínimo a máximo, con tope en cada extremo. */}
      <rect x={x} y={mid - 1} width={width} height={2} fill={color} opacity={0.35} />
      <rect x={x} y={y + 2} width={2} height={height - 4} fill={color} opacity={0.55} />
      <rect x={x + width - 2} y={y + 2} width={2} height={height - 4} fill={color} opacity={0.55} />
      {/* Caja: el recorrido intercuartílico, con la mediana en hueco. */}
      <rect x={boxStart} y={y} width={boxWidth} height={height} rx={3} fill={color} />
      <rect x={median} y={y} width={2} height={height} fill="var(--surface)" />
    </g>
  );
}

function PriceRangeChart({ series, config }: { series: Series; config: ChartConfig }) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();

  const rows: RangeRow[] = series.map(({ slot, segment }) => ({
    label: segment.label,
    slot,
    min: segment.min_price ?? 0,
    p25: segment.p25_price ?? 0,
    median: segment.median_price ?? 0,
    p75: segment.p75_price ?? 0,
    max: segment.max_price ?? 0,
  }));

  const domain = paddedDomain(
    rows.flatMap((row) => [row.min, row.max]),
    0.06,
  );

  const axisWidth = categoryAxisWidth(box.width, 128);

  return (
    <ChartCard
      title="Rango de precio"
      hint="Mínimo · P25 · mediana · P75 · máximo. La caja llena es la mitad central del mercado; la muesca clara, la mediana."
      data={{
        caption: "Los cinco cuantiles de precio de cada binomio comparado.",
        columns: [
          { key: "binomio", label: "Binomio" },
          { key: "min", label: "Mínimo", numeric: true },
          { key: "p25", label: "P25", numeric: true },
          { key: "median", label: "Mediana", numeric: true },
          { key: "p75", label: "P75", numeric: true },
          { key: "max", label: "Máximo", numeric: true },
        ],
        rows: rows.map((row) => ({
          key: row.label,
          cells: [
            row.label,
            formatPrice(row.min),
            formatPrice(row.p25),
            formatPrice(row.median),
            formatPrice(row.p75),
            formatPrice(row.max),
          ],
        })),
      }}
    >
      <ChartContainer config={config} className="chart-box" containerRef={ref} box={box}>
        <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 12, top: 4 }}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" domain={domain} tickFormatter={kEur} {...AXIS} />
          <YAxis
            type="category"
            dataKey="label"
            width={axisWidth}
            // El nombre entero está en «Ver los datos»: aquí se recorta a lo que
            // cabe en vez de desbordar la tarjeta por la izquierda.
            tick={<CategoryTick />}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip cursor={{ fill: "var(--surface-sunken)" }} content={<RangeTip />} />
          <Bar
            dataKey={(row: RangeRow) => [row.min, row.max]}
            shape={<BoxWhisker />}
            barSize={18}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/** Los tramos apilados no son la lectura: la lectura son los cinco números. */
function RangeTip({ active, payload }: { active?: boolean; payload?: { payload: RangeRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">{row.label}</div>
      <dl className="chart-tip-rows">
        <TipRow label="Máximo" value={formatPrice(row.max)} />
        <TipRow label="P75" value={formatPrice(row.p75)} />
        <TipRow label="Mediana" value={formatPrice(row.median)} strong />
        <TipRow label="P25" value={formatPrice(row.p25)} />
        <TipRow label="Mínimo" value={formatPrice(row.min)} />
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * 2 · Precio vs kilómetros
 * -------------------------------------------------------------------------- */

/**
 * El gráfico que decide. Cada punto es una oferta; la recta es el ajuste por
 * mínimos cuadrados de su binomio, o sea lo que ese mercado cobra por el
 * kilometraje. Lo que cae por debajo de su propia recta es lo que está barato
 * *para lo que tiene*, que no es lo mismo que ser el más barato de la lista.
 *
 * La recta solo se dibuja si ajusta algo (R² ≥ 0,15): una pendiente sacada de
 * ocho puntos dispersos parece que sabe algo y no lo sabe.
 */
function PriceVsKmChart({ series, config }: { series: Series; config: ChartConfig }) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();

  const withKm = series.map(({ slot, segment }) => ({
    slot,
    segment,
    points: segment.points.filter((point) => point.mileage_km !== null),
  }));

  const km = withKm.flatMap((item) => item.points.map((point) => point.mileage_km!));
  const prices = withKm.flatMap((item) => item.points.map((point) => point.price));

  if (!km.length) {
    return (
      <ChartCard title="Precio vs kilómetros" hint="Sin kilometraje en las ofertas." wide>
        <Empty title="No hay kilometraje que cruzar" />
      </ChartCard>
    );
  }

  const trends = withKm
    .filter((item) => item.segment.trend && item.segment.trend.r2 >= MIN_R2)
    .map((item) => {
      const { slope, intercept } = item.segment.trend!;
      const xs = item.points.map((point) => point.mileage_km!);
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      return {
        slot: item.slot,
        key: item.segment.key,
        data: [
          { mileage_km: lo, price: intercept + slope * lo },
          { mileage_km: hi, price: intercept + slope * hi },
        ],
      };
    });

  // Una fila por oferta, ordenadas por precio: lo que el tooltip de cada punto
  // enseña con el puntero, aquí se lee con el dedo y con VoiceOver.
  const offerRows = withKm
    .flatMap((item) =>
      item.points.map((point) => ({ label: item.segment.label, point })),
    )
    .sort((a, b) => a.point.price - b.point.price);

  return (
    <ChartCard
      title="Precio vs kilómetros"
      hint="Cada punto es una oferta. La recta es el ajuste de su binomio: por debajo de ella está lo que sale barato para el uso que lleva."
      wide
      data={{
        caption: "Cada oferta dibujada en la nube de puntos, de menor a mayor precio.",
        columns: [
          { key: "title", label: "Oferta" },
          { key: "binomio", label: "Binomio" },
          { key: "price", label: "Precio", numeric: true },
          { key: "km", label: "Kilómetros", numeric: true },
          { key: "year", label: "Año", numeric: true },
          { key: "kmy", label: "Km / año", numeric: true },
          { key: "score", label: "Puntuación", numeric: true },
          { key: "dealer", label: "Dealer" },
        ],
        // Por tramos: con tres binomios en un catálogo grande son más de mil
        // filas, y montarlas de golpe bloquea el hilo principal del teléfono.
        chunk: 100,
        rows: offerRows.map(({ label, point }) => ({
          key: String(point.id),
          cells: [
            point.title,
            label,
            formatPrice(point.price),
            formatKm(point.mileage_km),
            point.year ? String(point.year) : "—",
            formatNumber(point.km_per_year),
            formatNumber(point.value_score),
            point.dealer,
          ],
        })),
      }}
    >
      <ChartContainer config={config} className="chart-scatter" containerRef={ref} box={box}>
        <ScatterChart margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="mileage_km"
            name="Kilómetros"
            domain={paddedDomain(km)}
            tickFormatter={kKm}
            {...AXIS}
          />
          <YAxis
            type="number"
            dataKey="price"
            name="Precio"
            domain={paddedDomain(prices)}
            tickFormatter={kEur}
            // Proporcional también aquí: 52 px son el 16 % de una tarjeta ancha
            // y el 16 % de una estrecha, pero el suelo evita que «24 k€» se corte.
            width={categoryAxisWidth(box.width, 52, 0.16, 40)}
            {...AXIS}
          />
          <ZAxis range={[44, 44]} />
          <ChartTooltip cursor={{ stroke: "var(--border-strong)" }} content={<OfferTip />} />
          {trends.map((trend) => (
            <Scatter
              key={`trend-${trend.key}`}
              data={trend.data}
              line={{
                stroke: SERIES_COLOR[trend.slot],
                strokeWidth: 2,
                strokeDasharray: "5 4",
              }}
              shape={() => <g />}
              legendType="none"
              tooltipType="none"
              isAnimationActive={false}
            />
          ))}
          {withKm.map((item) => (
            <Scatter
              key={item.segment.key}
              // `name` es la ranura, no la etiqueta: es la clave con la que la
              // leyenda de shadcn busca en `config` cómo llamar a la serie.
              name={SERIES[item.slot]}
              dataKey="price"
              data={item.points}
              fill={SERIES_COLOR[item.slot]}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
          <ChartLegend content={<ChartLegendContent nameKey="name" />} />
        </ScatterChart>
      </ChartContainer>

      <ul className="chart-notes">
        {series.map(({ slot, segment }) => (
          <li key={segment.key}>
            <span className="chart-note-dot" style={{ background: SERIES_COLOR[slot] }} />
            <span className="chart-note-label">{segment.label}</span>
            {segment.trend && segment.trend.r2 >= MIN_R2 ? (
              <>
                <strong>{formatPrice(segment.trend.price_per_10k_km)}</strong> por cada
                10.000 km menos
                <span className="muted"> · R² {ratio.format(segment.trend.r2)}</span>
              </>
            ) : (
              <span className="muted">
                sin relación clara entre precio y kilómetros
                {segment.trend ? ` (R² ${ratio.format(segment.trend.r2)})` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

function OfferTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: SegmentPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  if (!point.title) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">{point.title}</div>
      <dl className="chart-tip-rows">
        <TipRow label="Precio" value={formatPrice(point.price)} strong />
        <TipRow label="Kilómetros" value={formatKm(point.mileage_km)} />
        <TipRow label="Año" value={point.year ? String(point.year) : "—"} />
        <TipRow label="Km / año" value={formatNumber(point.km_per_year)} />
        <TipRow label="Puntuación" value={formatNumber(point.value_score)} />
        <TipRow label="Dealer" value={point.dealer} />
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * 3 · Depreciación por año
 * -------------------------------------------------------------------------- */

function DepreciationChart({ series, config }: { series: Series; config: ChartConfig }) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();

  const years = [
    ...new Set(series.flatMap(({ segment }) => segment.by_year.map((item) => item.year))),
  ].sort((a, b) => a - b);

  const rows = years.map((year) => {
    const row: Record<string, number | null> = { year };
    for (const { slot, segment } of series) {
      row[SERIES[slot]] =
        segment.by_year.find((item) => item.year === year)?.median_price ?? null;
    }
    return row;
  });

  const prices = rows.flatMap((row) =>
    SERIES.map((key) => row[key]).filter((value): value is number => value !== null),
  );

  const axisWidth = categoryAxisWidth(box.width, 52, 0.16, 40);

  return (
    <ChartCard
      title="Depreciación por año"
      hint="Mediana de precio de cada año de matrícula. La pendiente es lo que cuesta cada año de antigüedad."
      data={{
        caption: "Mediana de precio por año de matrícula y binomio.",
        columns: [{ key: "year", label: "Año" }, ...seriesColumns(series)],
        rows: rows.map((row) => ({
          key: String(row.year),
          cells: [
            String(row.year),
            ...series.map(({ slot }) => formatPrice(row[SERIES[slot]])),
          ],
        })),
      }}
    >
      {rows.length < 2 ? (
        <Empty title="Hacen falta al menos dos años con oferta" />
      ) : (
        <ChartContainer config={config} className="chart-plot" containerRef={ref} box={box}>
          <LineChart data={rows} margin={{ left: 4, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="year"
              // Los años son categorías: se saltan las que no caben, medidas, en
              // vez de dejar que se pisen dos «2019» contiguos a 390 px.
              interval={tickInterval(
                rows.map((row) => String(row.year)),
                Math.max(0, box.width - axisWidth - 16),
              )}
              {...AXIS}
            />
            <YAxis
              domain={paddedDomain(prices)}
              tickFormatter={kEur}
              width={axisWidth}
              {...AXIS}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  indicator="line"
                  // El año se saca del propio dato. El título que arma shadcn
                  // solo funciona si la etiqueta del eje es texto: siendo un
                  // número, se le escapa y acaba repitiendo el nombre de la
                  // primera serie donde debería ir «2019».
                  labelFormatter={(_, items) =>
                    String(
                      (items?.[0]?.payload as { year?: number } | undefined)?.year ?? "",
                    )
                  }
                  formatter={(value, name) =>
                    tipLine(config, name, formatPrice(Number(value)))
                  }
                />
              }
            />
            {series.map(({ slot }) => (
              <Line
                key={SERIES[slot]}
                type="monotone"
                dataKey={SERIES[slot]}
                stroke={SERIES_COLOR[slot]}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: SERIES_COLOR[slot] }}
                activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            <ChartLegend content={<ChartLegendContent />} />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

/**
 * Una línea del tooltip: nombre de la serie a la izquierda, valor a la derecha.
 *
 * El `name` que entrega Recharts a un `formatter` propio es la clave del dato
 * («s0»), no la etiqueta: el atajo por `config` que hace shadcn solo ocurre en
 * su contenido por defecto, y poner un `formatter` se lo salta. Por eso la
 * traducción se hace aquí, contra el mismo `config` que pintan los gráficos.
 */
function tipLine(config: ChartConfig, name: unknown, value: string) {
  const key = String(name);
  const label = config[key]?.label;
  return (
    <span className="chart-tip-inline">
      <span className="muted">{label ?? key}</span>
      <strong>{value}</strong>
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * 4 · Distribución de precio
 * -------------------------------------------------------------------------- */

/** Dónde se concentra la oferta: los tramos son comunes, así que se comparan. */
function PriceHistogram({ series, config }: { series: Series; config: ChartConfig }) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();

  const prices = series.flatMap(({ segment }) =>
    segment.points.map((point) => point.price),
  );

  if (prices.length < 2) {
    return (
      <ChartCard title="Distribución de precio" hint="Sin ofertas suficientes.">
        <Empty title="Hacen falta al menos dos ofertas" />
      </ChartCard>
    );
  }

  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const step = niceStep((hi - lo) / 8 || 1);
  const start = Math.floor(lo / step) * step;
  const bucketCount = Math.max(1, Math.ceil((hi - start + 1) / step));

  const rows = Array.from({ length: bucketCount }, (_, index) => {
    const from = start + index * step;
    const row: Record<string, string | number> = {
      bucket: `${kEur(from)}`,
      from,
    };
    for (const { slot, segment } of series) {
      row[SERIES[slot]] = segment.points.filter(
        (point) => point.price >= from && point.price < from + step,
      ).length;
    }
    return row;
  });

  return (
    <ChartCard
      title="Distribución de precio"
      hint={`Ofertas por tramo de ${kEur(step)}. Donde hay masa hay con qué negociar.`}
      data={{
        caption: `Número de ofertas de cada binomio por tramo de ${kEur(step)}.`,
        columns: [{ key: "bucket", label: "Desde" }, ...seriesColumns(series)],
        rows: rows.map((row) => ({
          key: String(row.from),
          cells: [
            `${row.bucket}`,
            ...series.map(({ slot }) => formatNumber(Number(row[SERIES[slot]] ?? 0))),
          ],
        })),
      }}
    >
      <ChartContainer config={config} className="chart-plot" containerRef={ref} box={box}>
        <BarChart data={rows} margin={{ left: 4, right: 12, top: 8 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="bucket"
            // El tramo es un número con su unidad, no un nombre propio: saltarse
            // alguno se lee sin problema, y a 326 px doce rótulos «12,5 k€» no
            // caben sin tocarse. El eje de dealers, que sí *es* el nombre,
            // conserva su `interval={0}`.
            interval={tickInterval(
              rows.map((row) => String(row.bucket)),
              Math.max(0, box.width - 28 - 16),
            )}
            {...AXIS}
          />
          <YAxis allowDecimals={false} width={28} {...AXIS} />
          <ChartTooltip
            cursor={{ fill: "var(--surface-sunken)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(label) => `Desde ${label}`}
                formatter={(value, name) =>
                  tipLine(config, name, `${formatNumber(Number(value))} ofertas`)
                }
              />
            }
          />
          {series.map(({ slot }) => (
            <Bar
              key={SERIES[slot]}
              dataKey={SERIES[slot]}
              fill={SERIES_COLOR[slot]}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          ))}
          <ChartLegend content={<ChartLegendContent />} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- *
 * 5 · Stock por dealer
 * -------------------------------------------------------------------------- */

/** A quién hay que mirar: los ocho dealers con más oferta del conjunto. */
function DealerStockChart({ series, config }: { series: Series; config: ChartConfig }) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();
  const totals = new Map<string, { offers: number; row: Record<string, string | number> }>();

  for (const { slot, segment } of series) {
    for (const dealer of segment.by_dealer) {
      const entry = totals.get(dealer.dealer) ?? {
        offers: 0,
        row: { dealer: dealer.dealer },
      };
      entry.offers += dealer.offers;
      entry.row[SERIES[slot]] = dealer.offers;
      totals.set(dealer.dealer, entry);
    }
  }

  const top = [...totals.values()].sort((a, b) => b.offers - a.offers).slice(0, 8);
  const rows = top.map((entry) => entry.row);

  // 32 % del contenedor, no 208 px: en una tarjeta de 326 el eje se quedaba con
  // 208 y dejaba 108 para ocho barras apiladas. Ahora son 104 y 222.
  const axisWidth = categoryAxisWidth(box.width, 208, 0.32, 72);

  return (
    <ChartCard
      title="Dealers con más stock"
      hint="Quién concentra la oferta de los binomios comparados. Ocho como mucho: más allá deja de comparar."
      wide
      data={{
        caption:
          "Ofertas por dealer y binomio, con el nombre completo de cada dealer.",
        columns: [
          { key: "dealer", label: "Dealer" },
          ...seriesColumns(series),
          { key: "total", label: "Total", numeric: true },
        ],
        rows: top.map((entry) => ({
          key: String(entry.row.dealer),
          cells: [
            String(entry.row.dealer),
            ...series.map(({ slot }) => formatNumber(Number(entry.row[SERIES[slot]] ?? 0))),
            formatNumber(entry.offers),
          ],
        })),
      }}
    >
      {rows.length === 0 ? (
        <Empty title="Sin dealers que mostrar" />
      ) : (
        <ChartContainer config={config} className="chart-tall" containerRef={ref} box={box}>
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 16, top: 4 }}>
            <CartesianGrid horizontal={false} stroke="var(--border)" />
            <XAxis type="number" allowDecimals={false} {...AXIS} />
            <YAxis
              type="category"
              dataKey="dealer"
              width={axisWidth}
              // Sin esto Recharts se salta etiquetas y quedan barras anónimas,
              // que en un gráfico cuyo eje *es* el nombre no vale para nada. Lo
              // que se recorta es el rótulo, nunca la lista: el nombre entero
              // —«OcasionPlus Madrid - Alcalá de Henares», 56 caracteres— está
              // en «Ver los datos».
              interval={0}
              tickFormatter={(value: string) => fitLabel(String(value), axisWidth - 10, 11)}
              tick={{ fontSize: 11, fill: "var(--text-secondary)" }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              cursor={{ fill: "var(--surface-sunken)" }}
              content={
                <ChartTooltipContent
                  formatter={(value, name) =>
                    tipLine(config, name, `${formatNumber(Number(value))} ofertas`)
                  }
                />
              }
            />
            {series.map(({ slot }) => (
              <Bar
                key={SERIES[slot]}
                dataKey={SERIES[slot]}
                stackId="stock"
                fill={SERIES_COLOR[slot]}
                {...GAP}
                barSize={14}
                isAnimationActive={false}
              />
            ))}
            {/* Aquí el color es lo único que dice de qué binomio es cada tramo:
                el nombre del eje es el del dealer, no el de la serie. */}
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- *
 * 6 · Composición
 * -------------------------------------------------------------------------- */

const DIMENSIONS: {
  key: keyof Segment["mix"];
  label: string;
  labels: Record<string, string>;
}[] = [
  { key: "fuel", label: "Combustible", labels: FUEL_LABELS },
  { key: "transmission", label: "Cambio", labels: TRANSMISSION_LABELS },
  { key: "condition", label: "Estado", labels: CONDITION_LABELS },
];

/**
 * En porcentaje y no en recuento a propósito: los binomios tienen tamaños muy
 * distintos y la pregunta es «qué proporción de *esta* oferta es diésel», que en
 * recuentos absolutos no se puede leer. El número absoluto está en el tooltip.
 *
 * Y en barras agrupadas y no en tarta: el color sigue siendo el del binomio, así
 * que no hace falta inventar una paleta nueva para siete combustibles —que
 * además no se podrían distinguir.
 */
function MixChart({
  series,
  config,
  dimension,
  onDimension,
}: {
  series: Series;
  config: ChartConfig;
  dimension: keyof Segment["mix"];
  onDimension: (value: keyof Segment["mix"]) => void;
}) {
  const [ref, box] = useMeasuredBox<HTMLDivElement>();
  const active = DIMENSIONS.find((item) => item.key === dimension) ?? DIMENSIONS[0];

  const values = [
    ...new Set(
      series.flatMap(({ segment }) => segment.mix[dimension].map((slice) => slice.key)),
    ),
  ];

  const rows = values
    .map((value) => {
      const row: Record<string, string | number> = {
        name: active.labels[value] ?? value,
      };
      let total = 0;
      for (const { slot, segment } of series) {
        const slices = segment.mix[dimension];
        const all = slices.reduce((sum, slice) => sum + slice.offers, 0);
        const offers = slices.find((slice) => slice.key === value)?.offers ?? 0;
        row[SERIES[slot]] = all ? Math.round((offers / all) * 1000) / 10 : 0;
        row[`${SERIES[slot]}_n`] = offers;
        total += offers;
      }
      return { row, total };
    })
    .sort((a, b) => b.total - a.total)
    .map((item) => item.row);

  /* Por debajo del corte, las categorías se van al eje Y.
   *
   * Es lo que impide el amasijo: siete combustibles en el eje X de una tarjeta
   * de 326 px dejan 40 px por rótulo, y «Híbrido enchufable» mide 96. Recharts
   * no recorta, así que las etiquetas se montaban unas sobre otras y se leía
   * «HíbHídoenchufabunknown». En vertical, cada categoría tiene su renglón
   * entero y el porcentaje corre a lo largo, que además es la dirección en la
   * que se comparan proporciones. */
  const vertical = isNarrow(box.width);
  const axisWidth = categoryAxisWidth(box.width, 160, 0.34, 72);
  // Un renglón por categoría y por serie, más el aire del eje: en horizontal el
  // alto lo fija la clase, en vertical lo fija cuánta categoría hay.
  const height = vertical
    ? Math.max(232, rows.length * (series.length * 12 + 20) + 64)
    : undefined;

  return (
    <ChartCard
      title="Composición de la oferta"
      hint={`Reparto por ${active.label.toLowerCase()}, en % de cada binomio. Los tamaños son distintos, así que el recuento no compara.`}
      data={{
        caption: `Reparto por ${active.label.toLowerCase()}: porcentaje y número de ofertas de cada binomio.`,
        columns: [
          { key: "name", label: active.label },
          ...series.flatMap(({ slot, segment }) => [
            {
              key: `${segment.key}-pct`,
              label: `${segment.label} %`,
              numeric: true,
              color: SERIES_COLOR[slot],
            },
            { key: `${segment.key}-n`, label: `${segment.label} ofertas`, numeric: true },
          ]),
        ],
        rows: rows.map((row) => ({
          key: String(row.name),
          cells: [
            String(row.name),
            ...series.flatMap(({ slot }) => [
              formatPct(Number(row[SERIES[slot]] ?? 0)),
              formatNumber(Number(row[`${SERIES[slot]}_n`] ?? 0)),
            ]),
          ],
        })),
      }}
      actions={
        <div className="segmented" role="group" aria-label="Dimensión">
          {DIMENSIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === dimension ? "on" : ""}
              aria-pressed={item.key === dimension}
              onClick={() => onDimension(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <Empty title="Sin datos de esta dimensión" />
      ) : (
        <ChartContainer
          config={config}
          className="chart-plot"
          containerRef={ref} box={box}
          style={height ? { height } : undefined}
        >
          <BarChart
            data={rows}
            layout={vertical ? "vertical" : "horizontal"}
            margin={{ left: 4, right: 12, top: 8 }}
            barGap={2}
          >
            <CartesianGrid
              horizontal={!vertical}
              vertical={vertical}
              stroke="var(--border)"
            />
            {vertical ? (
              <XAxis
                type="number"
                domain={[0, 100]}
                tickFormatter={(value) => `${value}%`}
                {...AXIS}
              />
            ) : (
              <XAxis dataKey="name" interval={0} {...AXIS} />
            )}
            {vertical ? (
              <YAxis
                type="category"
                dataKey="name"
                width={axisWidth}
                interval={0}
                tickFormatter={(value: string) => fitLabel(String(value), axisWidth - 10, 11)}
                {...AXIS}
              />
            ) : (
              <YAxis
                width={34}
                domain={[0, 100]}
                tickFormatter={(value) => `${value}%`}
                {...AXIS}
              />
            )}
            <ChartTooltip
              cursor={{ fill: "var(--surface-sunken)" }}
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) =>
                    tipLine(
                      config,
                      name,
                      `${formatPct(Number(value))} · ${formatNumber(
                        Number(item?.payload?.[`${item.dataKey}_n`] ?? 0),
                      )} ofertas`,
                    )
                  }
                />
              }
            />
            {series.map(({ slot }) => (
              <Bar
                key={SERIES[slot]}
                dataKey={SERIES[slot]}
                fill={SERIES_COLOR[slot]}
                // La esquina redondeada va en la punta de la barra, y la punta
                // cambia de lado al girar el gráfico.
                radius={vertical ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                isAnimationActive={false}
              />
            ))}
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- *
 * 7 · Perfil comparado
 * -------------------------------------------------------------------------- */

/**
 * Los seis ejes del radar, con la dirección puesta desde el punto de vista de
 * quien compra: en todos, más lejos del centro es mejor. Sin esa regla un radar
 * mezcla ejes que suben y ejes que bajan y el polígono deja de significar nada.
 *
 * El `minSpan` es el recorrido por debajo del cual las diferencias no se
 * estiran: 15 % en precio, 20 % en kilómetros, un año y medio de matrícula,
 * cuatro puntos de descuento. Por debajo de eso los binomios se quedan pegados
 * al centro, que es la lectura correcta —son parecidos—, en vez de separarse por
 * un ruido de dos decimales.
 */
const PROFILE_AXES: (Omit<RadarAxis, "cohort" | "values"> & {
  of: (segment: Segment) => number | null;
})[] = [
  {
    label: "Precio",
    hint: "mediana del binomio",
    direction: -1,
    minSpan: 0.15,
    relative: true,
    format: formatPrice,
    of: (segment) => segment.median_price,
  },
  {
    label: "Kilómetros",
    hint: "media del binomio",
    direction: -1,
    minSpan: 0.2,
    relative: true,
    format: formatKm,
    of: (segment) => segment.avg_mileage_km,
  },
  {
    label: "Año",
    hint: "matrícula media",
    direction: 1,
    minSpan: 1.5,
    format: (value) => decimal.format(value),
    of: (segment) => segment.avg_year,
  },
  {
    label: "Km / año",
    hint: "uso medio",
    direction: -1,
    minSpan: 0.2,
    relative: true,
    format: formatNumber,
    of: (segment) => segment.avg_km_per_year,
  },
  {
    label: "Descuento",
    hint: "medio sobre PVP",
    direction: 1,
    minSpan: 4,
    format: formatPct,
    of: (segment) => segment.avg_discount_pct,
  },
  {
    label: "Oferta",
    hint: "cuánto donde elegir",
    direction: 1,
    minSpan: 0.5,
    relative: true,
    format: (value) => `${formatNumber(value)} ofertas`,
    of: (segment) => segment.offers,
  },
];

/**
 * La silueta de cada binomio, en un solo dibujo.
 *
 * Los otros seis gráficos contestan cada uno a una dimensión; este contesta a la
 * pregunta que va antes: **en qué se diferencian estos coches**. Un binomio
 * barato y viejo y otro caro y nuevo salen como dos polígonos volcados a lados
 * opuestos, y eso no se ve en seis gráficos separados por mucho que los seis
 * lleven el mismo color.
 *
 * Se normaliza contra **todo el catálogo**, no contra los seleccionados: así la
 * forma de un binomio no cambia al añadir o quitar otro. Contra los
 * seleccionados, comparar dos dejaría siempre a uno en el borde y a otro en el
 * centro en todos los ejes, que es un dibujo que se puede predecir sin mirar los
 * datos y por tanto no informa de nada.
 */
function ProfileRadarChart({ series, catalog }: { series: Series; catalog: Segment[] }) {
  const keys = series.map(({ slot }) => SERIES[slot]);

  const { rows, dropped } = buildRadar(
    PROFILE_AXES.map((axis) => ({
      ...axis,
      cohort: catalog.map(axis.of),
      values: series.map(({ segment }) => axis.of(segment)),
    })),
    keys,
    // Dos binomios ya son una comparación: cada uno es el agregado de sus
    // ofertas, no una oferta suelta que pueda ser un caso raro.
    { minCohort: 2 },
  );

  const radarSeries: RadarSeries[] = series.map(({ slot, segment }) => ({
    key: SERIES[slot],
    label: segment.label,
    color: SERIES_COLOR[slot],
  }));

  return (
    <ChartCard
      title="Perfil comparado"
      hint="El anillo discontinuo es el binomio típico del catálogo; fuera de él está lo que es mejor para quien compra. El borde es la mayor diferencia que hay en el catálogo, así que la posición compara, no puntúa."
      wide
      data={{
        caption:
          "Valor crudo de cada binomio en cada eje del radar, con la mediana del catálogo.",
        columns: [
          { key: "axis", label: "Eje" },
          ...seriesColumns(series),
          { key: "ref", label: "Mediana del catálogo", numeric: true },
        ],
        // El radio del polígono es una posición relativa, no una nota: lo que se
        // escribe es el valor crudo, que es el que se puede comparar con algo.
        rows: rows.map((row) => ({
          key: row.axis,
          cells: [
            row.hint ? `${row.axis} · ${row.hint}` : row.axis,
            ...series.map(
              ({ slot }) =>
                row.cells.find((cell) => cell.key === SERIES[slot])?.raw ?? "—",
            ),
            row.refRaw,
          ],
        })),
      }}
    >
      {rows.length < RADAR_MIN_AXES ? (
        <Empty
          title="No hay ejes suficientes que comparar"
          hint={
            catalog.length < 2
              ? "Hace falta más de un binomio marca-modelo en el catálogo para tener contra qué normalizar."
              : "Los binomios comparados no comparten datos suficientes en ninguna dimensión."
          }
        />
      ) : (
        <div className="radar-split">
          <RadarProfile
            rows={rows}
            series={radarSeries}
            referenceLabel="Mediana del catálogo"
          />

          {/* Esta lista es la leyenda del radar y su lectura a la vez: el mismo
              color, el mismo orden, y lo que el polígono dice de cada binomio
              escrito en una línea. */}
          <ul className="chart-notes radar-notes">
            <li>
              <RadarMark color="var(--text-tertiary)" dashed />
              <span className="chart-note-label">Mediana del catálogo</span>
              <span className="muted">el binomio típico, eje a eje</span>
            </li>
            {series.map(({ slot, segment }) => (
              <li key={segment.key}>
                <RadarMark color={SERIES_COLOR[slot]} />
                <span className="chart-note-label">{segment.label}</span>
                <RadarReading rows={rows} seriesKey={SERIES[slot]} />
              </li>
            ))}
            {dropped.length ? (
              <li className="muted">
                Fuera del radar: {dropped.join(", ").toLowerCase()}. Un eje se cae cuando
                alguno de los binomios comparados no trae el dato o cuando todo el catálogo
                vale lo mismo.
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

/* -------------------------------------------------------------------------- *
 * Cuadro comparativo
 * -------------------------------------------------------------------------- */

/**
 * La lectura exacta, y el equivalente accesible de los seis gráficos: todo lo
 * que ahí se codifica con color y posición aquí es un número con su etiqueta.
 *
 * Las métricas van en filas y los binomios en columnas porque lo que se compara
 * son los binomios: puestos en columnas, cada fila es una comparación directa.
 * **Eso vale mientras las columnas quepan.** En 390 pt, dieciséis métricas por
 * tres binomios solo caben con scroll horizontal, que como modo de lectura de
 * una tabla en un móvil no es aceptable: obliga a barrer a ciegas para leer un
 * registro. Por debajo del corte táctil la matriz se parte en un bloque por
 * binomio, cada uno con su marca de color y sus dieciséis métricas en una
 * columna. Se pierde la comparación de un vistazo —pasa a ser un desplazamiento
 * vertical entre bloques— y no se pierde ninguna cifra.
 */
function ComparisonTable({ series }: { series: Series }) {
  const touch = useTouchLayout();
  const rows: { label: string; hint?: string; value: (segment: Segment) => string }[] = [
    { label: "Ofertas", value: (s) => formatNumber(s.offers) },
    { label: "Dealers", value: (s) => formatNumber(s.dealers) },
    { label: "Versiones", value: (s) => formatNumber(s.trims) },
    { label: "Mínimo", value: (s) => formatPrice(s.min_price) },
    { label: "P25", value: (s) => formatPrice(s.p25_price) },
    { label: "Mediana", value: (s) => formatPrice(s.median_price) },
    { label: "P75", value: (s) => formatPrice(s.p75_price) },
    { label: "Máximo", value: (s) => formatPrice(s.max_price) },
    { label: "Precio medio", value: (s) => formatPrice(s.avg_price) },
    { label: "Km medios", value: (s) => formatKm(s.avg_mileage_km) },
    { label: "Km / año", value: (s) => formatNumber(s.avg_km_per_year) },
    {
      label: "Año medio",
      value: (s) => (s.avg_year === null ? "—" : decimal.format(s.avg_year)),
    },
    {
      label: "Descuento medio",
      hint: "sobre PVP",
      value: (s) => formatPct(s.avg_discount_pct),
    },
    {
      label: "€ por 10.000 km",
      hint: "lo que cobra el mercado por menos uso",
      value: (s) =>
        s.trend && s.trend.r2 >= MIN_R2 ? formatPrice(s.trend.price_per_10k_km) : "—",
    },
    {
      label: "Ajuste de la recta",
      hint: "R² de precio ~ km",
      value: (s) => (s.trend ? ratio.format(s.trend.r2) : "—"),
    },
    {
      label: "Puntuación de valor",
      hint: "media de las ofertas puntuadas",
      value: (s) => formatNumber(s.avg_value_score),
    },
  ];

  const sampled = series.filter(
    ({ segment }) => segment.offers_sampled > 0 && segment.offers_sampled < segment.offers,
  );

  return (
    <section className="analytics-table">
      <h2 className="section-title">Cuadro comparativo</h2>
      {touch ? (
        <div className="stack">
          {series.map(({ slot, segment }) => (
            <section key={segment.key}>
              <h3 className="card-title">
                <span className="th-series">
                  <span
                    className="chart-note-dot"
                    style={{ background: SERIES_COLOR[slot] }}
                    aria-hidden="true"
                  />
                  {segment.label}
                </span>
              </h3>
              {/* Una `<ul>` de `<li>` y no la tabla con `display: block`: una
                  tabla desmontada con CSS pierde su semántica sin avisar. */}
              <ul className="record-list">
                {rows.map((row) => (
                  <li key={row.label} className="record-item">
                    <div className="record-head">
                      <span className="record-title">{row.label}</span>
                      <span className="record-value">{row.value(segment)}</span>
                    </div>
                    {/* La aclaración de la métrica, que en la tabla va pegada a
                        su etiqueta, aquí es la segunda línea. */}
                    {row.hint ? <div className="record-meta">{row.hint}</div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th>Métrica</th>
                {series.map(({ slot, segment }) => (
                  <th key={segment.key} className="num">
                    <span className="th-series">
                      <span
                        className="chart-note-dot"
                        style={{ background: SERIES_COLOR[slot] }}
                        aria-hidden="true"
                      />
                      {segment.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="cell-primary">
                    {row.label}
                    {row.hint ? <span className="tiny muted"> · {row.hint}</span> : null}
                  </td>
                  {series.map(({ segment }) => (
                    <td key={segment.key} className="num">
                      {row.value(segment)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sampled.length ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          La puntuación de valor y la recta se calculan sobre una muestra:{" "}
          {sampled
            .map(
              ({ segment }) =>
                `${segment.label}, ${formatNumber(segment.offers_sampled)} de ${formatNumber(segment.offers)}`,
            )
            .join(" · ")}
          . El resto de cifras describe el conjunto entero.
        </p>
      ) : null}
    </section>
  );
}
