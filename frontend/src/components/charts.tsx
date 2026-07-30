/**
 * Piezas de gráfico compartidas entre páginas.
 *
 * Aquí solo vive lo que se pinta en más de un sitio. Cada página sigue armando
 * sus ejes —los rótulos y los formatos son suyos—; lo común es cómo se dibuja el
 * radar y cómo se lee su tooltip, que es justo lo que no puede divergir entre la
 * Analítica y el panel de una oferta.
 */

import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "./ui/chart";
import { extremeAxis, type RadarRow } from "../lib/radar";

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
 * «barato»—, así que la cifra que se enseña es siempre la cruda, en el tooltip.
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
  const config: ChartConfig = {
    ...Object.fromEntries(
      series.map((item) => [item.key, { label: item.label, color: item.color }]),
    ),
    ref: { label: referenceLabel, color: "var(--text-tertiary)" },
  };

  // Con una sola serie el relleno ayuda a leer la silueta; con tres se pisan y
  // lo que queda es un gris del que no sale ninguna de las tres.
  const fillOpacity = series.length > 1 ? 0.08 : 0.16;

  return (
    <ChartContainer config={config} className={className}>
      <RadarChart data={rows} outerRadius="66%" margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <PolarGrid stroke="var(--border)" />
        <PolarAngleAxis
          dataKey="axis"
          tick={{ fontSize: 11, fill: "var(--text-secondary)" }}
        />
        {/* Cinco marcas sobre 0-100 dejan un anillo de rejilla justo en el 50, que
            es donde va la referencia: el aro discontinuo cae sobre una línea que
            ya existe en vez de inventar un radio suelto. Sin rótulos, porque un
            0-100 alrededor del dibujo se lee como nota y no lo es. */}
        <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} tickCount={5} />
        <ChartTooltip content={<RadarTip series={series} referenceLabel={referenceLabel} />} />
        {/* El anillo va primero: es el fondo contra el que se leen las series. */}
        <Radar
          dataKey="ref"
          name="ref"
          stroke="var(--text-tertiary)"
          strokeWidth={1}
          strokeDasharray="4 4"
          fill="var(--text-tertiary)"
          fillOpacity={0}
          dot={false}
          isAnimationActive={false}
        />
        {series.map((item) => (
          <Radar
            key={item.key}
            dataKey={item.key}
            name={item.key}
            stroke={item.color}
            strokeWidth={2}
            fill={item.color}
            fillOpacity={fillOpacity}
            // `fillOpacity` explícito en el punto: Recharts le pasa al `dot` las
            // props del propio radar, así que sin esto los vértices heredan el
            // 8 % del relleno y desaparecen justo donde hay que leer el valor.
            dot={{ r: 2.5, fill: item.color, fillOpacity: 1, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        ))}
        {/* Sin leyenda dentro del gráfico: la lista que va al lado ya lleva el
            color de cada serie y además su lectura, y una leyenda de cuatro
            nombres largos se parte en tres líneas que le quitan al polígono el
            alto del que sale su radio. */}
      </RadarChart>
    </ChartContainer>
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
  active,
  payload,
  series,
  referenceLabel,
}: {
  active?: boolean;
  payload?: { payload: RadarRow }[];
  series: RadarSeries[];
  referenceLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

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
