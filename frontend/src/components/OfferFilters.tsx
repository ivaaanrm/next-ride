import { useMemo, useState, type ReactNode } from "react";

import { RangeSlider, Sheet, Toggle } from "./ui";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  OFFER_STATUS,
} from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import {
  CAP_HINT,
  clearedView,
  DEFAULT_SORT,
  filterChips,
  filterKey,
  formatYear,
  isFiltered,
  SORT_OPTIONS,
  sortChipLabel,
  viewFilters,
  type ChipNames,
  type OffersView,
} from "../lib/offerParams";
import type {
  CarModelWithStats,
  DealerWithStats,
  Offer,
  OfferAggregateStats,
  OfferStatus,
} from "../types";

/* -------------------------------------------------------------------------- *
 * El riel de chips
 *
 * Lo que sustituye a la fila de seis controles del escritorio. La diferencia no
 * es el tamaño: es que en 390 pt no caben seis controles que enseñen su estado,
 * así que se separa **poner** un filtro de **ver** el que hay puesto. Ver está
 * siempre, en el riel; poner está a un toque, en una hoja.
 *
 * «Limpiar» va al final y no al principio: es lo destructivo, y lo destructivo
 * no puede ser lo primero que encuentra el pulgar que arrastra el riel.
 * -------------------------------------------------------------------------- */

