/**
 * El estado de la vista de ofertas, escrito en la URL.
 *
 * Vive fuera del componente por una razón concreta del móvil: el recorrido
 * normal de esta pantalla acaba en el anuncio del dealer, y ese viaje —salir a
 * Safari, volver— es justo donde iOS congela y a menudo mata el contexto de la
 * app. Con once `useState` dentro del componente, volver significaba empezar de
 * cero; con la URL como capa durable, volver es recargar la misma lista.
 *
 * Reglas de escritura:
 *
 * - **Solo se escribe lo que no es el valor por defecto.** Una URL con trece
 *   parámetros, once de ellos vacíos, no se puede leer ni compartir.
 * - **Los nombres son los de la API** (`price_min`, `year_max`, `status`) salvo
 *   donde la API y la vista no coinciden. Un parámetro que se llama igual en la
 *   barra de direcciones y en la petición se depura en un tercio del tiempo.
 * - **El orden no es un filtro.** `clearedView` no lo toca, igual que el
 *   `clearFilters()` de antes: quien limpia quiere ver todo el catálogo, no
 *   verlo en otro orden.
 */
import { formatKm, formatPrice } from "./format";
import type { OfferStatus } from "../types";

/* -------------------------------------------------------------------------- *
 * Orden
 *
 * Estaba en `Offers.tsx` y se muda aquí porque ahora lo leen tres sitios: las
 * cabeceras que ordenan (escritorio), la hoja de orden (móvil) y el chip del
 * riel que enseña el orden puesto. El token viaja en la URL, así que su
 * vocabulario es parte del estado de la vista.
 * -------------------------------------------------------------------------- */

export type SortDir = "asc" | "desc";

