import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { PageHeader } from "../components/Layout";
import { OfferActions } from "../components/OfferActions";
import {
  Figure,
  FilterRail,
  FilterSheet,
  priceDomainOf,
  SortSheet,
  yearDomainOf,
  type RangeDomain,
} from "../components/OfferFilters";
import { OfferProfile, PriceHistory } from "../components/OfferProfile";
import { locationOf, OfferRow, VsMedian } from "../components/OfferRow";
import { useSwipeHint, useTouchLayout } from "../components/SwipeRow";
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
import {
  activeDir,
  CAP_HINT,
  clearedView,
  DEFAULT_VIEW,
  filterKey,
  formatYear,
  isFiltered,
  MAX_RESTORE_CHUNKS,
  nextDir,
  readPlace,
  readView,
  SORT_COLUMNS,
  viewFilters,
  writePlace,
  writeView,
  type OffersView,
  type SortColumn,
  type SortColumnId,
  type SortDir,
} from "../lib/offerParams";
import type {
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
} from "../types";

/** Tamaño del tramo que se pide por vez. La lista no pagina: es un único scroll
 *  que trae el siguiente tramo cuando el final se acerca. */
const CHUNK_SIZE = 50;

/**
 * Cómo se escribe cada estado. Los tres son la misma operación vista desde la
 * lista —mover una oferta de lista— y por eso se indexan por destino: quien
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

/**
 * Cabecera que ordena. **Solo escritorio**: por debajo de 860 px el orden vive
 * en su propia hoja, porque no hay cabecera de tabla que pulsar.
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
  const current: SortDir | null = activeDir(spec, sort);
  const next = nextDir(spec, current);
  const token = spec[next];
  // Único sentido disponible y ya puesto: no hay nada que aplicar.
  const inert = token === null || token === sort;

  // El tope se dice aquí porque es el único sitio donde se dice en escritorio, y
  // llega antes de pulsar: es lo que hay que saber para decidir si merece la
  // pena ordenar. En el móvil, el mismo texto va escrito en la hoja de orden.
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
 * filtrar y a medida que el scroll trae más tramos. La referencia se escribe
 * —en la cabecera de la columna en escritorio, en la línea de contexto en el
 * móvil— para que el porcentaje no quede colgando de algo invisible.
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

/** Lo que se teclea y se arrastra en vivo, antes de llegar a la URL. */
interface Draft {
  q: string;
  priceMin: number | null;
  priceMax: number | null;
  yearMin: number | null;
  yearMax: number | null;
}

const draftOf = (view: OffersView): Draft => ({
  q: view.q,
  priceMin: view.priceMin,
  priceMax: view.priceMax,
  yearMin: view.yearMin,
  yearMax: view.yearMax,
});

/** Clave escalar del borrador: `useDebounced` compara por identidad, y un objeto
 *  recreado en cada render reiniciaría el temporizador sin fin. */
const draftKey = (draft: Draft): string =>
  [draft.q, draft.priceMin, draft.priceMax, draft.yearMin, draft.yearMax].join("|");