export function FilterRail({
  view,
  names,
  filterCount,
  onOpenFilters,
  onOpenSort,
  onChange,
}: {
  view: OffersView;
  names: ChipNames;
  /** Cuántos filtros hay puestos: va como insignia en el chip «Filtros». */
  filterCount: number;
  onOpenFilters: () => void;
  onOpenSort: () => void;
  onChange: (view: OffersView) => void;
}) {
  const chips = filterChips(view, names);

  return (
    <div className="offer-rail" role="group" aria-label="Filtros y orden de la lista">
      <button
        type="button"
        className={`rail-chip${filterCount > 0 ? " on" : ""}`}
        onClick={onOpenFilters}
      >
        Filtros
        {filterCount > 0 ? <span className="rail-count">{filterCount}</span> : null}
      </button>

      {/* El orden no entra en la hoja de filtros: `clearedView` deliberadamente
          no lo toca, y esconderlo tras un «Aplicar» cobraría cuatro toques por
          un reordenado. Chip propio, hoja propia. */}
      <button
        type="button"
        className={`rail-chip${view.sort !== DEFAULT_SORT ? " on" : ""}`}
        onClick={onOpenSort}
      >
        {sortChipLabel(view.sort)}
      </button>

      {/* Un chip por filtro aplicado. El chip **es** el botón de quitarlo: la ✕
          dice qué hace, pero un botón dentro de otro botón no existe en HTML y
          un objetivo de 44 pt con otro de 44 pt dentro tampoco se puede tocar. */}
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="rail-chip applied"
          aria-label={chip.aria}
          onClick={() => onChange(chip.without)}
        >
          {chip.label}
          <span className="rail-x" aria-hidden="true">
            ✕
          </span>
        </button>
      ))}

      {isFiltered(view) ? (
        <button
          type="button"
          className="rail-chip ghost"
          onClick={() => onChange(clearedView(view))}
        >
          Limpiar
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * La hoja de filtros
 * -------------------------------------------------------------------------- */

export interface RangeDomain {
  floor: number;
  ceiling: number;
  step: number;
}

/**
 * Extremos del deslizador de precio, redondeados a un paso legible.
 *
 * El paso sale del propio recorrido: sobre 60.000 € de rango, moverse de mil en
 * mil basta y deja números redondos; en un rango corto ese mismo paso dejaría el
 * pomo con cuatro posiciones. Los extremos se redondean hacia fuera para que el
 * coche más barato y el más caro sigan cabiendo dentro del carril.
 */
export function priceDomainOf(
  floor: number | null | undefined,
  ceiling: number | null | undefined,
): RangeDomain | null {
  if (floor === null || floor === undefined) return null;
  if (ceiling === null || ceiling === undefined) return null;

  const span = ceiling - floor;
  const step = span > 60000 ? 1000 : span > 20000 ? 500 : 100;
  const low = Math.floor(floor / step) * step;
  // Un catálogo con un solo precio daría un carril de ancho cero: se garantiza
  // al menos un paso para que los dos pomos tengan dónde ponerse.
  return { floor: low, ceiling: Math.max(Math.ceil(ceiling / step) * step, low + step), step };
}

/**
 * Lo mismo para los años, que ya vienen en su propia unidad: el paso es 1 y no
 * hay nada que redondear. Solo se garantiza el año de holgura que necesitan los
 * dos pomos cuando todo el catálogo es del mismo año.
 */
export function yearDomainOf(
  floor: number | null | undefined,
  ceiling: number | null | undefined,
): RangeDomain | null {
  if (floor === null || floor === undefined) return null;
  if (ceiling === null || ceiling === undefined) return null;
  return { floor, ceiling: Math.max(ceiling, floor + 1), step: 1 };
}

/**
 * Filtrar en un móvil.
 *
 * **Dentro de la hoja la lista no se recarga.** Solo el contador, contra
 * `/offers/stats`, que ya acepta el mismo objeto de filtros y ya devuelve
 * `count`. Filtrar en vivo con una hoja abierta es la forma documentada de
 * echar al usuario de la hoja —la lista de debajo se mueve, el conjunto cambia
 * bajo el dedo—, y aquí cada arrastre del deslizador pediría además 50 filas.
 * Aplicar cierra la hoja y dispara la recarga; cancelar no deja rastro.
 *
 * Las cinco cifras agregadas y «Mejor chollo» viven aquí y no encima de la
 * lista: describen el conjunto que se está acotando, que es exactamente lo que
 * se está haciendo en esta pantalla. En la lista, en un móvil, lo que hacían era
 * reemplazarla.
 */
export function FilterSheet({
  view,
  models,
  dealers,
  domains,
  fallbackStats,
  onApply,
  onClose,
  onOpenOffer,
}: {
  view: OffersView;
  models: CarModelWithStats[];
  dealers: DealerWithStats[];
  domains: { price: RangeDomain | null; year: RangeDomain | null };
  /** Las métricas de la lista de detrás, mientras las de la hoja llegan: sin
   *  ellas el bloque «Resumen» aparecería vacío y saltaría al primer dato. */
  fallbackStats: OfferAggregateStats | null;
  onApply: (view: OffersView) => void;
  onClose: () => void;
  onOpenOffer: (offer: Offer) => void;
}) {
  const [pending, setPending] = useState<OffersView>(view);
  const patch = (next: Partial<OffersView>) => setPending((prev) => ({ ...prev, ...next }));

  // El contador se pide con retardo: arrastrar un pomo son treinta cambios de
  // estado, y treinta peticiones de estadísticas por gesto.
  const pendingKey = useDebounced(filterKey(pending), 250);
  const stats = useAsync<OfferAggregateStats>(
    () => api.get("/offers/stats", viewFilters(pending)),
    [pendingKey],
  );

  // Se recuerda el último recuento conocido para que el rótulo del botón no
  // parpadee a «Ver ofertas» en cada petición en vuelo.
  const [lastCount, setLastCount] = useState<number | null>(null);
  const count = stats.data?.count ?? lastCount;
  if (stats.data && stats.data.count !== lastCount) setLastCount(stats.data.count);

  const overview = stats.data ?? fallbackStats;

  return (
    <Sheet
      title="Filtros"
      onClose={onClose}
      action={
        <button
          type="button"
          className="sheet-link"
          onClick={() => setPending(clearedView(pending))}
        >
          Limpiar
        </button>
      }
      footer={
        <button
          type="button"
          className="btn btn-primary sheet-apply"
          onClick={() => onApply(pending)}
        >
          {count === null
            ? "Ver las ofertas"
            : `Ver ${formatNumber(count)} ${count === 1 ? "oferta" : "ofertas"}`}
        </button>
      }
    >
      <div className="sheet-form">
        <section className="sheet-block">
          <h3 className="sheet-label">Resumen</h3>
          <div className="sheet-figures">
            <Figure label="Precio medio" value={formatPrice(overview?.avg_price)} />
            <Figure
              label="Descuento medio"
              value={formatPct(overview?.avg_discount_pct)}
              hint="sobre PVP"
            />
            <Figure label="Km medios" value={formatKm(overview?.avg_mileage_km)} />
            <Figure label="Km / año" value={formatNumber(overview?.avg_km_per_year)} />
            <Figure label="Modelos" value={formatNumber(overview?.car_models)} />
          </div>
          {overview?.best_deal ? (
            <button
              type="button"
              className="sheet-deal"
              onClick={() => onOpenOffer(overview.best_deal as Offer)}
            >
              <span className="figure-label">Mejor chollo</span>
              <span className="sheet-deal-price">{formatPrice(overview.best_deal.price)}</span>
              <span className="sheet-deal-name">
                {overview.best_deal.car_model.display_name}
              </span>
            </button>
          ) : null}
        </section>

        <section className="sheet-block">
          <label className="sheet-label" htmlFor="offer-search">
            Buscar por título
          </label>
          <input
            id="offer-search"
            className="input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder="Buscar por título…"
            value={pending.q}
            onChange={(event) => patch({ q: event.target.value })}
          />
        </section>

        {/* Lista buscable y no un `<select>` nativo: iOS dibuja un `<select>`
            como rueda, y el catálogo está fragmentado por acabado —un Audi A3
            son veintitrés filas—, así que la rueda obligaría a girar a ciegas
            entre versiones que se llaman casi igual. */}
        <ModelPicker
          models={models}
          value={pending.model}
          onChange={(model) => patch({ model })}
        />

        <section className="sheet-block">
          <label className="sheet-label" htmlFor="offer-dealer">
            Dealer
          </label>
          <select
            id="offer-dealer"
            className="select"
            value={pending.dealer}
            onChange={(event) => patch({ dealer: event.target.value })}
          >
            <option value="">Todos los dealers</option>
            {dealers.map((dealer) => (
              <option key={dealer.id} value={dealer.id}>
                {dealer.name}
              </option>
            ))}
          </select>
        </section>

        <section className="sheet-block">
          <label className="sheet-label" htmlFor="offer-condition">
            Estado del vehículo
          </label>
          <select
            id="offer-condition"
            className="select"
            value={pending.condition}
            onChange={(event) => patch({ condition: event.target.value })}
          >
            <option value="">Cualquier estado</option>
            {Object.entries(CONDITION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </section>

        <section className="sheet-block">
          <label className="sheet-label" htmlFor="offer-status">
            Estado en la plataforma
          </label>
          {/* Un desplegable y no tres interruptores: los tres estados son
              excluyentes —una oferta está en uno—, así que dos interruptores
              encendidos a la vez no querrían decir nada. */}
          <select
            id="offer-status"
            className="select"
            value={pending.status}
            onChange={(event) => patch({ status: event.target.value as OfferStatus })}
          >
            {(["active", "dismissed", "expired"] as const).map((value) => (
              <option key={value} value={value}>
                {OFFER_STATUS[value].label}
              </option>
            ))}
          </select>
        </section>

        <RangeBlock
          name="Precio"
          domain={domains.price}
          value={[pending.priceMin, pending.priceMax]}
          format={formatPrice}
          empty="Todavía no hay precios que acotar"
          onChange={([min, max]) => patch({ priceMin: min, priceMax: max })}
        />

        <RangeBlock
          name="Año"
          domain={domains.year}
          value={[pending.yearMin, pending.yearMax]}
          format={formatYear}
          empty="Ninguna oferta trae año"
          onChange={([min, max]) => patch({ yearMin: min, yearMax: max })}
        />

        <section className="sheet-block sheet-scopes">
          <Toggle on={pending.tracked} onChange={(on) => patch({ tracked: on })}>
            Seguidos
          </Toggle>
          <Toggle on={pending.favorites} onChange={(on) => patch({ favorites: on })}>
            {/* La misma estrella que marca la fila: el filtro y la acción que lo
                alimenta se reconocen como lo mismo. */}
            <span className="toggle-mark" aria-hidden="true">
              ★
            </span>
            Favoritos
          </Toggle>
        </section>
      </div>
    </Sheet>
  );
}

/** Campo de texto + lista de opciones de 44 pt. El recuento de ofertas activas
 *  va con cada modelo: es lo que dice si vale la pena elegirlo. */
function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: CarModelWithStats[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? models.filter((model) => model.display_name.toLowerCase().includes(needle))
      : models;
    // Un tope de sesenta filas: la lista es un control dentro de una hoja, no la
    // pantalla, y el campo de búsqueda está justo encima para acortarla.
    return list.slice(0, 60);
  }, [models, query]);

  return (
    <section className="sheet-block">
      <label className="sheet-label" htmlFor="offer-model">
        Modelo
      </label>
      <input
        id="offer-model"
        className="input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Filtrar la lista de modelos…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="sheet-options" role="listbox" aria-label="Modelo">
        <button
          type="button"
          role="option"
          aria-selected={value === ""}
          className={`sheet-option${value === "" ? " on" : ""}`}
          onClick={() => onChange("")}
        >
          <span className="sheet-option-name">Todos los modelos</span>
          <Tick on={value === ""} />
        </button>
        {matches.map((model) => (
          <button
            key={model.id}
            type="button"
            role="option"
            aria-selected={String(model.id) === value}
            className={`sheet-option${String(model.id) === value ? " on" : ""}`}
            onClick={() => onChange(String(model.id))}
          >
            <span className="sheet-option-name">{model.display_name}</span>
            <span className="sheet-option-count">{model.active_offers}</span>
            <Tick on={String(model.id) === value} />
          </button>
        ))}
        {matches.length === 0 ? (
          <p className="sheet-empty">Ningún modelo se llama así.</p>
        ) : null}
      </div>
    </section>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className="sheet-tick" aria-hidden="true">
      {on ? "✓" : ""}
    </span>
  );
}

/** El deslizador que ya existe, a ancho completo. El carril entero agarra y ya
 *  lleva su `touch-action: none` razonado: no se toca. Debajo, las dos casillas
 *  para teclear la cifra exacta, que es más rápido que apuntar. */
function RangeBlock({
  name,
  domain,
  value,
  format,
  empty,
  onChange,
}: {
  name: string;
  domain: RangeDomain | null;
  value: [number | null, number | null];
  format: (value: number | null | undefined) => string;
  empty: string;
  onChange: (value: [number | null, number | null]) => void;
}) {
  const [min, max] = value;

  if (!domain) {
    return (
      <section className="sheet-block">
        <h3 className="sheet-label">{name}</h3>
        <p className="sheet-empty">{empty}</p>
      </section>
    );
  }

  const { floor, ceiling, step } = domain;
  const active = min !== null || max !== null;

  return (
    <section className="sheet-block">
      <h3 className="sheet-label">
        {name}
        <span className="sheet-label-value">
          {active
            ? `${format(min ?? floor)} – ${format(max ?? ceiling)}`
            : `${format(floor)} – ${format(ceiling)}`}
        </span>
      </h3>
      <RangeSlider
        min={floor}
        max={ceiling}
        step={step}
        value={[min ?? floor, max ?? ceiling]}
        onChange={([lo, hi]) =>
          // Un pomo en el extremo del dominio no acota nada: se guarda como «sin
          // límite», que es lo que hace que el chip no aparezca por nada.
          onChange([lo <= floor ? null : lo, hi >= ceiling ? null : hi])
        }
        format={(item) => format(item)}
        labelMin={`${name} mínimo`}
        labelMax={`${name} máximo`}
      />
      <div className="sheet-bounds">
        <input
          className="input"
          type="number"
          inputMode="numeric"
          min={0}
          step={step}
          placeholder={String(floor)}
          aria-label={`${name} mínimo exacto`}
          value={min ?? ""}
          onChange={(event) => onChange([parseBound(event.target.value), max])}
        />
        <span className="range-dash" aria-hidden="true">
          –
        </span>
        <input
          className="input"
          type="number"
          inputMode="numeric"
          min={0}
          step={step}
          placeholder={String(ceiling)}
          aria-label={`${name} máximo exacto`}
          value={max ?? ""}
          onChange={(event) => onChange([min, parseBound(event.target.value)])}
        />
        {active ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange([null, null])}
          >
            Sin límite
          </button>
        ) : null}
      </div>
    </section>
  );
}