export interface SortColumn {
  /** Token de la API para cada sentido. `null` es un sentido que no se sirve. */
  asc: string | null;
  desc: string | null;
  /** Sentido del primer clic: de los dos, el que se pide de verdad. */
  first: SortDir;
  /** La dimensión, en palabras. En la tabla va al `title`; en la hoja de orden
   *  es el rótulo, porque ahí sí hay sitio para una frase. */
  what: string;
  /** Se ordena en Python sobre un tope de filas, y hay que decirlo. */
  capped?: boolean;
  /** Cómo se dice cada sentido en la hoja de orden. «Precio ascendente» no lo
   *  entiende nadie; «de menor a mayor» sí. */
  ascWord?: string;
  descWord?: string;
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
export const SORT_COLUMNS = {
  ai: {
    asc: "ai_score",
    desc: null,
    first: "asc",
    what: "puesto que le da la IA",
    capped: true,
    ascWord: "mejor puesto primero",
  },
  price: {
    asc: "price",
    desc: "-price",
    first: "asc",
    what: "precio",
    ascWord: "de menor a mayor",
    descWord: "de mayor a menor",
  },
  year: {
    asc: "year",
    desc: "-year",
    first: "desc",
    what: "año",
    ascWord: "del más antiguo al más nuevo",
    descWord: "del más nuevo al más antiguo",
  },
  km: {
    asc: "mileage_km",
    desc: "-mileage_km",
    first: "asc",
    what: "kilómetros",
    ascWord: "de menos a más",
    descWord: "de más a menos",
  },
  value: {
    asc: null,
    desc: "value_score",
    first: "desc",
    what: "puntuación de valor",
    capped: true,
    descWord: "mejor puntuación primero",
  },
} satisfies Record<string, SortColumn>;

export type SortColumnId = keyof typeof SORT_COLUMNS;

export const SORT_IDS = Object.keys(SORT_COLUMNS) as SortColumnId[];

/** El orden por defecto de la vista: los mejores chollos primero. */
export const DEFAULT_SORT: string = SORT_COLUMNS.value.desc;

export const CAP_HINT =
  "Ordenar por puntuación evalúa hasta 500 ofertas coincidentes; para catálogos más grandes, filtra por modelo o dealer.";

/** En qué sentido está ordenada esta columna, o `null` si no es la ordenada. */
export function activeDir(column: SortColumn, sort: string): SortDir | null {
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
export function nextDir(column: SortColumn, current: SortDir | null): SortDir {
  const wanted: SortDir =
    current === null ? column.first : current === "asc" ? "desc" : "asc";
  return column[wanted] === null ? (current ?? column.first) : wanted;
}

export interface SortOption {
  token: string;
  /** «Precio · de menor a mayor». La dimensión primero, el sentido después. */
  label: string;
  capped: boolean;
}

/**
 * Los sentidos servidos, uno por fila de la hoja de orden.
 *
 * Cinco columnas y ocho sentidos: la hoja los enseña todos en vez de esconder el
 * inverso detrás de un segundo toque sobre el que ya está elegido. En una tabla
 * el segundo clic sobre la cabecera es el idioma; en una lista de selección
 * única no hay cabecera que volver a pulsar, y «Precio» a secas no dice si sube
 * o baja.
 */
export const SORT_OPTIONS: SortOption[] = SORT_IDS.flatMap((id) => {
  const column: SortColumn = SORT_COLUMNS[id];
  const capped = column.capped === true;
  const first = column.first;
  const dirs: SortDir[] = first === "asc" ? ["asc", "desc"] : ["desc", "asc"];
  return dirs.flatMap((dir) => {
    const token = column[dir];
    if (token === null) return [];
    const word = dir === "asc" ? column.ascWord : column.descWord;
    const what = column.what.charAt(0).toUpperCase() + column.what.slice(1);
    return [{ token, label: word ? `${what} · ${word}` : what, capped }];
  });
});

/** El orden puesto, en corto, para el chip del riel. */
export function sortChipLabel(sort: string): string {
  for (const id of SORT_IDS) {
    const column: SortColumn = SORT_COLUMNS[id];
    const dir = activeDir(column, sort);
    if (dir === null) continue;
    const short =
      id === "value" ? "Valor" : id === "ai" ? "IA" : id === "km" ? "Km" : column.what;
    const name = short.charAt(0).toUpperCase() + short.slice(1);
    return `${name} ${dir === "asc" ? "↑" : "↓"}`;
  }
  return "Orden";
}

/* -------------------------------------------------------------------------- *
 * El estado de la vista
 * -------------------------------------------------------------------------- */

export interface OffersView {
  q: string;
  model: string;
  dealer: string;
  condition: string;
  /** `null` es «sin límite», no cero: un mínimo de 0 € filtraría igual que no
   *  filtrar pero dejaría el control marcado como activo. */
  priceMin: number | null;
  priceMax: number | null;
  yearMin: number | null;
  yearMax: number | null;
  tracked: boolean;
  favorites: boolean;
  /** Los tres estados son tres listas excluyentes, no un interruptor. */
  status: OfferStatus;
  sort: string;
  /** La oferta cuyo detalle está abierto. Es una entrada de historial aparte. */
  offer: number | null;
}

export const DEFAULT_VIEW: OffersView = {
  q: "",
  model: "",
  dealer: "",
  condition: "",
  priceMin: null,
  priceMax: null,
  yearMin: null,
  yearMax: null,
  tracked: false,
  favorites: false,
  status: "active",
  sort: DEFAULT_SORT,
  offer: null,
};

const STATUSES: OfferStatus[] = ["active", "dismissed", "expired"];

const SORT_TOKENS = new Set(SORT_OPTIONS.map((option) => option.token));

function num(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * La URL, leída.
 *
 * Todo lo que no se entiende se ignora y se cae al valor por defecto: una URL
 * pegada a mano con `status=borradas` tiene que enseñar la lista activa, no una
 * pantalla rota. Es la misma razón por la que el orden se valida contra los
 * tokens servidos y no se pasa tal cual a la API.
 */
export function readView(params: URLSearchParams): OffersView {
  const status = params.get("status") as OfferStatus | null;
  const sort = params.get("sort");
  const offer = num(params.get("offer"));

  return {
    q: params.get("q") ?? "",
    model: params.get("model") ?? "",
    dealer: params.get("dealer") ?? "",
    condition: params.get("condition") ?? "",
    priceMin: num(params.get("price_min")),
    priceMax: num(params.get("price_max")),
    yearMin: num(params.get("year_min")),
    yearMax: num(params.get("year_max")),
    tracked: params.get("tracked") === "1",
    favorites: params.get("fav") === "1",
    status: status !== null && STATUSES.includes(status) ? status : "active",
    sort: sort !== null && SORT_TOKENS.has(sort) ? sort : DEFAULT_SORT,
    offer: offer !== null && offer > 0 ? offer : null,
  };
}

/** La URL, escrita. Solo lo que se aparta del valor por defecto. */
export function writeView(view: OffersView): URLSearchParams {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | null) => {
    if (value === null || value === "") return;
    params.set(key, String(value));
  };

  put("q", view.q.trim());
  put("model", view.model);
  put("dealer", view.dealer);
  put("condition", view.condition);
  put("price_min", view.priceMin);
  put("price_max", view.priceMax);
  put("year_min", view.yearMin);
  put("year_max", view.yearMax);
  if (view.tracked) params.set("tracked", "1");
  if (view.favorites) params.set("fav", "1");
  if (view.status !== "active") params.set("status", view.status);
  if (view.sort !== DEFAULT_SORT) params.set("sort", view.sort);
  put("offer", view.offer);

  return params;
}

/**
 * Los filtros tal como los quiere la API.
 *
 * Un único objeto para la lista y para sus métricas: si cada llamada armara los
 * suyos, las medias acabarían describiendo otro conjunto. El orden **no** entra
 * aquí —`/offers/stats` no lo acepta y no cambia el conjunto, solo su orden—, y
 * la oferta abierta tampoco: abrir una ficha no filtra la lista de detrás.
 */
export function viewFilters(view: OffersView): Record<string, string | number | boolean | undefined> {
  return {
    q: view.q.trim() || undefined,
    car_model_id: view.model || undefined,
    dealer_id: view.dealer || undefined,
    condition: view.condition || undefined,
    min_price: view.priceMin ?? undefined,
    max_price: view.priceMax ?? undefined,
    min_year: view.yearMin ?? undefined,
    max_year: view.yearMax ?? undefined,
    tracked_only: view.tracked || undefined,
    favorites_only: view.favorites || undefined,
    status: view.status,
  };
}

/** Una clave escalar por conjunto de filtros: sirve de dependencia de efecto y
 *  de índice de `sessionStorage`. La oferta abierta y el orden quedan fuera del
 *  conjunto pero dentro de la clave del orden, así que se pasan aparte. */
export function filterKey(view: OffersView): string {
  return [
    view.q.trim(),
    view.model,
    view.dealer,
    view.condition,
    view.priceMin,
    view.priceMax,
    view.yearMin,
    view.yearMax,
    view.tracked ? 1 : 0,
    view.favorites ? 1 : 0,
    view.status,
  ].join("|");
}

export function isFiltered(view: OffersView): boolean {
  return filterKey(view) !== filterKey(DEFAULT_VIEW);
}

/** Devuelve la vista a su estado por defecto. El orden no es un filtro y se
 *  queda; la oferta abierta tampoco se cierra por limpiar los filtros. */
export function clearedView(view: OffersView): OffersView {
  return { ...DEFAULT_VIEW, sort: view.sort, offer: view.offer };
}

/* -------------------------------------------------------------------------- *
 * Los chips del riel
 * -------------------------------------------------------------------------- */

export interface FilterChip {
  key: string;
  /** Lo que se lee en el chip: el valor, no el nombre del campo. «Audi A3», no
   *  «Modelo: Audi A3» — el riel se recorre con el pulgar y cada palabra que no
   *  es el valor es una palabra que empuja al siguiente chip fuera de pantalla. */
  label: string;
  /** El nombre completo sí va al nombre accesible, que no compite por ancho. */
  aria: string;
  /** La vista sin este filtro. Quitar uno no toca a los demás. */
  without: OffersView;
}

/** Nombres legibles de los dos filtros que son un id. */
export interface ChipNames {
  model?: string;
  dealer?: string;
  condition?: string;
  status?: string;
}

/**
 * Un chip por filtro **aplicado**, en el orden en que se leen: primero lo que
 * acota el catálogo (búsqueda, modelo, dealer), después las bandas numéricas y
 * al final los ámbitos.
 */
export function filterChips(view: OffersView, names: ChipNames): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: string, label: string, aria: string, without: Partial<OffersView>) =>
    chips.push({ key, label, aria, without: { ...view, ...without } });

