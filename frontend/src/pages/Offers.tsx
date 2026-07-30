import { useEffect, useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "../components/Layout";
import {
  Banner,
  Chip,
  Drawer,
  Empty,
  Loading,
  Popover,
  RangeSlider,
  Score,
  Toggle,
} from "../components/ui";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  FUEL_LABELS,
  formatDate,
  formatDateTime,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  TRANSMISSION_LABELS,
  VERDICT_LABELS,
  verdictTone,
} from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import type {
  CarModelWithStats,
  DealerWithStats,
  Offer,
  OfferAggregateStats,
  OfferPricePoint,
  OfferRaw,
  Page,
} from "../types";

const PAGE_SIZE = 50;

type SortDir = "asc" | "desc";

interface SortColumn {
  /** Token de la API para cada sentido. `null` es un sentido que no se sirve. */
  asc: string | null;
  desc: string | null;
  /** Sentido del primer clic: de los dos, el que se pide de verdad. */
  first: SortDir;
  /** La dimensión, en palabras, para el tooltip. No sale del rótulo porque el
   *  rótulo va apretado a la columna y en prosa no funciona: «ordenar por ia». */
  what: string;
  /** Se ordena en Python sobre un tope de filas, y hay que decirlo. */
  capped?: boolean;
}

/**
 * Qué ordena cada columna de la tabla.
 *
 * Los sentidos se nombran por lo que se ve en la columna y no por el token que
 * viaja: «IA» enseña el puesto, así que su orden ascendente —1, 2, 3…— es el
 * token `ai_score`, que en el backend es puntuación descendente. Un `aria-sort`
 * que anunciara «descendente» sobre una lista que empieza en 1 estaría mintiendo
 * al único usuario que no puede comprobarlo de un vistazo.
 *
 * Las dos puntuaciones no tienen sentido inverso porque nadie lo pide, no porque
 * falte implementarlo: son las que se calculan en Python sobre un conjunto
 * acotado, y su cabecera lleva el aviso del tope.
 */
const SORT_COLUMNS = {
  ai: {
    asc: "ai_score",
    desc: null,
    first: "asc",
    what: "puesto que le da la IA",
    capped: true,
  },
  price: { asc: "price", desc: "-price", first: "asc", what: "precio" },
  year: { asc: "year", desc: "-year", first: "desc", what: "año" },
  km: { asc: "mileage_km", desc: "-mileage_km", first: "asc", what: "kilómetros" },
  value: {
    asc: null,
    desc: "value_score",
    first: "desc",
    what: "puntuación de valor",
    capped: true,
  },
} satisfies Record<string, SortColumn>;

type SortColumnId = keyof typeof SORT_COLUMNS;

/** El orden por defecto de la vista: los mejores chollos primero. */
const DEFAULT_SORT = SORT_COLUMNS.value.desc;

const CAP_HINT =
  "Ordenar por puntuación evalúa hasta 500 ofertas coincidentes; para catálogos más grandes, filtra por modelo o dealer.";

/** En qué sentido está ordenada esta columna, o `null` si no es la ordenada. */
function activeDir(column: SortColumn, sort: string): SortDir | null {
  if (column.asc !== null && column.asc === sort) return "asc";
  if (column.desc !== null && column.desc === sort) return "desc";
  return null;
}

/**
 * Sentido que aplicaría el siguiente clic.
 *
 * Sin orden puesto arranca por el útil; con orden puesto se da la vuelta. Si el
 * inverso no se sirve, se queda en el que ya hay: un clic inerte es mejor que
 * uno que devuelve la tabla al orden por defecto sin haberlo pedido.
 */
function nextDir(column: SortColumn, current: SortDir | null): SortDir {
  const wanted: SortDir =
    current === null ? column.first : current === "asc" ? "desc" : "asc";
  return column[wanted] === null ? (current ?? column.first) : wanted;
}

/**
 * Cabecera que ordena.
 *
 * El `<button>` de dentro no es ceremonia: un `onClick` sobre el `<th>` no se
 * alcanza con el tabulador ni se anuncia como accionable. El `aria-sort` sí va
 * en el `<th>`, que es donde lo lee el lector de pantalla al recorrer la tabla.
 */
