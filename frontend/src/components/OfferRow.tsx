import type { ReactNode } from "react";

import { Chip, Score } from "./ui";
import { OfferActions } from "./OfferActions";
import { SwipeRow } from "./SwipeRow";
import {
  FUEL_LABELS,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  VERDICT_LABELS,
} from "../lib/format";
import type { Offer, OfferStatus } from "../types";

/**
 * La fila de oferta en un móvil: tres líneas con gramática de ranuras fija.
 *
 * La tabla de catorce columnas no se «adapta» a 390 pt, se sustituye. Y no con
 * una tabla desmontada por CSS —`display: block` sobre un `<table>` le quita la
 * semántica sin avisar a nadie— sino con una lista de verdad, que es lo que esto
 * es: un registro por fila.
 *
 * La gramática no cambia nunca de fila a fila, que es lo único que hace legible
 * un barrido vertical rápido. Son dos columnas —quién es a la izquierda, cuánto
 * vale a la derecha— repartidas en tres líneas:
 *
 *   1. **Identidad y precio** — `{marca} {modelo}` con cuerpo y peso a la
 *      izquierda; a la derecha la cifra por la que existe el producto, a 18 px,
 *      con `tabular-nums` y alineada al mismo borde en todas las filas, que es lo
 *      que la hace columna de verdad.
 *   2. **Versión y juicio** — la versión en gris y recortada a la izquierda;
 *      debajo del precio, lo que lo califica: la desviación contra la mediana en
 *      pantalla, la puntuación de valor y el puesto de la IA **si lo hay**.
 *   3. **La evidencia** — año, kilómetros, uso, combustible y sitio. Una línea,
 *      recortada, en el gris de tercer nivel.
 *
 * Es la misma gramática de `.record-head` —la cifra que decide, arriba a la
 * derecha— que ya usan Modelos, Dealers y API keys. Antes no: el precio vivía en
 * mitad de la segunda línea y la versión se comía la primera, así que la única
 * pantalla que se barre a diario era la única que no se leía como las demás.
 *
 * El combustible va con su palabra entera («Diésel»), no con la inicial: la
 * letra funcionaba en la tabla porque el `title` la explicaba, y en táctil no
 * hay `title` que consultar.
 *
 * La estrella ocupa su propia columna de 44 px a todo el alto. Es el único
 * control que compite con el toque de la fila, y por eso se separa físicamente
 * en vez de fiarlo a `stopPropagation` —que también está, porque los dedos
 * gordos existen.
 */