  if (view.q.trim()) {
    add("q", `«${view.q.trim()}»`, `Quitar la búsqueda ${view.q.trim()}`, { q: "" });
  }
  if (view.model) {
    const label = names.model ?? "Modelo";
    add("model", label, `Quitar el filtro de modelo ${label}`, { model: "" });
  }
  if (view.dealer) {
    const label = names.dealer ?? "Dealer";
    add("dealer", label, `Quitar el filtro de dealer ${label}`, { dealer: "" });
  }
  if (view.condition) {
    const label = names.condition ?? view.condition;
    add("condition", label, `Quitar el filtro de estado ${label}`, { condition: "" });
  }
  if (view.priceMin !== null || view.priceMax !== null) {
    // El nombre accesible tiene que contener lo que se lee en el chip (WCAG
    // 2.5.3): sin el valor, «toca 12.000 € – 30.000 €» por voz no encuentra
    // nada, y el anuncio se calla justo el dato que está filtrando.
    const label = rangeLabel(view.priceMin, view.priceMax, formatPrice);
    add("price", label, `Quitar la banda de precio ${label}`, {
      priceMin: null,
      priceMax: null,
    });
  }
  if (view.yearMin !== null || view.yearMax !== null) {
    const label = rangeLabel(view.yearMin, view.yearMax, formatYear);
    add("year", label, `Quitar la banda de año ${label}`, {
      yearMin: null,
      yearMax: null,
    });
  }
  if (view.tracked) add("tracked", "Seguidos", "Quitar el filtro de modelos seguidos", { tracked: false });
  if (view.favorites) add("fav", "★ Favoritos", "Quitar el filtro de favoritos", { favorites: false });
  if (view.status !== "active") {
    const label = names.status ?? view.status;
    add("status", label, `${label}: volver a las ofertas activas`, { status: "active" });
  }