function parseBound(raw: string): number | null {
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/* -------------------------------------------------------------------------- *
 * La hoja de orden
 * -------------------------------------------------------------------------- */

/**
 * Lista de selección única, un sentido por fila.
 *
 * El aviso del tope va **escrito y a la vista**, no en un `title`: es lo único
 * que hace fiable el orden por puntuación —se calcula en Python sobre 500 filas
 * coincidentes—, y en un móvil un `title` no existe. Quien ordena un catálogo de
 * tres mil ofertas por puntuación tiene que saber, antes de tocar, que lo que va
 * a ver son las mejores de un subconjunto.
 */
export function SortSheet({
  sort,
  onPick,
  onClose,
}: {
  sort: string;
  onPick: (token: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Ordenar" closeLabel="Cerrar" onClose={onClose}>
      <div className="sheet-options" role="radiogroup" aria-label="Ordenar por">
        {SORT_OPTIONS.map((option) => (
          <button
            key={option.token}
            type="button"
            role="radio"
            aria-checked={option.token === sort}
            className={`sheet-option${option.token === sort ? " on" : ""}`}
            onClick={() => onPick(option.token)}
          >
            <span className="sheet-option-name">{option.label}</span>
            {option.capped ? (
              <span className="sheet-option-count" aria-hidden="true">
                tope
              </span>
            ) : null}
            <Tick on={option.token === sort} />
          </button>
        ))}
      </div>
      <p className="sheet-note">{CAP_HINT}</p>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- *
 * Cifra agregada
 * -------------------------------------------------------------------------- */

/**
 * Etiqueta pequeña sobre un valor tabular.
 *
 * Vive aquí porque aquí es donde las cinco cifras agregadas tienen su casa en un
 * móvil —el bloque «Resumen» de esta hoja—; la barra de métricas del escritorio
 * la importa de vuelta. Es el mismo primitivo: el tamaño lo pone el contenedor,
 * no el componente.
 */
export function Figure({
  label,
  value,
  tone = "",
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className={`figure-value ${tone}`}>{value}</span>
      {hint ? <span className="figure-hint">{hint}</span> : null}
    </div>
  );
}
