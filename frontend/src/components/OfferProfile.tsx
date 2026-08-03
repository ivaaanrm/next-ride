import { Banner, Loading } from "./ui";
import { api } from "../lib/api";
import { formatDate, formatKm, formatNumber, formatPrice } from "../lib/format";
import { useAsync } from "../lib/hooks";
import {
  buildRadar,
  extremeAxis,
  RADAR_MID,
  RADAR_MIN_AXES,
  type RadarAxis,
  type RadarRow,
} from "../lib/radar";
import type {
  AnalyticsSegments,
  Offer,
  OfferPricePoint,
  SegmentPoint,
} from "../types";

/* -------------------------------------------------------------------------- *
 * Perfil frente a sus comparables — lectura primero, dibujo después
 *
 * Aquí estaba el radar de Recharts. Se va, y por dos motivos que apuntan en la
 * misma dirección:
 *
 * 1. **Coste.** `recharts + d3` son 116,7 KB gzip, y como esta pantalla es la
 *    ruta por defecto, importarlos aquí los metía en el chunk de entrada y
 *    anulaba el `lazy()` de la Analítica. Quien entra a mirar precios se
 *    descargaba una librería de gráficos para ver una lista.
 * 2. **Interacción.** Las cifras del radar solo existían en un tooltip, y un
 *    dedo no puede invocar un tooltip. El polígono decía «este coche está lejos
 *    del centro en precio» y no decía cuánto ni desde qué.
 *
 * Lo que queda es lo que el propio `charts.tsx` ya declaraba equivalente
 * accesible del dibujo —«lo que el radar codifica en posición, aquí es texto»—,
 * promovido a representación principal: una frase, cinco filas de barra con la
 * mediana marcada en el centro, y el valor crudo escrito al lado.
 *
 * `lib/radar.ts` no se toca: es aritmética pura, sin Recharts, y ya devuelve
 * estos radios y estos valores crudos. Esto es un cambio de renderizado, no de
 * datos, y por eso el perfil sigue significando exactamente lo mismo que antes.
 * -------------------------------------------------------------------------- */

/** Lo que hace falta de una oferta para colocarla en el perfil. */
type Comparable = Pick<
  SegmentPoint,
  "price" | "mileage_km" | "year" | "km_per_year" | "value_score"
>;

const asComparable = (offer: Offer): Comparable => ({
  price: offer.price,
  mileage_km: offer.mileage_km,
  year: offer.year,
  km_per_year: offer.metrics.km_per_year,
  value_score: offer.metrics.value_score,
});

/**
 * Los cinco ejes, todos orientados a favor de quien compra: más a la derecha es
 * mejor, siempre. La escala es la misma que la de la Analítica —mediana en el
 * centro, mayor desviación del conjunto en el borde, con un recorrido mínimo
 * para que una diferencia pequeña no se estire—, solo que aquí el conjunto son
 * las otras ofertas del mismo binomio marca-modelo.
 *
 * El descuento sobre PVP no tiene eje propio: solo una de cada tres ofertas trae
 * `original_price`, así que el eje se caía casi siempre y cuando no, comparaba
 * contra una mediana de cuatro anuncios. Sigue contando dentro de «Valor».
 *
 * «Valor» es la puntuación de la plataforma. Está aquí porque no es una función
 * de los otros cuatro ejes: mira el precio contra la mediana de *su versión
 * exacta*, no contra la del binomio, y suma el descuento, la bajada de precio y
 * la valoración del dealer, que no tienen eje propio.
 */
const OFFER_AXES: (Omit<RadarAxis, "cohort" | "values"> & {
  of: (item: Comparable) => number | null;
})[] = [
  {
    label: "Precio",
    hint: "frente al binomio, no a la versión",
    direction: -1,
    minSpan: 0.15,
    relative: true,
    format: formatPrice,
    of: (item) => item.price,
  },
  {
    label: "Kilómetros",
    hint: "recorridos",
    direction: -1,
    minSpan: 0.2,
    relative: true,
    format: formatKm,
    of: (item) => item.mileage_km,
  },
  {
    label: "Año",
    hint: "de matrícula",
    direction: 1,
    minSpan: 1.5,
    format: (value) => String(Math.round(value)),
    of: (item) => item.year,
  },
  {
    label: "Km / año",
    hint: "uso",
    direction: -1,
    minSpan: 0.2,
    relative: true,
    format: formatNumber,
    of: (item) => item.km_per_year,
  },
  {
    label: "Valor",
    hint: "puntuación de la plataforma",
    direction: 1,
    minSpan: 8,
    format: (value) => `${formatNumber(value)}/100`,
    of: (item) => item.value_score,
  },
];