  return chips;
}

/** Los años se escriben enteros: «2.018» sería un precio, no un año. */
export const formatYear = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : String(value);

/** «12.000 – 30.000 €», «hasta 30.000 €», «desde 12.000 €». */
export function rangeLabel(
  min: number | null,
  max: number | null,
  format: (value: number | null) => string,
): string {
  if (min !== null && max !== null) return `${format(min)} – ${format(max)}`;
  if (min !== null) return `desde ${format(min)}`;
  if (max !== null) return `hasta ${format(max)}`;
  return "";
}

/** Kilómetros escritos, por si un chip de banda los necesita. */
export const formatKmShort = formatKm;

/* -------------------------------------------------------------------------- *
 * Comodidad para el cambio de app
 *
 * La URL es la capa durable; esto es solo el consuelo de volver donde estabas.
 * En `sessionStorage` y **nunca** en `localStorage`: un estado que revive al
 * matar la app le quita al usuario su único gesto de recuperación, y la pregunta
 * de este producto es «¿ha bajado algo interesante hoy?», no «¿qué filtré el
 * jueves?».
 * -------------------------------------------------------------------------- */

export interface ListPlace {
  /** Píxeles de scroll dentro del carril de la lista. */
  top: number;
  /** Tramos de 50 que había traídos, para volver con la lista igual de larga. */
  chunks: number;
}

const PLACE_PREFIX = "nr.offers.";
/** Tope de tramos que se rehidratan de una vez: cuatro son 200 filas, que ya es
 *  más de lo que nadie recorre antes de salir al anuncio, y evita que volver a
 *  la app dispare una petición de mil filas. */
export const MAX_RESTORE_CHUNKS = 4;

export function readPlace(key: string): ListPlace | null {
  try {
    const raw = sessionStorage.getItem(PLACE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ListPlace>;
    const top = Number(parsed.top);
    const chunks = Number(parsed.chunks);
    if (!Number.isFinite(top) || !Number.isFinite(chunks)) return null;
    return { top: Math.max(0, top), chunks: Math.min(MAX_RESTORE_CHUNKS, Math.max(1, chunks)) };
  } catch {
    // Modo privado, cuota llena o JSON corrupto: se pierde la comodidad, no la
    // pantalla.
    return null;
  }
}

export function writePlace(key: string, place: ListPlace): void {
  try {
    sessionStorage.setItem(PLACE_PREFIX + key, JSON.stringify(place));
  } catch {
    /* nada que hacer: es una comodidad, no un dato */
  }
}
