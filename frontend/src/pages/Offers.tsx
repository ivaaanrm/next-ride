import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

import {
  RadarMark,
  RadarProfile,
  RadarReading,
  type RadarSeries,
} from "../components/charts";
import { PageHeader } from "../components/Layout";
import { OfferActions } from "../components/OfferActions";
import {
  Banner,
  Chip,
  Drawer,
  Empty,
  Loading,
  Popover,
  RangeSlider,
  Score,
  ToastStack,
  Toggle,
  useToasts,
} from "../components/ui";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  FUEL_LABELS,
  FUEL_MARKS,
  formatDate,
  formatDateTime,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  OFFER_STATUS,
  OFFER_STATUS_LABELS,
  offerStatusTone,
  scoreTone,
  TRANSMISSION_LABELS,
  VERDICT_LABELS,
  verdictTone,
} from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import { buildRadar, RADAR_MIN_AXES, type RadarAxis } from "../lib/radar";
import type {
  AnalyticsSegments,
  CarModelWithStats,
  DealerWithStats,
  Offer,
  OfferAggregateStats,
  OfferMetrics,
  OfferPricePoint,
  OfferRaw,
  OfferStatus,
  Page,
  ScoreBreakdownItem,
  SegmentPoint,
} from "../types";

/** Tamaño del tramo que se pide por vez. La tabla ya no pagina: es un único
 *  scroll que trae el siguiente tramo cuando el final se acerca. */
const CHUNK_SIZE = 50;

/**
 * Cómo se escribe cada estado. Los tres son la misma operación vista desde la
 * tabla —mover una oferta de lista— y por eso se indexan por destino: quien
 * llama dice adónde va, no qué verbo del API le toca.
 */
const MOVE: Record<OfferStatus, (id: number) => Promise<Offer>> = {
  active: (id) => api.post<Offer>(`/offers/${id}/restore`),
  dismissed: (id) => api.delete<Offer>(`/offers/${id}`),
  expired: (id) => api.post<Offer>(`/offers/${id}/expire`),
};

/** Lo que dura el desvanecido de una fila que se va. Igual que en la hoja de
 *  estilos: si cambia allí, cambia aquí, o la fila se queda a medio ir. */
const LEAVE_MS = 140;

/** Qué se enseña cuando una vista se queda vacía. Un «no hay nada» a secas en la
 *  lista de descartadas parece un error y es lo normal el primer día. */