/**
 * Dónde cae esta oferta dentro de su mercado.
 *
 * El conjunto de comparación es el **binomio marca-modelo**, no la fila de
 * `car_models`: el catálogo se fragmenta por acabado —un «Audi A4 Allroad
 * Quattro» son once filas— y contra dos o tres ofertas de la misma versión
 * exacta no hay mediana que valga. Por eso el cohorte se pide a `/analytics`,
 * que agrupa por marca y modelo, y no al listado filtrando por modelo.
 *
 * La propia oferta cuenta dentro del cohorte, como cualquier otra: quitarla
 * movería la mediana de un mercado del que forma parte.
 *
 * Vive en su propio componente para que la petición salga al abrir el panel de
 * *esta* oferta y no con la lista entera.
 */
export function OfferProfile({ offer }: { offer: Offer }) {
  const key = `${offer.car_model.make.toLowerCase()}|${offer.car_model.model.toLowerCase()}`;
  const cohort = useAsync<AnalyticsSegments>(
    () => api.get("/analytics/segments", { keys: key }),
    [key],
  );

  if (cohort.loading) return <Loading label="Buscando comparables…" />;
  if (cohort.error) return <Banner kind="error">{cohort.error}</Banner>;

  const segment = cohort.data?.segments.find((item) => item.key === key);
  const points = segment?.points ?? [];

  // El cohorte lo forman las ofertas **activas**: una descartada o expirada se
  // sigue pudiendo mirar, y compararla contra el mercado que hay hoy es
  // justamente la pregunta («¿qué me perdí?»). Solo hay que decirlo.
  if (points.length < 4) {
    const n = points.length;
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        {segment
          ? `Solo hay ${formatNumber(n)} oferta${n === 1 ? "" : "s"} activa${n === 1 ? "" : "s"} de ${segment.label}: hacen falta al menos cuatro para que la mediana signifique algo.`
          : "No hay ofertas activas de este binomio marca-modelo contra las que comparar."}
      </p>
    );
  }

  const { rows, dropped } = buildRadar(
    OFFER_AXES.map((axis) => ({
      ...axis,
      cohort: points.map(axis.of),
      values: [axis.of(asComparable(offer))],
    })),
    ["offer"],
  );

  if (rows.length < RADAR_MIN_AXES) {
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        Esta oferta y sus comparables no comparten datos suficientes para dibujar un
        perfil: {dropped.join(", ").toLowerCase()} se quedan fuera.
      </p>
    );
  }

  return (
    <div className="profile">
      <p className="profile-reading">
        Frente a {formatNumber(points.length)} comparables de {segment?.label}, esta
        oferta <ProfileReading rows={rows} seriesKey="offer" />.
      </p>

      <div className="profile-rows">
        {rows.map((row) => (
          <ProfileBar key={row.axis} row={row} seriesKey="offer" />
        ))}
      </div>

      <p className="profile-note">
        La marca del centro de cada barra es la mediana de los comparables. A la
        derecha, mejor para quien compra; a la izquierda, peor.
      </p>

      {/* «Valor» es el único eje que no se lee en el propio anuncio; su cuenta
          completa —señal a señal, con los pesos finales— está en el desglose de
          arriba de este mismo panel, así que aquí basta la definición. */}
      <p className="profile-note">
        <strong>Valor</strong> es la media ponderada de las señales del desglose de
        arriba: precio frente al mercado y frente al valor esperado por depreciación,
        kilometraje, antigüedad, bajada, descuento, dealer y frescura. Los pesos se ven y
        se editan en Ajustes.
      </p>

      {dropped.length ? (
        <p className="profile-note">
          Fuera del perfil: {dropped.join(", ").toLowerCase()}. Un eje se cae cuando esta
          oferta no trae el dato o cuando sus comparables no lo traen.
        </p>
      ) : null}
    </div>
  );
}

/**
 * El perfil leído en una frase.
 *
 * Es la misma prosa que `RadarReading` en `charts.tsx`, escrita otra vez a
 * propósito: importarla de allí devolvería Recharts al chunk de entrada por la
 * puerta de atrás y volvería a romper el presupuesto de arranque. Veinte líneas
 * duplicadas contra 116 KB en la ruta por defecto no es una decisión difícil.
 *
 * Los umbrales no son decorativos: a menos de cinco puntos del centro la
 * diferencia cabe dentro del recorrido mínimo del eje, y llamar «destaca» a eso
 * sería inventarse una ventaja que los datos no sostienen.
 */