export function OffersPage() {
  /* ---- El estado de la vista vive en la URL --------------------------------
   *
   * Once filtros, el orden y la oferta abierta. No es purismo: el recorrido
   * normal de esta pantalla acaba en el anuncio del dealer, y volver de ahí en
   * un iPhone es a menudo un arranque en frío. Con la URL, volver es recargar la
   * misma lista; con `useState`, volver era empezar de cero.
   * ------------------------------------------------------------------------ */
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = useMemo(() => readView(params), [params]);
  const touch = useTouchLayout();

  /** Escribe la vista. `replace` por defecto: teclear en la búsqueda no puede
   *  apilar cincuenta entradas de historial. Abrir una oferta sí empuja, porque
   *  entonces «atrás» tiene que cerrar la ficha. */
  function commit(next: OffersView, options: { push?: boolean } = {}) {
    setParams(writeView(next), { replace: options.push !== true });
  }

  // Lo que se teclea y se arrastra se retiene aquí y llega a la URL con retardo:
  // un carácter por entrada de historial y una petición por tecla no.
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const urlKey = draftKey(draftOf(view));
  const debouncedKey = useDebounced(draftKey(draft));

  // La URL ha cambiado por fuera (atrás, un chip del riel, aplicar la hoja): el
  // borrador la sigue.
  useEffect(() => {
    setDraft(draftOf(view));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  useEffect(() => {
    if (debouncedKey === urlKey) return;
    commit({ ...view, ...draft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKey]);

  const [domains, setDomains] = useState<{
    price: RangeDomain | null;
    year: RangeDomain | null;
  }>({ price: null, year: null });
  const [actionError, setActionError] = useState<string | null>(null);
  const [favBusyId, setFavBusyId] = useState<number | null>(null);
  const [sheet, setSheet] = useState<"filters" | "sort" | null>(null);
  const toasts = useToasts();

  const models = useAsync<CarModelWithStats[]>(() => api.get("/car-models"), []);
  const dealers = useAsync<DealerWithStats[]>(() => api.get("/dealers"), []);

  const listKey = filterKey(view);
  const stats = useAsync<OfferAggregateStats>(
    () => api.get("/offers/stats", viewFiltersOf(view)),
    [listKey],
  );

  /* ---- La lista, por tramos ----------------------------------------------
   *
   * Sin paginación: la lista es un único scroll que pide el siguiente tramo de
   * 50 cuando el final se acerca. `useAsync` no vale aquí porque reemplaza sus
   * datos en cada petición y esto los acumula, así que la lista lleva su propio
   * estado.
   *
   * `epoch` invalida lo que llegue tarde: cambiar un filtro pide el tramo cero
   * de un conjunto nuevo, y un tramo viejo que aterrice después no debe
   * mezclarse con él. El offset del siguiente tramo es `rows.length` y no un
   * número de página: descartar o desmarcar encogen la lista cargada, y lo ya
   * cargado es exactamente lo que el siguiente tramo tiene que continuar.
   *
   * Esta capa no se ha tocado al portar la pantalla al móvil, y es deliberado:
   * es lo que hace que la lista se lea como una sola.
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
  // A dónde hay que volver cuando la lista se rehidrata después de un viaje al
  // anuncio del dealer.
  const restoreTopRef = useRef<number | null>(null);
  const placeKeyRef = useRef(`${listKey}|${view.sort}`);
  placeKeyRef.current = `${listKey}|${view.sort}`;

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

    // Al volver a un conjunto que ya se estaba mirando se pide de una vez lo que
    // había: rehidratar tramo a tramo dejaría el scroll saltando hacia atrás
    // mientras llegan.
    const place = reset ? readPlace(placeKeyRef.current) : null;
    const limit = place ? Math.min(place.chunks, MAX_RESTORE_CHUNKS) * CHUNK_SIZE : CHUNK_SIZE;

    try {
      const chunk = await api.get<Page<Offer>>("/offers", {
        ...viewFiltersOf(view),
        sort: view.sort,
        limit,
        offset: reset ? 0 : rowsRef.current.length,
      });
      if (epoch !== epochRef.current) return;
      setRows((previous) => (reset ? chunk.items : [...previous, ...chunk.items]));
      setTotal(chunk.total);
      if (place) restoreTopRef.current = place.top;
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
  }, [listKey, view.sort]);

  // La vuelta a la posición donde se estaba, una sola vez y después de que las
  // filas existan: sin filas no hay alto al que desplazarse.
  useEffect(() => {
    const top = restoreTopRef.current;
    if (top === null || rows.length === 0 || !wrapRef.current) return;
    restoreTopRef.current = null;
    wrapRef.current.scrollTop = top;
  }, [rows.length]);

  // En una pantalla muy alta el primer tramo puede no llenar el scroll: si no
  // hay dónde hacer scroll y quedan más ofertas, se trae el siguiente ya.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || listLoading || rows.length === 0 || rows.length >= total) return;
    if (wrap.scrollHeight <= wrap.clientHeight) void loadChunk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, total, listLoading]);

  /** A ~600px del final —unas ocho filas de móvil— se pide el siguiente tramo:
   *  llega antes de que el scroll toque fondo y la lista se lee como una sola. */
  function onListScroll(event: UIEvent<HTMLDivElement>) {
    const wrap = event.currentTarget;
    savePlace(wrap.scrollTop);
    if (listLoading || rows.length >= total) return;
    if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 600) {
      void loadChunk(false);
    }
  }

  // Una escritura por evento de scroll serían cientos por gesto: se guarda como
  // mucho dos veces por segundo, y además al irse de la página, que es el
  // momento que de verdad importa.
  const lastSaveRef = useRef(0);
  function savePlace(top: number, force = false) {
    const now = Date.now();
    if (!force && now - lastSaveRef.current < 500) return;
    lastSaveRef.current = now;
    writePlace(placeKeyRef.current, {
      top,
      chunks: Math.max(1, Math.ceil(rowsRef.current.length / CHUNK_SIZE)),
    });
  }

  // `pagehide` y no `unload`: es el único que iOS dispara de forma fiable cuando
  // la app se va al navegador in-app o al segundo plano, que es exactamente el
  // viaje que esto tiene que sobrevivir.
  useEffect(() => {
    const onLeave = () => {
      const wrap = wrapRef.current;
      if (wrap) savePlace(wrap.scrollTop, true);
    };
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      onLeave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refresh() {
    wrapRef.current?.scrollTo({ top: 0 });
    restoreTopRef.current = null;
    writePlace(placeKeyRef.current, { top: 0, chunks: 1 });
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

  /** Marca o desmarca un favorito y parchea la fila en sitio: no recarga la lista
   *  para no perder la posición ni el orden mientras se marcan varias. */
  async function toggleFavorite(offer: Offer) {
    setActionError(null);
    setFavBusyId(offer.id);
    try {
      const updated = offer.is_favorite
        ? await api.delete<Offer>(`/offers/${offer.id}/favorite`)
        : await api.post<Offer>(`/offers/${offer.id}/favorite`);

      // Si estamos viendo solo favoritos, al desmarcar la fila desaparece.
      const drop = view.favorites && !updated.is_favorite;
      setRows((previous) =>
        drop
          ? previous.filter((item) => item.id !== updated.id)
          : previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (drop) setTotal((value) => Math.max(0, value - 1));

      // Viendo solo favoritos, desmarcar cambia el conjunto: las medias de
      // arriba dejan de ser las de la lista hasta que se recalculan.
      if (view.favorites) stats.reload();
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
   * No hay confirmación. Lo cubre el aviso de deshacer, que ofrece lo mismo que
   * ofrecería un «Cancelar» pero solo a quien falla. Se puede porque ninguna de
   * las tres borra nada: son cambios de estado, y las tres vistas del filtro de
   * estado llevan a las ofertas que están en cada uno.
   *
   * En el móvil, además, el gesto no confirma solo: se desliza para ver los dos
   * botones y se toca el que toca. Un rebase de inercia no puede archivar una
   * oferta en el estado equivocado.
   * -------------------------------------------------------------------------- */

  // Las que se están yendo: llevan la clase que las desvanece y ya no responden
  // a nada, para que un doble toque no mande la misma oferta dos veces.
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

  /* ---- La ficha, que es una entrada de historial ---------------------------
   *
   * Abrir una oferta empuja `?offer=<id>`; cerrarla es un `navigate(-1)`. Con
   * eso, el gesto de borde del sistema —cuando iOS lo entrega— cierra la ficha
   * en vez de cambiar de ruta. Ninguna salida depende de que ese gesto exista:
   * la cabecera de la hoja lleva su cierre visible de 44 pt.
   * ------------------------------------------------------------------------ */
  const pushedRef = useRef(false);
  useEffect(() => {
    if (view.offer === null) pushedRef.current = false;
  }, [view.offer]);

  function openOffer(offer: Offer) {
    setSheet(null);
    pushedRef.current = true;
    commit({ ...view, offer: offer.id }, { push: true });
  }

  function closeOffer() {
    // Si la ficha venía en la URL de arranque no hay entrada a la que volver:
    // un `navigate(-1)` ahí saca de la app.
    if (pushedRef.current) {
      pushedRef.current = false;
      navigate(-1);
      return;
    }
    commit({ ...view, offer: null });
  }

  const overview = stats.data;
  const shownMedian = useMemo(() => medianPrice(rows), [rows]);
  const openRow = view.offer === null ? null : rows.find((row) => row.id === view.offer) ?? null;

  const hint = useSwipeHint(touch && !listLoading && rows.length > 0);
  const filterCount = countFilters(view);

  const names = {
    model: models.data?.find((model) => String(model.id) === view.model)?.display_name,
    dealer: dealers.data?.find((dealer) => String(dealer.id) === view.dealer)?.name,
    condition: view.condition
      ? CONDITION_LABELS[view.condition as keyof typeof CONDITION_LABELS]
      : undefined,
    status: OFFER_STATUS[view.status].label,
  };

  return (
    <>
      <PageHeader
        title="Ofertas"
        meta={!touch && total ? `${formatNumber(total)} resultados` : undefined}
        actions={
          <button className="btn btn-sm" onClick={refresh}>
            Actualizar
          </button>
        }
      />

      {/* `content-fill`: el alto sobrante es de la lista, que hace scroll por
          dentro; el riel y la línea de contexto quedan siempre a la vista. */}
      <div className="content content-fill offer-view">
        {touch ? (
          <>
            <FilterRail
              view={view}
              names={names}
              filterCount={filterCount}
              onOpenFilters={() => setSheet("filters")}
              onOpenSort={() => setSheet("sort")}
              onChange={(next) => commit(next)}
            />

            {/* La mediana contra la que se mide «vs mediana» en cada fila. En
                escritorio vive en el `<th>` de su columna; aquí, donde no hay
                cabecera, va en la línea que describe el conjunto. */}
            <p className="offer-context" role="status">
              {listLoading
                ? "Cargando ofertas…"
                : `${formatNumber(total)} ${total === 1 ? "oferta" : "ofertas"}${
                    shownMedian !== null
                      ? ` · mediana en pantalla ${formatPrice(shownMedian)}`
                      : ""
                  }`}
            </p>

            {hint.line ? (
              <p className="offer-hint">
                Desliza una fila a la izquierda para descartarla o marcarla no disponible.
              </p>
            ) : null}
          </>
        ) : (
          <>
            {/* Métricas del conjunto filtrado. Sin tarjetas: son contexto de la
                tabla, no cinco objetos distintos que comparar entre sí. En el
                móvil viven dentro de la hoja de filtros, que es donde describen
                exactamente el conjunto que se está acotando. */}
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
                  onClick={() => openOffer(overview.best_deal as Offer)}
                  title={`Ver el detalle de ${overview.best_deal.title}`}
                >
                  {/* Sin puntuación al lado del precio: dos números del mismo
                      tamaño compiten en vez de jerarquizar. */}
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

            {/* Una sola fila de 28 px. Las etiquetas viven en `aria-label`: sobre
                un desplegable cuya primera opción es «Todos los modelos» no hace
                falta escribir «Modelo», y ese alto se lo queda la tabla. */}
            <div className="filters">
              <div className="filter-search">
                <input
                  className="input"
                  aria-label="Buscar por título"
                  placeholder="Buscar por título…"
                  value={draft.q}
                  onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                />
              </div>

              <select
                className="select"
                aria-label="Filtrar por modelo"
                value={view.model}
                onChange={(event) => commit({ ...view, model: event.target.value })}
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
                value={view.dealer}
                onChange={(event) => commit({ ...view, dealer: event.target.value })}
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
                value={view.condition}
                onChange={(event) => commit({ ...view, condition: event.target.value })}
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
                value={[draft.priceMin, draft.priceMax]}
                format={formatPrice}
                formatShort={formatNumber}
                emptyTitle="Todavía no hay precios que acotar"
                onChange={([min, max]) =>
                  setDraft({ ...draft, priceMin: min, priceMax: max })
                }
              />

              <RangeFilter
                name="Año"
                domain={domains.year}
                value={[draft.yearMin, draft.yearMax]}
                format={formatYear}
                emptyTitle="Ninguna oferta trae año"
                onChange={([min, max]) => setDraft({ ...draft, yearMin: min, yearMax: max })}
              />

              <div className="filter-scopes">
                {/* Un desplegable y no tres interruptores: los tres estados son
                    excluyentes —una oferta está en uno—, así que dos
                    interruptores encendidos a la vez no querrían decir nada. */}
                <select
                  className={`select${view.status === "active" ? "" : " on"}`}
                  aria-label="Ver ofertas por su estado en la plataforma"
                  title="Las ofertas activas, las que has descartado o las que ya no están en el origen"
                  value={view.status}
                  onChange={(event) =>
                    commit({ ...view, status: event.target.value as OfferStatus })
                  }
                >
                  {(["active", "dismissed", "expired"] as const).map((value) => (
                    <option key={value} value={value}>
                      {OFFER_STATUS[value].label}
                    </option>
                  ))}
                </select>
                <Toggle
                  on={view.tracked}
                  onChange={(on) => commit({ ...view, tracked: on })}
                  title="Solo modelos que sigues"
                >
                  Seguidos
                </Toggle>
                <Toggle
                  on={view.favorites}
                  onChange={(on) => commit({ ...view, favorites: on })}
                  title="Solo tus favoritos"
                >
                  {/* La misma estrella que marca la fila: el filtro y la acción
                      que lo alimenta se reconocen como lo mismo. */}
                  <span className="toggle-mark" aria-hidden="true">
                    ★
                  </span>
                  Favoritos
                </Toggle>
              </div>

              {/* Sin etiquetas visibles, un control con un valor puesto es lo
                  único que delata que la tabla está acotada: hace falta la salida. */}
              {isFiltered(view) ? (
                <button className="btn btn-ghost" onClick={() => commit(clearedView(view))}>
                  Limpiar
                </button>
              ) : null}
            </div>
          </>
        )}

        {actionError ? <Banner kind="error">{actionError}</Banner> : null}
        {listError ? <Banner kind="error">{listError}</Banner> : null}

        <div
          className={`table-wrap${touch ? " offer-scroll" : ""}`}
          ref={wrapRef}
          onScroll={onListScroll}
        >
          {listLoading ? (
            <Loading />
          ) : rows.length === 0 ? (
            // La pista depende de la vista: «no hay nada» en la lista de
            // descartadas parece una avería, y es lo normal el primer día.
            <Empty
              title={EMPTY_VIEW[view.status].title}
              hint={
                view.favorites
                  ? "Marca ofertas con la estrella para que aparezcan aquí."
                  : EMPTY_VIEW[view.status].hint
              }
            />
          ) : touch ? (
            /* Una `<ul>` de `<li>` y no la tabla con `display: block`: una tabla
               desmontada con CSS pierde su semántica sin avisar, y lo que hay
               aquí ya no son catorce columnas sino un registro por fila. */
            <ul className="offer-list">
              {rows.map((offer, index) => (
                <OfferRow
                  key={offer.id}
                  offer={offer}
                  median={shownMedian}
                  leaving={leaving.has(offer.id)}
                  favBusy={favBusyId === offer.id}
                  peek={hint.peek && index === 0}
                  onPeekEnd={hint.seen}
                  onSwipeOpen={hint.seen}
                  onOpen={openOffer}
                  onFavorite={toggleFavorite}
                  onMove={move}
                />
              ))}
            </ul>
          ) : (
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <span className="sr-only">Favorito</span>
                  </th>
                  <SortTh column="ai" label="IA" sort={view.sort} onSort={onSort} width={56} />
                  <th>Marca</th>
                  <th>Modelo</th>
                  <th>Versión</th>
                  <th>Ubicación</th>
                  <SortTh column="price" label="Precio" sort={view.sort} onSort={onSort} numeric />
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
                  <SortTh column="year" label="Año" sort={view.sort} onSort={onSort} numeric />
                  <SortTh column="km" label="Km" sort={view.sort} onSort={onSort} numeric />
                  {/* Tampoco ordena: es una métrica derivada que el backend no
                      tiene en columna, y ordenar solo lo ya cargado daría un
                      orden que se deshace con cada tramo que llega. */}
                  <th className="num">Km / año</th>
                  {/* Sin rótulo visible: la columna es una marca de una letra y
                      el rótulo pedía el triple de ancho que su propio contenido. */}
                  <th style={{ width: 44 }}>
                    <span className="sr-only">Combustible</span>
                  </th>
                  <SortTh column="value" label="Valor" sort={view.sort} onSort={onSort} numeric />
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
                    onClick={() => openOffer(offer)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openOffer(offer);
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
                        panel de detalle. */}
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
                      <VsMedian
                        price={offer.price}
                        median={shownMedian}
                        fallback={<span className="muted">—</span>}
                      />
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
                        no lo tiene, porque una «D» suelta no se lee sola. En el
                        móvil no hay marca: va la palabra entera en la fila. */}
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

      {view.offer !== null ? (
        <OfferDetail
          id={view.offer}
          known={openRow}
          onClose={closeOffer}
          onMove={(offer, target) => {
            // La ficha se cierra al mover: la oferta que describe acaba de salir
            // de la lista que hay detrás, y dejarla abierta sobre algo que ya no
            // está ahí es peor que no haberla abierto.
            closeOffer();
            void move(offer, target);
          }}
        />
      ) : null}

      {sheet === "filters" ? (
        <FilterSheet
          view={view}
          models={models.data ?? []}
          dealers={dealers.data ?? []}
          domains={domains}
          fallbackStats={stats.data}
          onClose={() => setSheet(null)}
          onApply={(next) => {
            setSheet(null);
            commit(next);
          }}
          onOpenOffer={openOffer}
        />
      ) : null}

      {sheet === "sort" ? (
        <SortSheet
          sort={view.sort}
          onClose={() => setSheet(null)}
          onPick={(token) => {
            setSheet(null);
            commit({ ...view, sort: token });
          }}
        />
      ) : null}

      <ToastStack {...toasts} />
    </>
  );

  function onSort(token: string) {
    commit({ ...view, sort: token });
  }
}

/** Los filtros tal como los quiere la API, sin el orden ni la ficha abierta:
 *  `viewFilters` vive en `lib/offerParams` porque lo comparten la lista, sus
 *  métricas y el contador en vivo de la hoja de filtros. */
const viewFiltersOf = viewFilters;

/** Cuántos filtros hay puestos: el número del chip «Filtros». */
function countFilters(view: OffersView): number {
  let count = 0;
  if (view.q.trim()) count += 1;
  if (view.model) count += 1;
  if (view.dealer) count += 1;
  if (view.condition) count += 1;
  if (view.priceMin !== null || view.priceMax !== null) count += 1;
  if (view.yearMin !== null || view.yearMax !== null) count += 1;
  if (view.tracked) count += 1;
  if (view.favorites) count += 1;
  if (view.status !== DEFAULT_VIEW.status) count += 1;
  return count;
}

/* ------------------------------------------------------------------------- */

/**
 * Acotación por rango en el escritorio: dos pomos sobre el recorrido real del
 * conjunto, más dos casillas para teclear la cifra exacta.
 *
 * Vive en un panel plegable y no suelto en la barra porque un deslizador
 * utilizable necesita unos 240 px y una fila de filtros no puede pagarlos por un
 * control que se toca una vez por sesión. Plegado ocupa lo que un botón y enseña
 * el rango puesto, así que no hace falta abrirlo para saber qué hay acotado.
 *
 * En el móvil no hay fila de filtros y este control se dibuja a ancho completo
 * dentro de la hoja: es el mismo `RangeSlider`, sin panel que lo esconda.
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
  function commitRange([lo, hi]: [number, number]) {
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
          onChange={commitRange}
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

/** Barato respecto a la referencia es bueno, caro es malo; ±5 % es ruido. */
function comparisonTone(pct: number | null): string {
  if (pct === null) return "none";
  if (pct <= -5) return "positive";
  if (pct >= 5) return "negative";
  return "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "origen desconocido";
  }
}

/**
 * Vista del anuncio: foto y titular.
 *
 * No es un iframe de la página real a propósito: los portales de coches sirven
 * `X-Frame-Options`/`frame-ancestors` y el iframe saldría en blanco.
 *
 * **Ya no es un enlace.** Toda la tarjeta lo era, y con ella el viaje de ida a
 * Safari se disparaba con un toque mal puesto sobre la foto —el objeto más
 * grande de la ficha— justo cuando lo que se estaba haciendo era leerla. Salir
 * de la app es ahora una acción explícita y única, con su botón y con el host a
 * la vista.
 */
function OfferPreview({ offer }: { offer: Offer }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(offer.image_url) && !imageFailed;

  return (
    <figure className="offer-preview static">
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
      <figcaption className="offer-preview-body">
        <span className="offer-preview-title">{offer.title}</span>
        <span className="tiny muted">
          {offer.dealer.name} · {hostOf(offer.url)}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * La salida al anuncio del dealer.
 *
 * Una sola acción explícita, con el host escrito en el propio rótulo: lo que se
 * está a punto de hacer es dejar la app, y en una PWA instalada eso significa
 * abrir la superlativa in-app, que tiene su botón «Done» pero no siempre
 * devuelve el contexto. Por eso el estado de la lista ya está en la URL antes de
 * salir, y por eso hay un «Copiar enlace» para quien prefiera abrirlo en Safari
 * de verdad.
 *
 * `target="_blank" rel="noopener"` y **sin** `-webkit-touch-callout: none`: la
 * pulsación larga y su «Abrir en Safari» son la única ruta fiable al navegador
 * real, y quitarla por estética la cerraría.
 */
function OfferExit({ offer }: { offer: Offer }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(offer.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Sin permiso de portapapeles no hay nada que hacer desde aquí: la URL
      // completa está escrita en «Procedencia», al final de la ficha.
      setCopied(false);
    }
  }

  return (
    <div className="offer-exit">
      <a
        className="btn btn-primary offer-exit-open"
        href={offer.url}
        target="_blank"
        rel="noopener"
      >
        Abrir el anuncio ↗ {hostOf(offer.url)}
      </a>
      <button type="button" className="btn offer-exit-copy" onClick={copy}>
        {copied ? "Enlace copiado" : "Copiar enlace"}
      </button>
      <p className="tiny muted offer-exit-note" role="status">
        {copied
          ? "Enlace copiado al portapapeles."
          : "Salir abre el anuncio fuera de la app. El filtro y la ficha están en la dirección, así que al volver la lista sigue igual."}
      </p>
    </div>
  );
}

/**
 * Payload crudo del scraper. Vive en su propio componente para que la petición
 * salga al desplegar y no al abrir la ficha: casi nadie lo mira.
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
 * La ficha, resuelta desde la URL.
 *
 * Si la oferta está en la lista cargada se usa esa —así el favorito que se acaba
 * de marcar se ve al abrirla—; si no está, se pide. El segundo caso es el que
 * importa: es el arranque en frío con `?offer=8412` en la dirección, o sea la
 * vuelta desde el anuncio del dealer después de que iOS haya matado la app.
 */
function OfferDetail({
  id,
  known,
  onClose,
  onMove,
}: {
  id: number;
  known: Offer | null;
  onClose: () => void;
  onMove: (offer: Offer, target: OfferStatus) => void;
}) {
  const missing = known === null;
  const remote = useAsync<Offer | null>(
    () => (missing ? api.get<Offer>(`/offers/${id}`) : Promise.resolve(null)),
    [id, missing],
  );
  const offer = known ?? remote.data;

  if (!offer) {
    return (
      <Drawer wide title="Oferta" onClose={onClose}>
        {remote.error ? (
          <Banner kind="error">{remote.error}</Banner>
        ) : (
          <Loading label="Cargando la oferta…" />
        )}
      </Drawer>
    );
  }

  return <OfferSheet offer={offer} onClose={onClose} onMove={onMove} />;
}

/**
 * Todo lo que se sabe de una oferta, en tres franjas de densidad distinta.
 *
 * El orden no es el del esquema, es el de la pregunta: **¿merece la pena abrir
 * esto?** Por eso el precio, las desviaciones y las dos puntuaciones van arriba
 * del todo, sin scroll; la ficha del coche es la evidencia que las respalda; y
 * la procedencia (fuente, IDs, fechas de scrapeo, `raw`) va plegada, porque es
 * dato de diagnóstico y no de decisión.
 */
function OfferSheet({
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
         ficha y de abrir el anuncio, que es justo cuando se descubre que el
         coche ya no está. Es el sitio donde más se va a pulsar «No disponible»,
         así que no puede depender de reconocer un dibujo. */
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
            {/* «del modelo» no es adorno: la lista enseña otra desviación, la de
                las filas en pantalla, y sin esto son dos números distintos con
                el mismo nombre. */}
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
                por edad y km, y a cuánto está la oferta de esa cifra. */}
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
          <div className="offer-evidence-main">
            <OfferPreview offer={offer} />
            <OfferExit offer={offer} />
          </div>

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

        {/* El perfil va detrás de la ficha y no pegado al veredicto: sus ejes son
            el año, los kilómetros y el precio que se acaban de leer ahí arriba,
            así que aquí lo que hace es contestar «¿y eso es mucho o poco?» sobre
            unas cifras que el lector todavía tiene en la cabeza. */}
        <div className="fact-group">
          <p className="fact-label">Perfil frente a sus comparables</p>
          <OfferProfile offer={offer} />
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
          ) : (
            <PriceHistory points={points} />
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