const EMPTY_VIEW: Record<OfferStatus, { title: string; hint: string }> = {
  active: {
    title: "No hay ofertas que cumplan el filtro",
    hint: "El servicio scraper alimenta esta tabla vía POST /api/v1/offers/bulk.",
  },
  dismissed: {
    title: "No has descartado ninguna oferta",
    hint: "Al descartar una desde la lista activa aparece aquí, y desde aquí se restaura.",
  },
  expired: {
    title: "Ninguna oferta marcada como no disponible",
    hint: "Aquí caen las que el scraper ya no encuentra en el origen y las que marcas a mano al abrir el anuncio y ver que el coche ya no está.",
  },
};

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

  // El tope se dice aquí porque es el único sitio donde se dice, y llega antes
  // de pulsar: es lo que hay que saber para decidir si merece la pena ordenar.
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
 * filtrar y a medida que el scroll trae más tramos. La cabecera de la columna
 * enseña el valor para que el porcentaje no quede colgando de una referencia
 * invisible.
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
  // Los tres estados son tres listas excluyentes, no un interruptor: antes esto
  // era un «Descartadas» de sí/no, y con él las expiradas no se podían mirar
  // desde ningún sitio aunque el scraper llevara marcándolas desde el principio.
  const [statusView, setStatusView] = useState<OfferStatus>("active");
  const [actionError, setActionError] = useState<string | null>(null);
  const [favBusyId, setFavBusyId] = useState<number | null>(null);
  const [scraped, setScraped] = useState<Offer | null>(null);
  const toasts = useToasts();

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
    status: statusView,
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
    statusView,
  ];

  const stats = useAsync<OfferAggregateStats>(
    () => api.get("/offers/stats", filters),
    filterDeps,
  );

  /* ---- La lista, por tramos ----------------------------------------------
   *
   * Sin paginación: la tabla es un único scroll que pide el siguiente tramo de
   * 50 cuando el final se acerca. `useAsync` no vale aquí porque reemplaza sus
   * datos en cada petición y esto los acumula, así que la lista lleva su propio
   * estado.
   *
   * `epoch` invalida lo que llegue tarde: cambiar un filtro pide el tramo cero
   * de un conjunto nuevo, y un tramo viejo que aterrice después no debe
   * mezclarse con él. El offset del siguiente tramo es `rows.length` y no un
   * número de página: descartar o desmarcar encogen la lista cargada, y lo ya
   * cargado es exactamente lo que el siguiente tramo tiene que continuar.
   * ------------------------------------------------------------------------ */
  const [rows, setRows] = useState<Offer[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const epochRef = useRef(0);
  const rowsRef = useRef<Offer[]>([]);
  // Candado contra la ráfaga de eventos de scroll: un tramo en vuelo por vez.
  const busyRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  async function loadChunk(reset: boolean) {
    if (busyRef.current && !reset) return;
    const epoch = reset ? ++epochRef.current : epochRef.current;
    busyRef.current = true;
    if (reset) {
      setListLoading(true);
      setListError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const chunk = await api.get<Page<Offer>>("/offers", {
        ...filters,
        sort,
        limit: CHUNK_SIZE,
        offset: reset ? 0 : rowsRef.current.length,
      });
      if (epoch !== epochRef.current) return;
      setRows((previous) => (reset ? chunk.items : [...previous, ...chunk.items]));
      setTotal(chunk.total);
    } catch (error) {
      if (epoch !== epochRef.current) return;
      setListError(
        error instanceof Error ? error.message : "No se pudieron cargar las ofertas",
      );
    } finally {
      // Un tramo invalidado no toca los cerrojos: son de la petición que lo invalidó.
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setListLoading(false);
        setLoadingMore(false);
      }
    }
  }

  /** Cambiar cualquier filtro o el orden pide un conjunto nuevo desde arriba;
   *  el scroll vuelve al principio, que es donde está lo que se acaba de pedir. */
  useEffect(() => {
    wrapRef.current?.scrollTo({ top: 0 });
    void loadChunk(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...filterDeps, sort]);

  // En una pantalla muy alta el primer tramo puede no llenar el scroll: si no
  // hay dónde hacer scroll y quedan más ofertas, se trae el siguiente ya.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || listLoading || rows.length === 0 || rows.length >= total) return;
    if (wrap.scrollHeight <= wrap.clientHeight) void loadChunk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, total, listLoading]);

  /** A ~600px del final —unas quince filas— se pide el siguiente tramo: llega
   *  antes de que el scroll toque fondo y la lista se lee como una sola. */
  function onTableScroll(event: UIEvent<HTMLDivElement>) {
    const wrap = event.currentTarget;
    if (listLoading || rows.length >= total) return;
    if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 600) {
      void loadChunk(false);
    }
  }

  function refresh() {
    wrapRef.current?.scrollTo({ top: 0 });
    void loadChunk(true);
  }

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
    statusView !== "active";

  /** Devuelve la vista a su estado por defecto. El orden no es un filtro y se queda. */
  function clearFilters() {
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
    setStatusView("active");
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

      // Si estamos viendo solo favoritos, al desmarcar la fila desaparece.
      const drop = favoritesOnly && !updated.is_favorite;
      setRows((previous) =>
        drop
          ? previous.filter((item) => item.id !== updated.id)
          : previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (drop) setTotal((value) => Math.max(0, value - 1));

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

  /* ---- Mover una oferta de lista ------------------------------------------
   *
   * Las tres transiciones —descartar, marcar no disponible, restaurar— sacan la
   * fila de la vista que se está mirando, así que son la misma operación y se
   * hacen igual: la fila se va **ya** y la escritura viaja en paralelo.
   *
   * No hay confirmación. Antes había un `confirm()` por descarte, que es un
   * diálogo modal, el ratón hasta el botón y la vista bloqueada para cubrir el
   * caso de haber pulsado mal; ahora eso lo cubre el aviso de deshacer, que
   * ofrece lo mismo que ofrecía el «Cancelar» pero solo a quien falla. Se puede
   * porque ninguna de las tres borra nada: son cambios de estado, y las tres
   * vistas del desplegable llevan a las ofertas que están en cada uno.
   *
   * La fila no se quita en sitio en vez de recargar por capricho: recargar
   * reordenaría el conjunto entero y devolvería el scroll arriba, que es
   * exactamente lo que no se puede hacer a media triangulación de una lista.
   * -------------------------------------------------------------------------- */

  // Las que se están yendo: llevan la clase que las desvanece y ya no responden
  // a nada, para que un doble clic no mande la misma oferta dos veces.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const leaveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = leaveTimers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  function unmarkLeaving(id: number) {
    setLeaving((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }

  function removeRow(id: number) {
    setRows((previous) => previous.filter((item) => item.id !== id));
    unmarkLeaving(id);
  }

  /** Devuelve la fila a la posición que tenía. Es lo que deshace una salida —y
   *  también lo que repara una escritura fallida. */
  function insertRow(offer: Offer, index: number) {
    setRows((previous) => {
      if (previous.some((item) => item.id === offer.id)) return previous;
      const next = [...previous];
      next.splice(Math.min(index, next.length), 0, offer);
      return next;
    });
  }

  async function move(offer: Offer, target: OfferStatus) {
    if (leaving.has(offer.id)) return;
    setActionError(null);

    const from = offer.status;
    const index = Math.max(
      0,
      rowsRef.current.findIndex((item) => item.id === offer.id),
    );
    // El mismo `epoch` que invalida los tramos que llegan tarde: si entre pulsar
    // y contestar el servidor se ha cambiado de filtro, lo cargado es otro
    // conjunto y esta fila no tiene sitio en él, ni para volver ni para contarse.
    const epoch = epochRef.current;

    setLeaving((previous) => new Set(previous).add(offer.id));
    leaveTimers.current.set(
      offer.id,
      setTimeout(() => {
        leaveTimers.current.delete(offer.id);
        removeRow(offer.id);
      }, LEAVE_MS),
    );

    try {
      await MOVE[target](offer.id);
      if (epoch !== epochRef.current) return;
      setTotal((value) => Math.max(0, value - 1));
      stats.reload();
      toasts.push({
        message: (
          <>
            <span className="toast-subject">{offer.title}</span>{" "}
            {OFFER_STATUS[target].done}
          </>
        ),
        // Deshacer devuelve la oferta a donde estaba, que no siempre es «activa»:
        // marcar «no disponible» una que ya estaba descartada se deshace volviendo
        // a descartada. Por eso el destino es `from` y no un estado fijo.
        undo: () => undoMove(offer, from, index, epoch),
      });
    } catch (error) {
      if (epoch !== epochRef.current) return;
      // Se cancela la salida si aún no ha corrido; si ya corrió, `insertRow`
      // devuelve la fila a su sitio. En los dos casos acaba donde estaba.
      const timer = leaveTimers.current.get(offer.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        leaveTimers.current.delete(offer.id);
      }
      unmarkLeaving(offer.id);
      insertRow(offer, index);
      setActionError(
        error instanceof Error
          ? error.message
          : `No se pudo ${OFFER_STATUS[target].verb.toLowerCase()}`,
      );
    }
  }

  async function undoMove(offer: Offer, back: OfferStatus, index: number, epoch: number) {
    setActionError(null);
    try {
      const restored = await MOVE[back](offer.id);
      // La vista ha cambiado mientras el aviso estaba en pantalla: el estado se
      // ha deshecho igual, pero devolver la fila la metería en una lista a la
      // que no pertenece. Las métricas sí se rehacen: cuentan otro conjunto.
      if (epoch !== epochRef.current) {
        stats.reload();
        return;
      }
      insertRow(restored, index);
      setTotal((value) => value + 1);
      stats.reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "No se pudo deshacer el cambio",
      );
    }
  }

  const overview = stats.data;

  const shownMedian = useMemo(() => medianPrice(rows), [rows]);

  return (
    <>
      <PageHeader
        title="Ofertas"
        meta={total ? `${formatNumber(total)} resultados` : undefined}
        actions={
          <button className="btn btn-sm" onClick={refresh}>
            Actualizar
          </button>
        }
      />

      {/* `content-fill`: el alto sobrante es de la tabla, que hace scroll por
          dentro; las métricas y los filtros quedan siempre a la vista. */}
      <div className="content content-fill">
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
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <select
            className="select"
            aria-label="Filtrar por modelo"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
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
            onChange={(event) => setDealerId(event.target.value)}
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
            onChange={(event) => setCondition(event.target.value)}
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
              setYearMin(min);
              setYearMax(max);
            }}
          />

          <div className="filter-scopes">
            {/* Un desplegable y no tres interruptores: los tres estados son
                excluyentes —una oferta está en uno—, así que dos interruptores
                encendidos a la vez no querrían decir nada. Y se marca en acento
                cuando no está en «Activas», porque desde una lista de descartadas
                todo lo demás de la barra parece mentir. */}
            <select
              className={`select${statusView === "active" ? "" : " on"}`}
              aria-label="Ver ofertas por su estado en la plataforma"
              title="Las ofertas activas, las que has descartado o las que ya no están en el origen"
              value={statusView}
              onChange={(event) => setStatusView(event.target.value as OfferStatus)}
            >
              {(["active", "dismissed", "expired"] as const).map((value) => (
                <option key={value} value={value}>
                  {OFFER_STATUS[value].label}
                </option>
              ))}
            </select>
            <Toggle
              on={trackedOnly}
              onChange={setTrackedOnly}
              title="Solo modelos que sigues"
            >
              Seguidos
            </Toggle>
            <Toggle
              on={favoritesOnly}
              onChange={setFavoritesOnly}
              title="Solo tus favoritos"
            >
              {/* La misma estrella que marca la fila: el filtro y la acción que
                  lo alimenta se reconocen como lo mismo. */}
              <span className="toggle-mark" aria-hidden="true">
                ★
              </span>
              Favoritos
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
        {listError ? <Banner kind="error">{listError}</Banner> : null}

        <div className="table-wrap" ref={wrapRef} onScroll={onTableScroll}>
          {listLoading ? (
            <Loading />
          ) : rows.length === 0 ? (
            // La pista depende de la vista: «no hay nada» en la lista de
            // descartadas parece una avería, y es lo normal el primer día.
            <Empty
              title={EMPTY_VIEW[statusView].title}
              hint={
                favoritesOnly
                  ? "Marca ofertas con la estrella para que aparezcan aquí."
                  : EMPTY_VIEW[statusView].hint
              }
            />
          ) : (
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <span className="sr-only">Favorito</span>
                  </th>
                  <SortTh column="ai" label="IA" sort={sort} onSort={setSort} width={56} />
                  <th>Marca</th>
                  <th>Modelo</th>
                  <th>Versión</th>
                  <th>Ubicación</th>
                  <SortTh column="price" label="Precio" sort={sort} onSort={setSort} numeric />
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
                  <SortTh column="year" label="Año" sort={sort} onSort={setSort} numeric />
                  <SortTh column="km" label="Km" sort={sort} onSort={setSort} numeric />
                  {/* Tampoco ordena: es una métrica derivada que el backend no
                      tiene en columna, y ordenar solo lo ya cargado daría un
                      orden que se deshace con cada tramo que llega. */}
                  <th className="num">Km / año</th>
                  {/* Sin rótulo visible: la columna es una marca de una letra y
                      el rótulo pedía el triple de ancho que su propio contenido.
                      El nombre sigue estando para quien navega con lector de
                      pantalla, igual que en la columna de la estrella. */}
                  <th style={{ width: 44 }}>
                    <span className="sr-only">Combustible</span>
                  </th>
                  <SortTh column="value" label="Valor" sort={sort} onSort={setSort} numeric />
                  {/* Dos botones de 24 px con su hueco. Sin rótulo visible, como
                      la estrella y el combustible: la columna es más estrecha que
                      cualquier palabra que la nombre. */}
                  <th style={{ width: 62 }}>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((offer) => (
                  <tr
                    key={offer.id}
                    className={`row-clickable${leaving.has(offer.id) ? " row-leaving" : ""}`}
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

                    {/* La versión trae la motorización al principio, que es lo que
                        distingue; el resto se recorta y vive en el `title` y en el
                        panel de detalle. Sin el recorte, un «Sportback Advanced 30
                        TFSI…» obliga a la tabla entera a hacer scroll horizontal. */}
                    <td
                      className="cell-muted cell-clip-md"
                      title={offer.car_model.trim || undefined}
                    >
                      {offer.car_model.trim || "—"}
                    </td>

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

                    {/* La marca es lo único que se ve; el rótulo entero viaja en
                        el `title` para el ratón y en el `aria-label` para quien
                        no lo tiene, porque una «D» suelta no se lee sola. */}
                    <td className="fuel-cell">
                      {offer.fuel_type ? (
                        <span
                          className="fuel-mark"
                          title={FUEL_LABELS[offer.fuel_type]}
                          aria-label={FUEL_LABELS[offer.fuel_type]}
                        >
                          {FUEL_MARKS[offer.fuel_type]}
                        </span>
                      ) : (
                        <span className="muted tiny">—</span>
                      )}
                    </td>

                    <td className="num">
                      <Score value={offer.metrics.value_score} />
                    </td>

                    <td>
                      <OfferActions
                        offer={offer}
                        busy={leaving.has(offer.id)}
                        onMove={move}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Dentro del scroll, pegado al final de lo cargado: aparece justo
              donde se está mirando cuando el tramo siguiente viene de camino. */}
          {loadingMore ? (
            <div className="table-more" role="status">
              Cargando más ofertas…
            </div>
          ) : null}
        </div>
      </div>

      {scraped ? (
        <ScrapedDrawer
          offer={scraped}
          onClose={() => setScraped(null)}
          onMove={(offer, target) => {
            // El panel se cierra al mover: la oferta que describe acaba de salir
            // de la lista que hay detrás, y dejarlo abierto sobre una ficha que
            // ya no está ahí es peor que no haberlo abierto.
            setScraped(null);
            void move(offer, target);
          }}
        />
      ) : null}

      <ToastStack {...toasts} />
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

/* -------------------------------------------------------------------------- *
 * Perfil frente a sus comparables
 * -------------------------------------------------------------------------- */

/** Lo que hace falta de una oferta para colocarla en el radar. */
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
 * Los cinco ejes, todos orientados a favor de quien compra: más lejos del centro
 * es mejor, siempre. Es la misma escala que la Analítica —mediana en el centro,
 * mayor desviación del conjunto en el borde, con un recorrido mínimo para que
 * una diferencia pequeña no se estire—, solo que aquí el conjunto son las otras
 * ofertas del mismo binomio marca-modelo.
 *
 * El descuento sobre PVP no tiene eje propio: solo una de cada tres ofertas trae
 * `original_price`, así que el eje se caía casi siempre y cuando no, comparaba
 * contra una mediana de cuatro anuncios. Sigue contando donde tiene sentido, que
 * es dentro de «Valor».
 *
 * «Valor» es la puntuación de la plataforma, o sea el resumen que ya sale arriba
 * del panel. Está aquí porque no es una función de los otros cuatro ejes: mira el
 * precio contra la mediana de *su versión exacta*, no contra la del binomio, y
 * suma el descuento, la bajada de precio y la valoración del dealer, que no
 * tienen eje propio.
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
 * movería la mediana de un mercado del que forma parte, y con dos docenas de
 * anuncios la diferencia sería de todos modos invisible.
 *
 * Vive en su propio componente para que la petición salga al abrir el panel de
 * *esta* oferta y no con la tabla entera.
 */
function OfferRadar({ offer }: { offer: Offer }) {
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

  const series: RadarSeries[] = [
    { key: "offer", label: "Esta oferta", color: "var(--color-chart-1)" },
  ];

  return (
    <div className="radar-split">
      <RadarProfile
        rows={rows}
        series={series}
        referenceLabel={`Mediana de ${formatNumber(points.length)} comparables`}
      />

      {/* La lista hace de leyenda y de lectura a la vez, y es el equivalente
          accesible del dibujo: lo que ahí es posición, aquí es una frase. */}
      <ul className="chart-notes radar-notes">
        <li>
          <RadarMark color="var(--color-chart-1)" />
          <span className="chart-note-label">Esta oferta</span>
          <RadarReading rows={rows} seriesKey="offer" />
        </li>
        <li>
          <RadarMark color="var(--text-tertiary)" dashed />
          <span className="chart-note-label">
            Mediana de {formatNumber(points.length)} comparables
          </span>
          <span className="muted">la oferta típica de {segment?.label}</span>
        </li>
        {/* «Valor» es el único eje que no se lee en el propio anuncio; su cuenta
            completa —señal a señal, con los pesos finales— está en el desglose
            de arriba de este mismo panel, así que aquí basta la definición. */}
        <li className="muted note">
          <span className="chart-note-label">Valor</span> es la media ponderada de las
          señales del desglose de arriba: precio frente al mercado y frente al valor
          esperado por depreciación, kilometraje, antigüedad, bajada, descuento, dealer y
          frescura. Los pesos se ven y se editan en Ajustes.
        </li>
        {dropped.length ? (
          <li className="muted note">
            Fuera del radar: {dropped.join(", ").toLowerCase()}. Un eje se cae cuando esta
            oferta no trae el dato o cuando sus comparables no lo traen.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** La magnitud de un componente del score, en su unidad y con su signo. */
function metricText(item: ScoreBreakdownItem): string {
  // Las señales categóricas (el cambio) viajan como texto, no como número.
  if (item.text) return item.text;
  if (item.metric === null) return "—";
  if (item.unit === "%") {
    // Las desviaciones llevan signo (−12 % es más barato); la bajada es una
    // magnitud y el signo no aporta.
    const signed = ["price_vs_market", "price_vs_expected", "mileage"].includes(item.key);
    return formatPct(item.metric, signed);
  }
  return `${formatNumber(item.metric)} ${item.unit}`;
}

/**
 * El desglose auditable de la puntuación: cada señal con su valor, su subscore
 * 0-100, el **peso final** que se usó (ya renormalizado sobre las señales con
 * dato) y los puntos que aporta. La suma de la última columna ES la
 * puntuación: no hay nada más en la cifra que lo que se ve aquí.
 */
function ScoreBreakdown({ metrics }: { metrics: OfferMetrics }) {
  const rows = metrics.score_breakdown;
  if (rows.length === 0) return null;
  const missing = rows.filter((row) => !row.available);

  return (
    <div className="score-breakdown">
      <div className="score-breakdown-grid" role="table" aria-label="Desglose de la puntuación">
        <div className="score-breakdown-row head" role="row">
          <span role="columnheader">Señal</span>
          <span role="columnheader" className="num">
            Valor
          </span>
          <span role="columnheader">Subscore</span>
          <span role="columnheader" className="num" title="Peso final tras repartir el de las señales sin dato">
            Peso
          </span>
          <span role="columnheader" className="num" title="Subscore × peso: lo que suma al total">
            Puntos
          </span>
        </div>
        {rows
          .filter((row) => row.available)
          .map((row) => (
            <div className="score-breakdown-row" role="row" key={row.key}>
              <span role="cell">{row.label}</span>
              <span role="cell" className="num cell-muted">
                {metricText(row)}
              </span>
              <span role="cell" className={`score-mini ${scoreTone(row.subscore)}`}>
                <span className="score-bar">
                  <span style={{ width: `${Math.max(2, Math.min(100, row.subscore ?? 0))}%` }} />
                </span>
                <span className="tiny">{Math.round(row.subscore ?? 0)}</span>
              </span>
              <span role="cell" className="num cell-muted">
                {formatNumber(row.weight_pct)} %
              </span>
              <span role="cell" className="num" style={{ fontWeight: 500 }}>
                {(row.points ?? 0).toLocaleString("es-ES", {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}
              </span>
            </div>
          ))}
      </div>
      {missing.length > 0 ? (
        <p className="tiny muted" style={{ margin: "8px 0 0" }}>
          Sin dato: {missing.map((row) => row.label.toLowerCase()).join(", ")} — su peso se
          reparte entre las señales presentes.
        </p>
      ) : null}
      <p className="tiny muted" style={{ margin: "4px 0 0" }}>
        Los pesos se editan en Ajustes y aplican a todo el catálogo.
      </p>
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
function ScrapedDrawer({
  offer,
  onClose,
  onMove,
}: {
  offer: Offer;
  onClose: () => void;
  onMove: (offer: Offer, target: OfferStatus) => void;
}) {
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
      /* Con su nombre escrito y no como iconos: aquí se llega después de leer la
         ficha y de abrir el anuncio en otra pestaña, que es justo cuando se
         descubre que el coche ya no está. Es el sitio donde más se va a pulsar
         «No disponible», así que no puede depender de reconocer un dibujo. */
      actions={<OfferActions offer={offer} variant="wide" onMove={onMove} />}
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
                <Chip
                  tone={offerStatusTone(offer.status)}
                  title={OFFER_STATUS[offer.status].hint}
                >
                  {OFFER_STATUS_LABELS[offer.status]}
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
            {/* El ancla de la depreciación: qué debería costar hoy este coche
                por edad y km, y a cuánto está la oferta de esa cifra. El origen
                del ancla importa: «PVP» es la cifra curada de la versión,
                «mercado» la estimada invirtiendo la curva sobre el binomio. */}
            <Figure
              label="vs valor esperado"
              value={formatPct(m.price_vs_expected_pct, true)}
              tone={comparisonTone(m.price_vs_expected_pct)}
              hint={
                m.expected_price_eur
                  ? `${formatPrice(m.expected_price_eur)} vía ${
                      m.expected_price_source === "pvp" ? "PVP" : "mercado"
                    }`
                  : undefined
              }
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

          <ScoreBreakdown metrics={m} />

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

        {/* El radar va detrás de la ficha y no pegado al veredicto: sus ejes son
            el año, los kilómetros y el precio que se acaban de leer ahí arriba,
            así que aquí lo que hace es contestar «¿y eso es mucho o poco?» sobre
            unas cifras que el lector todavía tiene en la cabeza. */}
        <div className="fact-group">
          <p className="fact-label">Perfil frente a sus comparables</p>
          <OfferRadar offer={offer} />
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
                {OFFER_STATUS_LABELS[offer.status]}
                {offer.dismissed_at ? ` · ${formatDateTime(offer.dismissed_at)}` : ""}
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