function ProfileReading({ rows, seriesKey }: { rows: RadarRow[]; seriesKey: string }) {
  const best = extremeAxis(rows, seriesKey, "best");
  const worst = extremeAxis(rows, seriesKey, "worst");

  // Perfil plano: no hay un eje que señalar, pero sí hay algo que decir, y no es
  // lo mismo estar empatado por arriba que por abajo.
  if (best && worst && best.radius === worst.radius) {
    return (
      <>
        {best.radius > 55
          ? "está por encima de la mediana en todos los ejes"
          : best.radius < 45
            ? "está por debajo de la mediana en todos los ejes"
            : "está cerca de la mediana en todos los ejes"}
      </>
    );
  }

  const strong = best && best.radius > 55 ? best.axis : null;
  const weak = worst && worst.radius < 45 ? worst.axis : null;

  if (!strong && !weak) return <>está cerca de la mediana en todos los ejes</>;

  return (
    <>
      {strong ? (
        <>
          destaca en <strong>{strong.toLowerCase()}</strong>
        </>
      ) : null}
      {strong && weak ? " y " : null}
      {weak ? (
        <>
          flojea en <strong>{weak.toLowerCase()}</strong>
        </>
      ) : null}
    </>
  );
}

/**
 * Un eje: rótulo, barra con la mediana marcada en el centro, y el valor crudo.
 *
 * La barra dibuja el **segmento entre la mediana y el valor**, no un relleno
 * desde cero: el radio de `buildRadar` es una posición en una escala, no una
 * nota, y pintarlo como si fuera un porcentaje diría que un 50 es «medio bien»
 * cuando lo que significa es «exactamente la mediana».
 */
function ProfileBar({ row, seriesKey }: { row: RadarRow; seriesKey: string }) {
  const cell = row.cells.find((item) => item.key === seriesKey);
  const radius = cell?.radius ?? RADAR_MID;
  const low = Math.min(RADAR_MID, radius);
  const high = Math.max(RADAR_MID, radius);
  // ±5 puntos es ruido: dentro de esa banda el segmento se pinta neutro para no
  // teñir de verde una diferencia que el propio eje considera insignificante.
  const tone = radius > RADAR_MID + 5 ? "over" : radius < RADAR_MID - 5 ? "under" : "flat";

  return (
    <div className="profile-row">
      <span className="profile-axis">{row.axis}</span>
      <span className="profile-track" aria-hidden="true">
        <span className="profile-mid" />
        <span
          className={`profile-fill ${tone}`}
          style={{ left: `${low}%`, width: `${Math.max(1.5, high - low)}%` }}
        />
      </span>
      <span className="profile-value">
        {cell?.raw ?? "—"}
        <span className="profile-ref">mediana {row.refRaw}</span>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Historial de precios
 * -------------------------------------------------------------------------- */

/**
 * La serie de precios, dibujada a mano en un `<svg>` de treinta líneas.
 *
 * No hace falta una librería de gráficos para una polilínea de seis puntos, y
 * meterla aquí costaría el presupuesto entero del arranque. El dibujo es
 * `aria-hidden` porque debajo va la lista exacta, que es la que se lee: la forma
 * dice «bajó pronto y se quedó quieta», y las cifras dicen cuánto y cuándo.
 */
export function PriceHistory({ points }: { points: OfferPricePoint[] }) {
  if (points.length <= 1) {
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        Un solo precio registrado: todavía no ha cambiado desde que se vio.
      </p>
    );
  }

  const prices = points.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low || 1;
  const W = 300;
  const H = 56;
  const PAD = 6;

  const x = (index: number) => (index / (points.length - 1)) * (W - PAD * 2) + PAD;
  const y = (price: number) => H - PAD - ((price - low) / span) * (H - PAD * 2);
  const line = points.map((point, index) => `${x(index)},${y(point.price)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];

  return (
    <div className="price-chart">
      <svg
        className="price-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`El precio pasó de ${formatPrice(first.price)} el ${formatDate(first.recorded_at)} a ${formatPrice(last.price)} el ${formatDate(last.recorded_at)}`}
      >
        <polyline
          points={line}
          fill="none"
          stroke={last.price <= first.price ? "var(--positive)" : "var(--negative)"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) => (
          <circle
            key={point.recorded_at}
            cx={x(index)}
            cy={y(point.price)}
            r="2.5"
            fill={last.price <= first.price ? "var(--positive)" : "var(--negative)"}
          />
        ))}
      </svg>
      {/* Los dos extremos rotulados: sin ellos la forma no tiene escala y podría
          ser una caída de 200 € o de 6.000. */}
      <div className="price-chart-ends" aria-hidden="true">
        <span>{formatPrice(first.price)}</span>
        <span>{formatPrice(last.price)}</span>
      </div>

      <ol className="price-track">
        {points.map((point, index) => {
          const previous = index > 0 ? points[index - 1].price : null;
          const change = previous === null ? 0 : point.price - previous;
          return (
            <li key={point.recorded_at}>
              <span className="tiny muted">{formatDate(point.recorded_at)}</span>
              <span className="price-track-price">
                {formatPrice(point.price)}
                {change ? (
                  <span
                    className={`price-track-delta ${change < 0 ? "positive" : "negative"}`}
                  >
                    {change < 0 ? "−" : "+"}
                    {formatPrice(Math.abs(change))}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