function SortTh({
  column,
  label,
  sort,
  onSort,
  numeric = false,
  width,
}: {
  column: SortColumnId;
  label: string;
  sort: string;
  onSort: (token: string) => void;
  numeric?: boolean;
  width?: number;
}) {
  const spec: SortColumn = SORT_COLUMNS[column];
  const current = activeDir(spec, sort);
  const next = nextDir(spec, current);
  const token = spec[next];
  // Único sentido disponible y ya puesto: no hay nada que aplicar.
  const inert = token === null || token === sort;

  // El tope se dice aquí, antes de pulsar, y no solo debajo de la tabla cuando
  // ya se ha ordenado: es lo que hay que saber para decidir si merece la pena.
  const title = inert
    ? `Ordenado por ${spec.what}${spec.capped ? `. ${CAP_HINT}` : ""}`
    : `Ordenar por ${spec.what}${spec.capped ? `. ${CAP_HINT}` : ""}`;

  return (
    <th
      className={`sort-th${numeric ? " num" : ""}${current ? " on" : ""}`}
      aria-sort={current === "asc" ? "ascending" : current === "desc" ? "descending" : "none"}
      style={width ? { width } : undefined}
    >
      <button
        type="button"
        aria-disabled={inert || undefined}
        title={title}
        onClick={() => {
          if (!inert && token !== null) onSort(token);
        }}
      >
        {label}
        {/* El carrete enseña el sentido puesto cuando la columna es la ordenada
            y el que daría el clic cuando no lo es. Ocupa su sitio siempre: si
            apareciera al ordenar, el rótulo se movería justo bajo el puntero
            que acaba de pulsarlo. */}
        <span className="sort-caret" aria-hidden="true">
          {(current ?? next) === "asc" ? "▴" : "▾"}
        </span>
      </button>
    </th>
  );
}

/**
 * Mediana de los precios que hay en pantalla.
 *
 * Es deliberadamente distinta de `metrics.price_vs_median_pct`, que compara
 * contra la mediana de **todas** las ofertas activas del mismo modelo y es la
 * que alimenta `value_score` y al agente de IA. Esta es local a la vista:
 * responde «de lo que estoy mirando, ¿cuál sale barato?», y por eso se mueve al
 * filtrar y al pasar de página. La cabecera de la columna enseña el valor para
 * que el porcentaje no quede colgando de una referencia invisible.
 *
 * Con una sola fila la mediana es su propio precio y saldría un 0,0 % que
 * parece «justo en mercado» sin serlo: por debajo de dos filas, no hay dato.
 */