export function OfferRow({
  offer,
  median,
  leaving = false,
  favBusy = false,
  peek = false,
  onOpen,
  onFavorite,
  onMove,
  onPeekEnd,
  onSwipeOpen,
}: {
  offer: Offer;
  /** Mediana de los precios en pantalla, contra la que se mide la desviación. */
  median: number | null;
  /** Se está yendo de la lista: no responde a nada mientras se desvanece. */
  leaving?: boolean;
  favBusy?: boolean;
  peek?: boolean;
  onOpen: (offer: Offer) => void;
  onFavorite: (offer: Offer) => void;
  onMove: (offer: Offer, target: OfferStatus) => void;
  onPeekEnd?: () => void;
  onSwipeOpen?: () => void;
}) {
  return (
    <li className={`offer-item${leaving ? " offer-leaving" : ""}`}>
      <SwipeRow
        label={`Acciones de ${offer.title}`}
        peek={peek}
        onPeekEnd={onPeekEnd}
        onOpen={onSwipeOpen}
        actions={<OfferActions offer={offer} busy={leaving} variant="swipe" onMove={onMove} />}
      >
        <div className="offer-row">
          <button
            type="button"
            className="offer-open"
            disabled={leaving}
            onClick={() => onOpen(offer)}
          >
            <span className="offer-line offer-head">
              <span className="offer-name">
                {offer.car_model.make} {offer.car_model.model}
              </span>
              <span className="offer-price">{formatPrice(offer.price)}</span>
            </span>

            <span className="offer-line offer-qualifiers">
              {offer.car_model.trim ? (
                <span className="offer-trim">{offer.car_model.trim}</span>
              ) : null}
              {/* El grupo va pegado al borde derecho, así que lo último que
                  lleve es lo que cae siempre en la misma x. Ahí va la puntuación
                  —la señal de la casa, y la que se lee como columna al barrer—, y
                  el puesto de la IA se pone delante, que además es el orden que
                  ya tienen las columnas en la tabla del escritorio. Al revés, una
                  fila rankeada empujaba la puntuación y la columna se rompía cada
                  pocas filas. */}
              <span className="offer-marks">
                {/* Solo si la IA ha rankeado esta oferta: una insignia vacía en
                    cada fila enseñaría el hueco y no el dato. */}
                {offer.ai ? (
                  /* La explicación va en texto y no en `aria-label`: el nombre de
                     la fila lo componen sus contenidos, y ARIA no permite nombrar
                     un `span` sin rol. Sin esto la fila se leía «24.590 € −8,2 %
                     72 3», cuatro cifras seguidas sin una sola palabra que dijera
                     de qué son —o «723», si el lector no mete separación entre dos
                     cajas flex contiguas. */
                  <span className={`rank-badge${offer.ai.rank <= 3 ? " top" : ""}`}>
                    {offer.ai.rank}
                    <span className="sr-only">
                      {` de puesto para la IA, ${VERDICT_LABELS[offer.ai.verdict]}`}
                    </span>
                  </span>
                ) : null}
                <VsMedian price={offer.price} median={median} />
                <Score value={offer.metrics.value_score} bar={false} />
              </span>
            </span>

            <span className="offer-line offer-evidence-line">{evidenceOf(offer)}</span>
          </button>

          <button
            type="button"
            className={`star offer-star${offer.is_favorite ? " on" : ""}`}
            disabled={favBusy || leaving}
            aria-pressed={offer.is_favorite}
            aria-label={offer.is_favorite ? "Quitar de favoritos" : "Marcar como favorito"}
            onClick={(event) => {
              // La columna de al lado abre el detalle: el toque no propaga.
              event.stopPropagation();
              onFavorite(offer);
            }}
          >
            {offer.is_favorite ? "★" : "☆"}
          </button>
        </div>
      </SwipeRow>
    </li>
  );
}

/** La tercera línea, ya escrita. Lo que no hay no deja hueco ni pone «—»: en una
 *  línea de contexto un guion suelto ocupa lo mismo que un dato y no dice nada. */
function evidenceOf(offer: Offer): string {
  return [
    offer.year !== null ? String(offer.year) : null,
    offer.mileage_km !== null ? formatKm(offer.mileage_km) : null,
    offer.metrics.km_per_year ? `${formatNumber(offer.metrics.km_per_year)} km/año` : null,
    offer.fuel_type ? FUEL_LABELS[offer.fuel_type] : null,
    locationOf(offer),
  ]
    .filter((part): part is string => part !== null && part !== "—")
    .join(" · ");
}

/** Ubicación del coche, con la ciudad del dealer como respaldo. */
export function locationOf(offer: Offer): string {
  return offer.location || offer.dealer.city || "—";
}

/**
 * Desviación de un precio respecto a la mediana de las filas mostradas.
 *
 * Es deliberadamente distinta de `metrics.price_vs_median_pct`, que compara
 * contra la mediana de **todas** las ofertas activas del mismo modelo. Esta es
 * local a la vista: responde «de lo que estoy mirando, ¿cuál sale barato?», y
 * por eso se mueve al filtrar. La referencia se escribe en la línea de contexto
 * de la lista, porque un porcentaje colgando de una referencia invisible no se
 * puede interpretar.
 */
export function VsMedian({
  price,
  median,
  fallback = null,
}: {
  price: number;
  median: number | null;
  /** Qué poner cuando no hay mediana. En la tabla es un guion, que mantiene la
   *  celda ocupada; en la fila móvil no es nada, porque una ranura vacía en una
   *  línea que se lee de corrido es ruido. */
  fallback?: ReactNode;
}) {
  if (median === null) return <>{fallback}</>;
  const pct = ((price - median) / median) * 100;
  return (
    <Chip tone={pct <= -5 ? "positive" : pct >= 5 ? "negative" : "neutral"}>
      {formatPct(pct, true)}
      {/* El porcentaje no tenía referente en el nombre de la fila: la mediana se
          anuncia en otra línea, y suelto se leía como un descuento del anuncio. */}
      <span className="sr-only"> respecto a la mediana en pantalla</span>
    </Chip>
  );
}