function medianPrice(offers: Offer[]): number | null {
  if (offers.length < 2) return null;
  const sorted = offers.map((offer) => offer.price).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Desviación de un precio respecto a la mediana de las filas mostradas. */
function VsMedian({ price, median }: { price: number; median: number | null }) {
  if (median === null) return <span className="muted">—</span>;
  const pct = ((price - median) / median) * 100;
  return (
    <Chip tone={pct <= -5 ? "positive" : pct >= 5 ? "negative" : "neutral"}>
      {formatPct(pct, true)}
    </Chip>
  );
}

export function OffersPage() {
  const [search, setSearch] = useState("");
  const [modelId, setModelId] = useState("");
  const [dealerId, setDealerId] = useState("");
  const [condition, setCondition] = useState("");
  // `null` es «sin límite», no cero: un mínimo de 0 € filtraría igual que no
  // filtrar pero dejaría el control marcado como activo.
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [yearMin, setYearMin] = useState<number | null>(null);
  const [yearMax, setYearMax] = useState<number | null>(null);
  const [domains, setDomains] = useState<{
    price: RangeDomain | null;
    year: RangeDomain | null;
  }>({ price: null, year: null });
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [page, setPage] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [favBusyId, setFavBusyId] = useState<number | null>(null);
  const [scraped, setScraped] = useState<Offer | null>(null);

  // Dos escalares y no un par: `useDebounced` compara por identidad, así que un
  // `[min, max]` recreado en cada render reiniciaría el temporizador sin fin.
  const debouncedSearch = useDebounced(search);
  const debouncedPriceMin = useDebounced(priceMin);
  const debouncedPriceMax = useDebounced(priceMax);
  const debouncedYearMin = useDebounced(yearMin);
  const debouncedYearMax = useDebounced(yearMax);

  const models = useAsync<CarModelWithStats[]>(() => api.get("/car-models"), []);
  const dealers = useAsync<DealerWithStats[]>(() => api.get("/dealers"), []);

  // Un único objeto de filtros para la tabla y para sus métricas: si cada
  // llamada armara los suyos, las medias acabarían describiendo otro conjunto.
  const filters = {
    q: debouncedSearch || undefined,
    car_model_id: modelId || undefined,
    dealer_id: dealerId || undefined,
    condition: condition || undefined,
    min_price: debouncedPriceMin ?? undefined,
    max_price: debouncedPriceMax ?? undefined,
    min_year: debouncedYearMin ?? undefined,
    max_year: debouncedYearMax ?? undefined,
    tracked_only: trackedOnly || undefined,
    favorites_only: favoritesOnly || undefined,
    status: showDismissed ? "dismissed" : undefined,
  };
  const filterDeps = [
    debouncedSearch,
    modelId,
    dealerId,
    condition,
    debouncedPriceMin,
    debouncedPriceMax,
    debouncedYearMin,
    debouncedYearMax,
    trackedOnly,
    favoritesOnly,
    showDismissed,
  ];

  const stats = useAsync<OfferAggregateStats>(
    () => api.get("/offers/stats", filters),
    filterDeps,
  );

  const offers = useAsync<Page<Offer>>(
    () =>
      api.get("/offers", {
        ...filters,
        sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [...filterDeps, sort, page],
  );

  function resetPageAnd<T>(setter: (value: T) => void) {
    return (value: T) => {
      setPage(0);
      setter(value);
    };
  }

  /** Reordenar vuelve a la primera página: la fila 51 del orden anterior no es
   *  la fila 51 del nuevo, y quedarse en la página 2 esconde lo que se buscaba. */
  const sortBy = resetPageAnd(setSort);

  // Los dominios de los deslizadores se guardan en vez de leerse directos de
  // `stats` porque `stats` puede devolverlos vacíos: un filtro de modelo y
  // dealer sin intersección deja el conjunto a cero y con él los extremos. Sin
  // memoria, el carril desaparecería justo cuando hace falta para deshacer el
  // filtro. Las dependencias son escalares a propósito: con el objeto entero, el
  // efecto se relanzaría en cada render.
  useEffect(() => {
    setDomains((previous) => ({
      price:
        priceDomainOf(stats.data?.price_floor, stats.data?.price_ceiling) ?? previous.price,
      year: yearDomainOf(stats.data?.year_floor, stats.data?.year_ceiling) ?? previous.year,
    }));
  }, [
    stats.data?.price_floor,
    stats.data?.price_ceiling,
    stats.data?.year_floor,
    stats.data?.year_ceiling,
  ]);

  const filtered =
    Boolean(search || modelId || dealerId || condition) ||
    priceMin !== null ||
    priceMax !== null ||
    yearMin !== null ||
    yearMax !== null ||
    trackedOnly ||
    favoritesOnly ||
    showDismissed;

  /** Devuelve la vista a su estado por defecto. El orden no es un filtro y se queda. */
  function clearFilters() {
    setPage(0);
    setSearch("");
    setModelId("");
    setDealerId("");
    setCondition("");
    setPriceMin(null);
    setPriceMax(null);
    setYearMin(null);
    setYearMax(null);
    setTrackedOnly(false);
    setFavoritesOnly(false);
    setShowDismissed(false);
  }

  /** Marca o desmarca un favorito y parchea la fila en sitio: no recarga la tabla
   *  para no perder la posición ni el orden mientras se marcan varias. */
  async function toggleFavorite(offer: Offer) {
    setActionError(null);
    setFavBusyId(offer.id);
    try {
      const updated = offer.is_favorite
        ? await api.delete<Offer>(`/offers/${offer.id}/favorite`)
        : await api.post<Offer>(`/offers/${offer.id}/favorite`);

      const current = offers.data;
      if (current) {
        // Si estamos viendo solo favoritos, al desmarcar la fila desaparece.
        const drop = favoritesOnly && !updated.is_favorite;
        offers.setData({
          ...current,
          items: drop
            ? current.items.filter((item) => item.id !== updated.id)
            : current.items.map((item) => (item.id === updated.id ? updated : item)),
          total: drop ? Math.max(0, current.total - 1) : current.total,
        });
      }

      // Viendo solo favoritos, desmarcar cambia el conjunto: las medias de
      // arriba dejan de ser las de la tabla hasta que se recalculan.
      if (favoritesOnly) stats.reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "No se pudo actualizar el favorito",
      );
    } finally {
      setFavBusyId(null);
    }
  }

  async function dismiss(offer: Offer) {
    if (!confirm(`¿Descartar "${offer.title}" de la lista?`)) return;
    setActionError(null);
    try {
      await api.delete(`/offers/${offer.id}`);
      offers.reload();
      stats.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo descartar");
    }
  }

  async function restore(offer: Offer) {
    setActionError(null);
    try {
      await api.post(`/offers/${offer.id}/restore`);
      offers.reload();
      stats.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo restaurar");
    }
  }

  const total = offers.data?.total ?? 0;
  const items = offers.data?.items ?? [];
  const overview = stats.data;

  const shownMedian = useMemo(() => medianPrice(offers.data?.items ?? []), [offers.data]);

  return (
    <>
      <PageHeader
        title="Ofertas"
        meta={total ? `${formatNumber(total)} resultados` : undefined}
        actions={
          <button className="btn btn-sm" onClick={() => offers.reload()}>
            Actualizar
          </button>
        }
      />

      <div className="content">
        {/* El aviso de «ranking con IA desactivado» ya no vive aquí: es estado del
            sistema, no de esta tabla, y como banner empujaba las métricas y la
            tabla hacia abajo en cada carga. Ahora está en la campana de la barra
            lateral, que se ve desde cualquier página. */}

        {/* Métricas del conjunto filtrado. Sin tarjetas: son contexto de la
            tabla, no cinco objetos distintos que comparar entre sí. */}
        <section className="stat-bar" aria-label="Métricas de las ofertas filtradas">
          <div className="stat-figures">
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
              className="stat-deal"
              onClick={() => setScraped(overview.best_deal)}
              title={`Ver el detalle de ${overview.best_deal.title}`}
            >
              {/* Sin puntuación al lado del precio: dos números del mismo
                  tamaño compiten en vez de jerarquizar. La puntuación está a
                  un clic, arriba del todo del panel de detalle. */}
              <span className="figure-label">Mejor chollo</span>
              <span className="stat-deal-price">
                {formatPrice(overview.best_deal.price)}
              </span>
              <span className="stat-deal-name">
                {overview.best_deal.car_model.display_name}
              </span>
            </button>
          ) : null}
        </section>

        {/* Una sola fila de 28 px. Antes eran seis pares etiqueta/control en dos
            filas para decir lo que los propios controles ya dicen: sobre un
            desplegable cuya primera opción es «Todos los modelos» no hace falta
            escribir «Modelo». Las etiquetas siguen ahí en `aria-label`, solo que
            ya no ocupan alto, y ese alto se lo queda la tabla. */}
        <div className="filters">
          <div className="filter-search">
            <input
              className="input"
              aria-label="Buscar por título"
              placeholder="Buscar por título…"
              value={search}
              onChange={(event) => resetPageAnd(setSearch)(event.target.value)}
            />
          </div>

          <select
            className="select"
            aria-label="Filtrar por modelo"
            value={modelId}
            onChange={(event) => resetPageAnd(setModelId)(event.target.value)}
          >
            <option value="">Todos los modelos</option>
            {(models.data ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.display_name} ({model.active_offers})
              </option>
            ))}
          </select>

          <select
            className="select"
            aria-label="Filtrar por dealer"
            value={dealerId}
            onChange={(event) => resetPageAnd(setDealerId)(event.target.value)}
          >
            <option value="">Todos los dealers</option>
            {(dealers.data ?? []).map((dealer) => (
              <option key={dealer.id} value={dealer.id}>
                {dealer.name}
              </option>
            ))}
          </select>

          <select
            className="select"
            aria-label="Filtrar por estado del vehículo"
            value={condition}
            onChange={(event) => resetPageAnd(setCondition)(event.target.value)}
          >
            <option value="">Cualquier estado</option>
            {Object.entries(CONDITION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <RangeFilter
            name="Precio"
            domain={domains.price}
            value={[priceMin, priceMax]}
            format={formatPrice}
            formatShort={formatNumber}
            emptyTitle="Todavía no hay precios que acotar"
            onChange={([min, max]) => {
              setPage(0);
              setPriceMin(min);
              setPriceMax(max);
            }}
          />

          <RangeFilter
            name="Año"
            domain={domains.year}
            value={[yearMin, yearMax]}
            format={formatYear}
            emptyTitle="Ninguna oferta trae año"
            onChange={([min, max]) => {
              setPage(0);
              setYearMin(min);
              setYearMax(max);
            }}
          />

          <div className="filter-scopes">
            <Toggle
              on={trackedOnly}
              onChange={resetPageAnd(setTrackedOnly)}
              title="Solo modelos que sigues"
            >
              Seguidos
            </Toggle>
            <Toggle
              on={favoritesOnly}
              onChange={resetPageAnd(setFavoritesOnly)}
              title="Solo tus favoritos"
            >
              {/* La misma estrella que marca la fila: el filtro y la acción que
                  lo alimenta se reconocen como lo mismo. */}
              <span className="toggle-mark" aria-hidden="true">
                ★
              </span>
              Favoritos
            </Toggle>
            <Toggle
              on={showDismissed}
              onChange={resetPageAnd(setShowDismissed)}
              title="Ver las ofertas descartadas en lugar de las activas"
            >
              Descartadas
            </Toggle>
          </div>

          {/* Sin etiquetas visibles, un control con un valor puesto es lo único
              que delata que la tabla está acotada: hace falta la salida. */}
          {filtered ? (
            <button className="btn btn-ghost" onClick={clearFilters}>
              Limpiar
            </button>
          ) : null}

          {/* El orden ya no está aquí. Era el único control de la fila que no
              filtraba, y con él la barra pedía ~1.413 px: en un portátil de
              1.512 px, descontada la barra lateral, se partía en dos filas
              siempre. Ahora vive en las cabeceras de la tabla, que es donde se
              busca en una tabla de datos, y son ~190 px que la fila devuelve. */}
        </div>

        {actionError ? <Banner kind="error">{actionError}</Banner> : null}
        {offers.error ? <Banner kind="error">{offers.error}</Banner> : null}

        <div className="table-wrap">
          {offers.loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty
              title="No hay ofertas que cumplan el filtro"
              hint={
                favoritesOnly
                  ? "Marca ofertas con la estrella para que aparezcan aquí."
                  : "El servicio scraper alimenta esta tabla vía POST /api/v1/offers/bulk."
              }
            />
          ) : (
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <span className="sr-only">Favorito</span>
                  </th>
                  <SortTh column="ai" label="IA" sort={sort} onSort={sortBy} width={56} />
                  <th>Marca</th>
                  <th>Modelo</th>
                  <th>Versión</th>
                  <th>Ubicación</th>
                  <SortTh column="price" label="Precio" sort={sort} onSort={sortBy} numeric />
                  {/* No ordena: la desviación se calcula contra la mediana de las
                      filas en pantalla, así que ordenar por ella reordenaría su
                      propia referencia. La referencia va en la cabecera porque
                      cambia con lo que se esté mirando y el % necesita decir
                      «respecto a qué». */}
                  <th className="num">
                    vs mediana
                    {shownMedian !== null ? (
                      <span className="th-note">{formatPrice(shownMedian)}</span>
                    ) : null}
                  </th>
                  <SortTh column="year" label="Año" sort={sort} onSort={sortBy} numeric />
                  <SortTh column="km" label="Km" sort={sort} onSort={sortBy} numeric />
                  {/* Tampoco ordena: es una métrica derivada que el backend no
                      tiene en columna, y ordenar solo la página visible daría un
                      orden que se deshace al pasar a la siguiente. */}
                  <th className="num">Km / año</th>
                  <th>Combustible</th>
                  <SortTh column="value" label="Valor" sort={sort} onSort={sortBy} numeric />
                  <th style={{ width: 44 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((offer) => (
                  <tr
                    key={offer.id}
                    className="row-clickable"
                    tabIndex={0}
                    aria-label={`Ver el detalle de ${offer.title}`}
                    onClick={() => setScraped(offer)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setScraped(offer);
                      }
                    }}
                  >
                    <td>
                      <button
                        className={`star${offer.is_favorite ? " on" : ""}`}
                        disabled={favBusyId === offer.id}
                        aria-pressed={offer.is_favorite}
                        aria-label={
                          offer.is_favorite ? "Quitar de favoritos" : "Marcar como favorito"
                        }
                        title={offer.is_favorite ? "Quitar de favoritos" : "Marcar como favorito"}
                        onClick={(event) => {
                          // La fila entera abre el detalle: los controles no deben propagar.
                          event.stopPropagation();
                          toggleFavorite(offer);
                        }}
                      >
                        {offer.is_favorite ? "★" : "☆"}
                      </button>
                    </td>

                    <td>
                      {offer.ai ? (
                        <span
                          className={`rank-badge${offer.ai.rank <= 3 ? " top" : ""}`}
                          title={`${VERDICT_LABELS[offer.ai.verdict]} · ${offer.ai.score}/100${
                            offer.ai.reasoning ? `\n\n${offer.ai.reasoning}` : ""
                          }`}
                        >
                          {offer.ai.rank}
                        </span>
                      ) : (
                        <span className="muted tiny">—</span>
                      )}
                    </td>

                    <td className="cell-muted">{offer.car_model.make}</td>

                    <td className="cell-primary cell-clip" title={offer.car_model.model}>
                      {offer.car_model.model}
                    </td>

                    <td className="cell-muted">{offer.car_model.trim || "—"}</td>

                    {/* El scraper no siempre manda `location`; la ciudad del
                        dealer es la mejor aproximación cuando falta. */}
                    <td className="cell-muted cell-clip-sm" title={locationOf(offer)}>
                      {locationOf(offer)}
                    </td>

                    <td className="num" style={{ fontWeight: 500 }}>
                      {formatPrice(offer.price)}
                    </td>

                    <td className="num">
                      <VsMedian price={offer.price} median={shownMedian} />
                    </td>

                    <td className="num cell-muted">{offer.year ?? "—"}</td>
                    <td className="num cell-muted">{formatKm(offer.mileage_km)}</td>

                    <td className="num cell-muted">
                      {offer.metrics.km_per_year
                        ? formatNumber(offer.metrics.km_per_year)
                        : "—"}
                    </td>

                    <td className="cell-muted">
                      {offer.fuel_type ? FUEL_LABELS[offer.fuel_type] : "—"}
                    </td>

                    <td className="num">
                      <Score value={offer.metrics.value_score} />
                    </td>

                    <td>
                      <div className="row-actions">
                        {offer.status === "dismissed" ? (
                          <button
                            className="icon-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              restore(offer);
                            }}
                            title="Restaurar en la lista"
                            aria-label="Restaurar en la lista"
                          >
                            ↺
                          </button>
                        ) : (
                          <button
                            className="icon-btn danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              dismiss(offer);
                            }}
                            title="Descartar de la lista"
                            aria-label="Descartar de la lista"
                          >
                            ▤
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {total > PAGE_SIZE ? (
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <span className="tiny muted">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} de{" "}
              {formatNumber(total)}
            </span>
            <button
              className="btn btn-sm"
              disabled={page === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              Anterior
            </button>
            <button
              className="btn btn-sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              Siguiente
            </button>
          </div>
        ) : null}

        {/* El tope de las ordenaciones por puntuación se dice dos veces y en dos
            momentos distintos: en el `title` de las cabeceras «IA» y «Valor»,
            que se lee antes de pulsarlas, y aquí abajo mientras una de las dos
            está puesta, porque es lo que acota el recuento que hay justo encima. */}
        {SORT_COLUMNS.ai.asc === sort || SORT_COLUMNS.value.desc === sort ? (
          <p className="tiny muted" style={{ marginTop: 10 }}>
            {CAP_HINT}
          </p>
        ) : null}
      </div>

      {scraped ? <ScrapedDrawer offer={scraped} onClose={() => setScraped(null)} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */

interface RangeDomain {
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
function priceDomainOf(
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
function yearDomainOf(
  floor: number | null | undefined,
  ceiling: number | null | undefined,
): RangeDomain | null {
  if (floor === null || floor === undefined) return null;
  if (ceiling === null || ceiling === undefined) return null;
  return { floor, ceiling: Math.max(ceiling, floor + 1), step: 1 };
}

/** Los años se escriben enteros: «2.018» sería un precio, no un año. */
const formatYear = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : String(value);

/**
 * Acotación por rango: dos pomos sobre el recorrido real del conjunto, más dos
 * casillas para teclear la cifra exacta, que es más rápido que apuntar.
 *
 * Vive en un panel plegable y no suelto en la barra porque un deslizador
 * utilizable necesita unos 240 px y una fila de filtros no puede pagarlos por un
 * control que se toca una vez por sesión. Plegado ocupa lo que un botón y enseña
 * el rango puesto, así que no hace falta abrirlo para saber qué hay acotado.
 */
function RangeFilter({
  name,
  domain,
  value,
  onChange,
  format,
  /** Para el extremo izquierdo de un rango cerrado: «12.000 – 30.000 €» dice lo
   *  mismo que repetir el símbolo y ocupa la mitad, y la fila va justa. */
  formatShort = format,
  emptyTitle,
}: {
  name: string;
  domain: RangeDomain | null;
  value: [number | null, number | null];
  onChange: (value: [number | null, number | null]) => void;
  format: (value: number | null | undefined) => string;
  formatShort?: (value: number | null | undefined) => string;
  emptyTitle: string;
}) {
  const [min, max] = value;
  const active = min !== null || max !== null;

  const label =
    min === null && max === null
      ? name
      : min === null
        ? `hasta ${format(max)}`
        : max === null
          ? `desde ${format(min)}`
          : `${formatShort(min)} – ${format(max)}`;

  // Deshabilitado y no ausente: un control que aparece cuando cargan los datos
  // desplaza toda la fila justo cuando se va a pulsar algo.
  if (!domain) {
    return <Popover disabled label={name} title={emptyTitle} />;
  }

  const { floor, ceiling, step } = domain;

  /** Un pomo en el extremo del dominio no acota nada: se guarda como «sin límite». */
  function commit([lo, hi]: [number, number]) {
    onChange([lo <= floor ? null : lo, hi >= ceiling ? null : hi]);
  }

  /** Teclear un extremo por encima del otro lo empuja, en vez de dar cero filas. */
  function typed(raw: string, side: "lo" | "hi") {
    if (raw === "") {
      onChange(side === "lo" ? [null, max] : [min, null]);
      return;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    onChange(
      side === "lo"
        ? [parsed, max !== null && parsed > max ? parsed : max]
        : [min !== null && parsed < min ? parsed : min, parsed],
    );
  }

  return (
    <Popover label={label} active={active} title={`Acotar por ${name.toLowerCase()}`}>
      <div className="range-panel">
        <RangeSlider
          min={floor}
          max={ceiling}
          step={step}
          value={[min ?? floor, max ?? ceiling]}
          onChange={commit}
          format={format}
          labelMin={`${name} mínimo`}
          labelMax={`${name} máximo`}
        />

        {/* Los extremos del dominio hacen de escala: sin ellos el carril no dice
            sobre qué recorrido se está moviendo el pomo. */}
        <div className="range-scale" aria-hidden="true">
          <span>{format(floor)}</span>
          <span>{format(ceiling)}</span>
        </div>

        <div className="range-bounds">
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={0}
            step={step}
            placeholder={String(floor)}
            aria-label={`${name} mínimo exacto`}
            value={min ?? ""}
            onChange={(event) => typed(event.target.value, "lo")}
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
            onChange={(event) => typed(event.target.value, "hi")}
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
      </div>
    </Popover>
  );
}

/** Par etiqueta/valor. El `div` envolvente es válido dentro de un `dl` y es lo
 *  que permite que los pares fluyan en columnas en vez de apilarse. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Etiqueta pequeña sobre un valor tabular. Es el mismo primitivo para las
 * desviaciones del panel de detalle y para las métricas de la cabecera: el
 * tamaño lo pone el contenedor, no el componente.
 */
function Figure({
  label,
  value,
  tone = "",
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      <span className={`figure-value ${tone}`}>{value}</span>
      {hint ? <span className="figure-hint">{hint}</span> : null}
    </div>
  );
}

/** Barato respecto a la referencia es bueno, caro es malo; ±5 % es ruido. */
function comparisonTone(pct: number | null): string {
  if (pct === null) return "none";
  if (pct <= -5) return "positive";
  if (pct >= 5) return "negative";
  return "";
}

/** Ubicación del coche, con la ciudad del dealer como respaldo. */
function locationOf(offer: Offer): string {
  return offer.location || offer.dealer.city || "—";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "origen desconocido";
  }
}

/**
 * Vista del anuncio: foto, titular y precio, todo dentro de un enlace al original.
 *
 * No es un iframe de la página real a propósito: los portales de coches sirven
 * `X-Frame-Options`/`frame-ancestors` y el iframe saldría en blanco. Esto muestra
 * lo que sí tenemos scrapeado, y al pulsarlo se abre el anuncio de verdad.
 */
function OfferPreview({ offer }: { offer: Offer }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(offer.image_url) && !imageFailed;

  return (
    <a
      className="offer-preview"
      href={offer.url}
      target="_blank"
      rel="noreferrer"
      title={`Abrir en ${hostOf(offer.url)}`}
    >
      {showImage ? (
        <img
          className="offer-preview-image"
          src={offer.image_url ?? ""}
          alt={offer.title}
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="offer-preview-image empty">
          {offer.image_url ? "La foto ya no responde" : "Sin foto"}
        </div>
      )}

      {/* Sin precio: lo dice la franja de veredicto, justo encima. */}
      <div className="offer-preview-body">
        <span className="offer-preview-title">{offer.title}</span>
        <span className="tiny muted">
          {offer.dealer.name} · {hostOf(offer.url)}
        </span>
        <span className="tiny offer-preview-cta">Abrir el anuncio original ↗</span>
      </div>
    </a>
  );
}

/**
 * Payload crudo del scraper. Vive en su propio componente para que la petición
 * salga al desplegar y no al abrir el panel: casi nadie lo mira.
 */
function RawPayload({ offerId }: { offerId: number }) {
  const detail = useAsync<OfferRaw>(() => api.get(`/offers/${offerId}/raw`), [offerId]);
  const raw = detail.data?.raw ?? null;

  if (detail.loading) return <Loading />;
  if (detail.error) return <Banner kind="error">{detail.error}</Banner>;

  if (raw === null) {
    return (
      <p className="tiny muted" style={{ margin: 0 }}>
        Esta oferta se ingestó sin <code>raw</code>. El scraper puede volcar ahí lo que no
        cabe en el esquema (color, plazas, garantía…) para reprocesar sin volver a scrapear.
      </p>
    );
  }

  return (
    <div className="fact-group">
      <p className="fact-label">Payload del scraper ({Object.keys(raw).length} campos)</p>
      <pre className="raw-json">{JSON.stringify(raw, null, 2)}</pre>
    </div>
  );
}

/**
 * Todo lo que se sabe de una oferta, en tres franjas de densidad distinta.
 *
 * El orden no es el del esquema, es el de la pregunta: **¿merece la pena abrir
 * esto?** Por eso el precio, las desviaciones y las dos puntuaciones van arriba
 * del todo, sin scroll; la ficha del coche es la evidencia que las respalda; y
 * la procedencia (fuente, IDs, fechas de scrapeo, `raw`) va plegada, porque es
 * dato de diagnóstico y no de decisión.
 *
 * Antes esto eran seis tarjetas iguales apiladas, con la puntuación de valor
 * enterrada en la fila 8 de la tercera.
 */
function ScrapedDrawer({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const history = useAsync<OfferPricePoint[]>(
    () => api.get(`/offers/${offer.id}/price-history`),
    [offer.id],
  );
  const [rawOpen, setRawOpen] = useState(false);

  const m = offer.metrics;
  const points = history.data ?? [];

  return (
    <Drawer
      wide
      title={offer.title}
      subtitle={`${offer.car_model.display_name} · ${offer.dealer.name}`}
      onClose={onClose}
    >
      <div className="offer-detail">
        {/* ---- 1. Veredicto ---- */}
        <section className="verdict">
          <div className="verdict-head">
            <div className="verdict-price">
              <span className="verdict-amount">{formatPrice(offer.price)}</span>
              {offer.original_price ? (
                <span className="verdict-was">{formatPrice(offer.original_price)}</span>
              ) : null}
              {m.discount_pct ? (
                <Chip tone="warm">{formatPct(m.discount_pct)} dto.</Chip>
              ) : null}
              {/* Solo lo excepcional se anuncia: una oferta activa no dice nada. */}
              {offer.status !== "active" ? (
                <Chip tone={offer.status === "dismissed" ? "negative" : "neutral"}>
                  {offer.status === "dismissed" ? "Descartada" : "Expirada"}
                </Chip>
              ) : null}
            </div>

            <div className="verdict-score">
              <span className="figure-label">Puntuación de valor</span>
              <Score value={m.value_score} />
            </div>
          </div>

          <div className="verdict-deltas">
            {/* «del modelo» no es adorno: la columna de la tabla enseña otra
                desviación, la de las filas en pantalla, y sin esto son dos
                números distintos con el mismo nombre. */}
            <Figure
              label="vs mediana"
              value={formatPct(m.price_vs_median_pct, true)}
              tone={comparisonTone(m.price_vs_median_pct)}
              hint="del modelo"
            />
            <Figure
              label="vs PVP ref."
              value={formatPct(m.price_vs_reference_pct, true)}
              tone={comparisonTone(m.price_vs_reference_pct)}
            />
            <Figure
              label="Bajada"
              value={formatPct(m.price_drop_pct)}
              tone={m.price_drop_pct ? "positive" : "none"}
            />
            <Figure
              label="Km / año"
              value={m.km_per_year ? formatNumber(m.km_per_year) : "—"}
              tone={m.km_per_year ? "" : "none"}
            />
            <Figure label="Días publicada" value={formatNumber(m.days_listed)} />
          </div>

          {offer.ai ? (
            <div className="verdict-ai">
              <div className="verdict-ai-head">
                <span className={`rank-badge${offer.ai.rank <= 3 ? " top" : ""}`}>
                  {offer.ai.rank}
                </span>
                <Chip tone={verdictTone(offer.ai.verdict)}>
                  {VERDICT_LABELS[offer.ai.verdict]}
                </Chip>
                <Score value={offer.ai.score} />
                <div className="spacer" />
                <span className="tiny muted">{formatDateTime(offer.ai.ranked_at)}</span>
              </div>
              {offer.ai.reasoning ? (
                <p className="verdict-ai-reason">{offer.ai.reasoning}</p>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* ---- 2. Evidencia ---- */}
        <div className="offer-evidence">
          <OfferPreview offer={offer} />

          <div className="offer-facts">
            <div className="fact-group">
              <p className="fact-label">Vehículo</p>
              <dl className="kv">
                <Row label="Marca">{offer.car_model.make}</Row>
                <Row label="Modelo">{offer.car_model.model}</Row>
                <Row label="Versión">{offer.car_model.trim || "—"}</Row>
                <Row label="Estado">
                  <Chip tone={offer.condition === "used" ? "neutral" : "accent"}>
                    {CONDITION_LABELS[offer.condition]}
                  </Chip>
                </Row>
                <Row label="Año">{offer.year ?? "—"}</Row>
                <Row label="Kilómetros">{formatKm(offer.mileage_km)}</Row>
                <Row label="Combustible">
                  {offer.fuel_type ? FUEL_LABELS[offer.fuel_type] : "—"}
                </Row>
                <Row label="Cambio">
                  {offer.transmission ? TRANSMISSION_LABELS[offer.transmission] : "—"}
                </Row>
                <Row label="Potencia">{offer.power_hp ? `${offer.power_hp} CV` : "—"}</Row>
                <Row label="Ubicación">{offer.location ?? "—"}</Row>
              </dl>
            </div>

            <div className="fact-group">
              <p className="fact-label">Dealer</p>
              <dl className="kv">
                <Row label="Nombre">{offer.dealer.name}</Row>
                <Row label="Ciudad">
                  {[offer.dealer.city, offer.dealer.country].filter(Boolean).join(" · ") ||
                    "—"}
                </Row>
                <Row label="Valoración">
                  {offer.dealer.rating !== null ? `${offer.dealer.rating.toFixed(1)} ★` : "—"}
                </Row>
                <Row label="Web">
                  {offer.dealer.website ? (
                    <a
                      className="cell-link"
                      href={offer.dealer.website}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {offer.dealer.website.replace(/^https?:\/\//, "")} ↗
                    </a>
                  ) : (
                    "—"
                  )}
                </Row>
              </dl>
            </div>
          </div>
        </div>

        {/* El historial explica la «Bajada» de arriba: va junto, no 400 px más abajo. */}
        <div className="fact-group">
          <p className="fact-label">
            Historial de precios{points.length ? ` (${points.length})` : ""}
          </p>
          {history.loading ? (
            <Loading />
          ) : history.error ? (
            <Banner kind="error">{history.error}</Banner>
          ) : points.length <= 1 ? (
            <p className="tiny muted" style={{ margin: 0 }}>
              Un solo precio registrado: todavía no ha cambiado desde que se vio.
            </p>
          ) : (
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
          )}
        </div>

        {/* ---- 3. Procedencia ---- */}
        <details
          className="offer-provenance"
          onToggle={(event) => setRawOpen(event.currentTarget.open)}
        >
          <summary>Procedencia y payload del scraper</summary>
          <div className="offer-provenance-body">
            <dl className="kv kv-1">
              <Row label="Fuente">{offer.source ?? "—"}</Row>
              <Row label="ID en el origen">{offer.external_id ?? "—"}</Row>
              <Row label="Moneda">{offer.currency}</Row>
              <Row label="Vista por primera vez">{formatDateTime(offer.first_seen_at)}</Row>
              <Row label="Vista por última vez">{formatDateTime(offer.last_seen_at)}</Row>
              <Row label="Estado en la plataforma">
                {offer.status === "active"
                  ? "Activa"
                  : offer.status === "dismissed"
                    ? "Descartada"
                    : "Expirada"}
                {offer.dismiss_reason ? ` · ${offer.dismiss_reason}` : ""}
              </Row>
              <Row label="URL">
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  {offer.url}
                </span>
              </Row>
            </dl>

            {rawOpen ? <RawPayload offerId={offer.id} /> : null}
          </div>
        </details>
      </div>
    </Drawer>
  );
}
