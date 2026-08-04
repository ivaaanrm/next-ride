import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { ScrapingConfigDrawer } from "../components/ScrapingConfigDrawer";
import { useTouchLayout } from "../components/SwipeRow";
import { Banner, Chip, Drawer, Empty, Loading, Score, Toggle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import {
  formatDateTime,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  VERDICT_LABELS,
  verdictTone,
} from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import type { CarModelGroup, CarModelWithStats, RankingRunDetail } from "../types";

const POLL_MS = 3000;

/**
 * Qué está editando el panel de seguimiento.
 *
 * `group` aplica los mismos criterios a todas las versiones del binomio, porque
 * el seguimiento vive en `car_models` y «sigo el Audi A3» son veintitrés
 * seguimientos. El PVP de referencia se queda fuera de ese caso —es de la
 * versión, y un RS3 no comparte precio de catálogo con un 1.0 TFSI— y solo se
 * edita desde `variant`.
 */
type TrackTarget =
  | { kind: "pick" }
  | { kind: "variant"; model: CarModelWithStats }
  | { kind: "group"; group: CarModelGroup };

/** Identidad de lo que se está editando, para remontar el panel al cambiarla. */
const trackingKey = (target: TrackTarget): string =>
  target.kind === "group"
    ? `group:${target.group.key}`
    : target.kind === "variant"
      ? `variant:${target.model.id}`
      : "pick";

/** «las 23 versiones» / «la versión»: los botones hablan de todas a la vez. */
const theVersions = (count: number) => (count === 1 ? "la versión" : `las ${count} versiones`);

const offersOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "oferta" : "ofertas"}`;

const versionsOf = (count: number) =>
  `${formatNumber(count)} ${count === 1 ? "versión" : "versiones"}`;

const dealersOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "dealer" : "dealers"}`;

/**
 * Qué dice y qué hace el botón de seguimiento del binomio.
 *
 * Vive aquí y no en la fila porque lo usan las dos: la tabla del escritorio, que
 * cuelga la explicación de un `title`, y la ficha táctil, donde no hay `title`
 * que consultar y el mismo texto tiene que llegar por el nombre accesible.
 */
function followState(group: CarModelGroup): { label: string; hint: string } {
  if (group.tracked_variants === 0) {
    return { label: "Seguir", hint: `Seguir ${theVersions(group.variant_count)}` };
  }
  if (group.tracked_variants === group.variant_count) {
    return { label: "Siguiendo", hint: `Dejar de seguir ${theVersions(group.variant_count)}` };
  }
  return {
    label: `${group.tracked_variants}/${group.variant_count}`,
    hint: `Sigues ${group.tracked_variants} de ${group.variant_count} versiones. Dejarás de seguirlas.`,
  };
}

/** Mínimo y máximo en una sola ranura: «18.900–34.500 €». */
function priceRange(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === null || max === null || min === max) return formatPrice(min ?? max);
  return `${formatNumber(min)}–${formatPrice(max)}`;
}

/** El objetivo, con la marca de alcanzado que en la tabla es el color del chip. */
function targetText(target: number | null, minPrice: number | null): string | null {
  if (target === null) return null;
  const reached = minPrice !== null && minPrice <= target;
  return `objetivo ${formatPrice(target)}${reached ? " ✓" : ""}`;
}

/** Si el objetivo se ha alcanzado, dicho con palabras. En la tabla es un `title`. */
function targetStatus(target: number | null, minPrice: number | null): string | undefined {
  if (target === null) return undefined;
  return minPrice !== null && minPrice <= target
    ? `Ya hay una oferta desde ${formatPrice(minPrice)}`
    : "Ninguna oferta baja todavía del objetivo";
}

/**
 * La segunda línea de la ficha del binomio, ya escrita, con ranuras fijas: lo
 * que hay para mirar, cuántas versiones son, entre qué precios se mueve y —si lo
 * hay— el objetivo. Lo que falta no deja hueco ni pone «—».
 *
 * El resto de columnas de la tabla (dealers, PVP de referencia, último ranking)
 * no cabe en una línea y vive en el panel que abre la ficha, no se pierde.
 */
function groupMeta(group: CarModelGroup): string {
  return [
    offersOf(group.active_offers),
    versionsOf(group.variant_count),
    priceRange(group.min_price, group.max_price),
    targetText(group.target_price, group.min_price),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** Lo mismo para una versión, con su estado de seguimiento delante. */
function variantMeta(variant: CarModelWithStats): string {
  return [
    variant.is_tracked ? "Siguiendo" : null,
    offersOf(variant.active_offers),
    dealersOf(variant.dealers_count),
    priceRange(variant.min_price, variant.max_price),
    targetText(variant.tracking?.target_price ?? null, variant.min_price),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Las columnas del binomio que no caben en la ficha, en el panel que la ficha
 * abre. Las dos notas —de qué se compone el PVP de referencia y si el objetivo
 * está alcanzado— son texto visible aquí y `title` en la tabla: en un móvil no
 * hay puntero que las invoque.
 */
function groupFigures(group: CarModelGroup): { label: string; value: string; note?: string }[] {
  return [
    { label: "Ofertas activas", value: formatNumber(group.active_offers) },
    { label: "Dealers", value: formatNumber(group.dealers_count) },
    { label: "Mínimo", value: formatPrice(group.min_price) },
    { label: "Mediana", value: formatPrice(group.median_price) },
    { label: "Máximo", value: formatPrice(group.max_price) },
    {
      label: "PVP de referencia",
      value: formatPrice(group.reference_price),
      note:
        group.reference_variants > 0
          ? `Mediana del PVP de ${group.reference_variants} de ${group.variant_count} versiones. El PVP se pone por versión.`
          : "Ninguna versión tiene PVP puesto.",
    },
    {
      label: "Objetivo",
      value:
        group.target_price === null
          ? "—"
          : (targetText(group.target_price, group.min_price)?.replace("objetivo ", "") ?? "—"),
      note: [
        group.tracked_variants > 1 ? "El objetivo más bajo de las versiones que sigues" : null,
        targetStatus(group.target_price, group.min_price) ?? null,
      ]
        .filter((part): part is string => part !== null)
        .join(". "),
    },
    {
      label: "Último ranking",
      value: group.last_ranked_at ? formatDateTime(group.last_ranked_at) : "—",
    },
  ];
}

/**
 * Pliega el mismo criterio de varias versiones: el valor si todas coinciden y,
 * si no, `null` más la señal de que discrepan. Hacen falta las dos cosas: un
 * `null` a secas no distingue «ninguna lo tiene puesto» de «cada una el suyo».
 */
function fold<T>(values: T[]): { value: T | null; mixed: boolean } {
  if (values.length === 0) return { value: null, mixed: false };
  const [first] = values;
  const same = values.every((value) => value === first);
  return { value: same ? first : null, mixed: !same };
}

interface CurrentCriteria {
  target_price: number | null;
  max_mileage_km: number | null;
  min_year: number | null;
  notes: string | null;
  /** El binomio tiene criterios dispares, o versiones sin seguir. */
  mixed: boolean;
}

/** Con qué llega relleno el formulario de criterios. */
function currentCriteria(target: TrackTarget): CurrentCriteria {
  if (target.kind !== "group") {
    const prefs = target.kind === "variant" ? target.model.tracking : null;
    return {
      target_price: prefs?.target_price ?? null,
      max_mileage_km: prefs?.max_mileage_km ?? null,
      min_year: prefs?.min_year ?? null,
      notes: prefs?.notes ?? null,
      mixed: false,
    };
  }

  const tracked = target.group.variants
    .map((variant) => variant.tracking)
    .filter((prefs) => prefs !== null);
  const price = fold(tracked.map((prefs) => prefs.target_price));
  const mileage = fold(tracked.map((prefs) => prefs.max_mileage_km));
  const year = fold(tracked.map((prefs) => prefs.min_year));
  const note = fold(tracked.map((prefs) => prefs.notes));

  return {
    target_price: price.value,
    max_mileage_km: mileage.value,
    min_year: year.value,
    notes: note.value,
    // Discrepan entre sí, o hay versiones sin seguimiento: en los dos casos,
    // guardar cambia más de lo que el formulario está enseñando.
    mixed:
      price.mixed ||
      mileage.mixed ||
      year.mixed ||
      note.mixed ||
      (tracked.length > 0 && tracked.length < target.group.variant_count),
  };
}

export function ModelsPage() {
  const [search, setSearch] = useState("");
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Clave del binomio, o `variant:{id}`: hay un botón por fila y por versión.
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [ranking, setRanking] = useState<CarModelGroup | null>(null);
  const [tracking, setTracking] = useState<TrackTarget | null>(null);
  const [scrapingConfig, setScrapingConfig] = useState(false);
  const touch = useTouchLayout();

  const debouncedSearch = useDebounced(search);
  const groups = useAsync<CarModelGroup[]>(
    () =>
      api.get("/car-models/groups", {
        q: debouncedSearch || undefined,
        tracked_only: trackedOnly || undefined,
      }),
    [debouncedSearch, trackedOnly],
  );

  const rows = groups.data ?? [];
  const versions = rows.reduce((total, group) => total + group.variant_count, 0);

  function toggleExpanded(key: string) {
    setExpanded((open) =>
      open.includes(key) ? open.filter((other) => other !== key) : [...open, key],
    );
  }

  /** Atajo de un clic sobre el binomio entero. Los criterios, en «Criterios». */
  async function toggleGroup(group: CarModelGroup) {
    setError(null);
    setBusy(group.key);
    const ids = group.variants.map((variant) => variant.id).join(",");
    try {
      // Seguido a medias cuenta como seguido: el clic lo deja en un estado
      // conocido en vez de completar un seguimiento que nadie ha pedido.
      if (group.tracked_variants > 0) {
        await api.delete("/tracked-models/bulk", { car_model_ids: ids });
      } else {
        await api.post("/tracked-models/bulk", { car_model_ids: group.variants.map((v) => v.id) });
      }
      groups.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el seguimiento");
    } finally {
      setBusy(null);
    }
  }

  async function toggleVariant(model: CarModelWithStats) {
    setError(null);
    setBusy(`variant:${model.id}`);
    try {
      if (model.is_tracked) {
        await api.delete(`/tracked-models/${model.id}`);
      } else {
        await api.post("/tracked-models", { car_model_id: model.id });
      }
      groups.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el seguimiento");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Modelos"
        meta={
          groups.data
            ? `${formatNumber(rows.length)} modelos · ${formatNumber(versions)} versiones`
            : undefined
        }
        actions={
          <>
            <button className="btn btn-sm" onClick={() => groups.reload()}>
              Actualizar
            </button>
            <button className="btn btn-sm" onClick={() => setScrapingConfig(true)}>
              Configurar captación
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setTracking({ kind: "pick" })}>
              Seguir un modelo
            </button>
          </>
        }
      />

      <div className="content">
        <div className="filters">
          <div className="field grow">
            {/* En la mano el rótulo no informa: el marcador de posición dice
                «Marca, modelo o versión…», que es más de lo que dice «Buscar», y
                los 20 px de la etiqueta apilada eran lo que descuadraba el
                interruptor de al lado. Sigue ahí para quien no ve el campo. */}
            <label className={touch ? "sr-only" : undefined} htmlFor="q">
              Buscar
            </label>
            <input
              id="q"
              className="input"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Marca, modelo o versión…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {/* La casilla nativa mide 13 px de tinta dentro de una etiqueta de 28:
              por debajo del suelo táctil por partida doble. El interruptor dice
              lo mismo, con estado leído por `aria-pressed`, y ya vale 44 pt. */}
          {touch ? (
            <Toggle on={trackedOnly} onChange={setTrackedOnly}>
              Solo los que sigo
            </Toggle>
          ) : (
            <label className="row tiny muted" style={{ height: 28 }}>
              <input
                type="checkbox"
                checked={trackedOnly}
                onChange={(event) => setTrackedOnly(event.target.checked)}
              />
              Solo los que sigo
            </label>
          )}
        </div>

        {error ? <Banner kind="error">{error}</Banner> : null}
        {groups.error ? <Banner kind="error">{groups.error}</Banner> : null}

        {groups.loading || rows.length === 0 ? (
          <div className="table-wrap">
            {groups.loading ? (
              <Loading />
            ) : (
              <Empty
                title="Todavía no hay modelos"
                hint="Se crean automáticamente al ingestar ofertas, o a mano con «Seguir un modelo»."
              />
            )}
          </div>
        ) : touch ? (
          /* Una `<ul>` de `<li>` y no la tabla con `display: block`: una tabla
             desmontada con CSS pierde su semántica sin avisar, y lo que hay aquí
             ya no son once columnas sino un registro por fila.

             La ficha abre el panel del binomio, que en táctil lleva además sus
             cifras, sus versiones y el acceso al ranking: el desplegable de
             versiones de la tabla no cabe dentro de una lista sin volver a
             inventar una jerarquía que en 390 pt no se lee. Al lado, y solo al
             lado, el botón de seguir: es el gesto de un toque de esta pantalla y
             el único que compite con el de la ficha. */
          <ul className="record-list flush">
            {rows.map((group) => {
              const follow = followState(group);
              return (
                <li key={group.key} className="record-item split">
                  <button
                    type="button"
                    className="record-link"
                    onClick={() => setTracking({ kind: "group", group })}
                  >
                    <span className="sr-only">Ver el detalle de </span>
                    <span className="record-head">
                      <span className="record-title">{group.label}</span>
                      {/* La cifra sola se leería como «el precio»: para quien no
                          ve la columna, la palabra que la califica va detrás. */}
                      <span className="record-value">
                        {formatPrice(group.median_price)}
                        <span className="sr-only"> de mediana</span>
                      </span>
                    </span>
                    <span className="record-meta">{groupMeta(group)}</span>
                  </button>
                  <div className="record-actions">
                    {/* `on` y no `btn-primary`: seguir un modelo es un estado, no
                        la acción principal de la pantalla, y cuatro rellenos
                        sólidos en fila decían lo contrario. `aria-pressed` es lo
                        que hace que el estado también se anuncie. */}
                    <button
                      type="button"
                      className={`btn btn-sm${group.tracked_variants > 0 ? " on" : ""}`}
                      disabled={busy === group.key}
                      aria-pressed={group.tracked_variants > 0}
                      aria-label={`${follow.label}. ${follow.hint}`}
                      onClick={() => toggleGroup(group)}
                    >
                      {follow.label}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="table-wrap">
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Seguir</th>
                  <th>Modelo</th>
                  <th className="num">Ofertas</th>
                  <th className="num">Dealers</th>
                  <th className="num">Mín.</th>
                  <th className="num">Mediana</th>
                  <th className="num">Máx.</th>
                  <th className="num">PVP ref.</th>
                  <th className="num">Objetivo</th>
                  <th>Último ranking</th>
                  <th style={{ width: 210 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((group) => {
                  const open = expanded.includes(group.key);
                  const follow = followState(group);
                  return (
                    <Fragment key={group.key}>
                      <tr className="group-row">
                        <td>
                          <button
                            className={`btn btn-sm${group.tracked_variants > 0 ? " on" : ""}`}
                            disabled={busy === group.key}
                            aria-pressed={group.tracked_variants > 0}
                            onClick={() => toggleGroup(group)}
                            title={follow.hint}
                          >
                            {follow.label}
                          </button>
                        </td>
                        <td className="cell-primary">
                          <button
                            className="row-expand"
                            aria-expanded={open}
                            onClick={() => toggleExpanded(group.key)}
                            title={open ? "Plegar las versiones" : "Ver las versiones"}
                          >
                            <span className="row-expand-caret" aria-hidden="true">
                              ▸
                            </span>
                            {group.label}
                            <span className="tiny muted">
                              {group.variant_count}{" "}
                              {group.variant_count === 1 ? "versión" : "versiones"}
                            </span>
                          </button>
                        </td>
                        <td className="num">{group.active_offers}</td>
                        <td className="num cell-muted">{group.dealers_count}</td>
                        <td className="num">{formatPrice(group.min_price)}</td>
                        <td className="num" style={{ fontWeight: 500 }}>
                          {formatPrice(group.median_price)}
                        </td>
                        <td className="num cell-muted">{formatPrice(group.max_price)}</td>
                        <td
                          className="num cell-muted"
                          title={
                            group.reference_variants > 0
                              ? `Mediana del PVP de ${group.reference_variants} de ${group.variant_count} versiones. El PVP se pone por versión.`
                              : undefined
                          }
                        >
                          {formatPrice(group.reference_price)}
                          {group.reference_variants > 0 &&
                          group.reference_variants < group.variant_count ? (
                            <span className="tiny muted"> ({group.reference_variants})</span>
                          ) : null}
                        </td>
                        <td className="num">
                          <TargetCell
                            target={group.target_price}
                            minPrice={group.min_price}
                            hint={
                              group.tracked_variants > 1
                                ? "El objetivo más bajo de las versiones que sigues"
                                : undefined
                            }
                          />
                        </td>
                        <td className="cell-muted tiny">
                          {group.last_ranked_at ? formatDateTime(group.last_ranked_at) : "—"}
                        </td>
                        <td>
                          <div className="row" style={{ justifyContent: "flex-end" }}>
                            <button
                              className="btn btn-sm"
                              onClick={() => setTracking({ kind: "group", group })}
                              title={`Criterios para ${theVersions(group.variant_count)}`}
                            >
                              Criterios
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={group.active_offers === 0}
                              onClick={() => setRanking(group)}
                              title={
                                group.active_offers === 0
                                  ? "Este modelo no tiene ofertas activas"
                                  : `Ver / generar ranking con IA sobre sus ${group.active_offers} ofertas`
                              }
                            >
                              Ranking IA
                            </button>
                          </div>
                        </td>
                      </tr>

                      {open
                        ? group.variants.map((variant) => (
                            <tr key={variant.id} className="variant-row">
                              <td>
                                <button
                                  className={`btn btn-sm${variant.is_tracked ? " on" : ""}`}
                                  disabled={busy === `variant:${variant.id}`}
                                  aria-pressed={variant.is_tracked}
                                  onClick={() => toggleVariant(variant)}
                                >
                                  {variant.is_tracked ? "Siguiendo" : "Seguir"}
                                </button>
                              </td>
                              <td className="cell-clip variant-name" title={variant.display_name}>
                                {variant.trim || variant.display_name}
                              </td>
                              <td className="num">{variant.active_offers}</td>
                              <td className="num cell-muted">{variant.dealers_count}</td>
                              <td className="num">{formatPrice(variant.min_price)}</td>
                              <td className="num">{formatPrice(variant.median_price)}</td>
                              <td className="num cell-muted">{formatPrice(variant.max_price)}</td>
                              <td className="num cell-muted">
                                {formatPrice(variant.reference_price)}
                              </td>
                              <td className="num">
                                <TargetCell
                                  target={variant.tracking?.target_price ?? null}
                                  minPrice={variant.min_price}
                                />
                              </td>
                              {/* El ranking es del modelo entero: la celda es del
                                  binomio y aquí queda vacía a propósito. */}
                              <td className="cell-muted tiny">—</td>
                              <td>
                                <div className="row" style={{ justifyContent: "flex-end" }}>
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => setTracking({ kind: "variant", model: variant })}
                                    title={
                                      variant.is_tracked
                                        ? "Editar los criterios de esta versión"
                                        : "Seguir esta versión con criterios"
                                    }
                                  >
                                    Criterios
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {ranking ? (
        <RankingDrawer
          group={ranking}
          onClose={() => {
            setRanking(null);
            groups.reload();
          }}
        />
      ) : null}

      {tracking ? (
        /* La `key` remonta el panel al cambiar de objetivo: el formulario nace
           relleno con los criterios de lo que se le pasa, así que saltar del
           binomio a una de sus versiones sin remontar dejaría los valores del
           anterior dentro de los campos del siguiente. */
        <TrackModelDrawer
          key={trackingKey(tracking)}
          target={tracking}
          touch={touch}
          onPickVariant={(model) => setTracking({ kind: "variant", model })}
          onRanking={
            // Solo en táctil: en escritorio el ranking se abre desde su botón de
            // la fila, y ponerlo también aquí sería una salida nueva en una
            // pantalla que no ha pedido ninguna.
            touch && tracking.kind === "group"
              ? () => {
                  const group = tracking.group;
                  setTracking(null);
                  setRanking(group);
                }
              : undefined
          }
          onClose={() => setTracking(null)}
          onSaved={() => {
            setTracking(null);
            groups.reload();
          }}
        />
      ) : null}

      {scrapingConfig ? (
        <ScrapingConfigDrawer
          onClose={() => setScrapingConfig(false)}
          onSaved={() => {
            setScrapingConfig(false);
            groups.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */

/** Precio objetivo del seguimiento, y si ya hay una oferta por debajo. */
function TargetCell({
  target,
  minPrice,
  hint,
}: {
  target: number | null;
  minPrice: number | null;
  hint?: string;
}) {
  if (target === null) return <span className="muted">—</span>;

  const reached = minPrice !== null && minPrice <= target;
  const status = reached
    ? `Ya hay una oferta desde ${formatPrice(minPrice)}`
    : "Ninguna oferta baja todavía del objetivo";
  return (
    <Chip tone={reached ? "positive" : "neutral"} title={hint ? `${hint}. ${status}` : status}>
      {formatPrice(target)}
      {reached ? " ✓" : ""}
    </Chip>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Ranking de IA del binomio marca-modelo.
 *
 * El agente compara todas las ofertas activas del modelo, vengan de la versión
 * que vengan: es el conjunto en el que elige un comprador. Por versión no había
 * nada que rankear —casi todas tienen una sola oferta— y el veredicto salía de
 * comparar un coche consigo mismo.
 */
function RankingDrawer({
  group,
  onClose,
}: {
  group: CarModelGroup;
  onClose: () => void;
}) {
  const [run, setRun] = useState<RankingRunDetail | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "running" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [priorities, setPriorities] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const pollRef = useRef<number | null>(null);

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Carga el último ranking completado (si existe) al abrir el panel.
  useEffect(() => {
    let active = true;
    api
      .get<RankingRunDetail>("/car-model-groups/ranking", { key: group.key })
      .then((detail) => {
        if (!active) return;
        setRun(detail);
        setStatus("idle");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 404) {
          setStatus("idle");
          setMessage("Este modelo no tiene todavía ningún ranking. Genera el primero.");
        } else {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Error al cargar el ranking");
        }
      });
    return () => {
      active = false;
      stopPolling();
    };
  }, [group.key]);

  function pollRun(runId: number) {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const detail = await api.get<RankingRunDetail>(`/ranking-runs/${runId}`);
        if (detail.status === "completed") {
          stopPolling();
          setRun(detail);
          setStatus("idle");
          setMessage(null);
        } else if (detail.status === "failed") {
          stopPolling();
          setStatus("error");
          setMessage(detail.error ?? "El ranking falló");
        }
      } catch (error) {
        stopPolling();
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Error al consultar el run");
      }
    }, POLL_MS);
  }

  async function startRanking() {
    setStatus("running");
    setMessage("El agente está analizando el mercado…");
    try {
      const created = await api.post<{ id: number }>(
        "/car-model-groups/rank",
        {
          priorities: priorities.trim() || null,
          max_budget: maxBudget ? Number(maxBudget) : null,
        },
        { key: group.key },
      );
      pollRun(created.id);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "No se pudo lanzar el ranking");
    }
  }

  const running = status === "running";

  return (
    <Drawer
      title={group.label}
      subtitle={`${group.active_offers} ofertas activas de ${theVersions(
        group.variant_count,
      )} · mediana ${formatPrice(group.median_price)}`}
      onClose={onClose}
      actions={
        <button className="btn btn-sm btn-primary" disabled={running} onClick={startRanking}>
          {running ? <span className="spinner" /> : null}
          {run ? "Regenerar" : "Generar ranking"}
        </button>
      }
    >
      <div className="card">
        <p className="card-title">Contexto para el agente (opcional)</p>
        <div className="stack">
          <div className="field">
            <label htmlFor="priorities">Qué priorizas</label>
            <textarea
              id="priorities"
              className="textarea"
              placeholder="Ej: bajo kilometraje, garantía oficial, prefiero automático"
              value={priorities}
              onChange={(event) => setPriorities(event.target.value)}
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label htmlFor="budget">Presupuesto máx. (€)</label>
            <input
              id="budget"
              className="input"
              type="number"
              min={0}
              step={500}
              value={maxBudget}
              onChange={(event) => setMaxBudget(event.target.value)}
            />
          </div>
        </div>
      </div>

      {message ? (
        <Banner kind={status === "error" ? "error" : "info"}>
          {running ? <span className="spinner" style={{ marginRight: 6 }} /> : null}
          {message}
        </Banner>
      ) : null}

      {status === "loading" ? <Loading /> : null}

      {run ? (
        <>
          {run.summary ? (
            <div className="card">
              <p className="card-title">Resumen del agente</p>
              <p style={{ margin: 0 }}>{run.summary}</p>
              <p className="tiny muted" style={{ marginTop: 10, marginBottom: 0 }}>
                {run.model_used} · esfuerzo {run.effort} · {run.iterations} iteraciones ·{" "}
                {formatNumber(run.input_tokens)} tokens de entrada /{" "}
                {formatNumber(run.output_tokens)} de salida · {formatDateTime(run.created_at)}
              </p>
            </div>
          ) : null}

          {run.tool_trace?.length ? (
            <details className="card">
              <summary className="card-title" style={{ cursor: "pointer", marginBottom: 0 }}>
                Traza de herramientas ({run.tool_trace.length})
              </summary>
              <ol className="tiny mono muted" style={{ paddingLeft: 18, marginBottom: 0 }}>
                {run.tool_trace.map((step, index) => (
                  <li key={index}>
                    {step.tool}
                    {Object.keys(step.input ?? {}).length
                      ? ` ${JSON.stringify(step.input)}`
                      : ""}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          <div>
            <p className="section-title">Ranking ({run.items.length})</p>
            <div className="stack">
              {run.items.map((item) => (
                <article key={item.id} className="ranked-item">
                  <div className="ranked-head">
                    <span className={`rank-badge${item.rank <= 3 ? " top" : ""}`}>
                      {item.rank}
                    </span>
                    <span className="ranked-title" title={item.offer?.title}>
                      {item.offer?.title ?? `Oferta #${item.offer_id}`}
                    </span>
                    <div className="spacer" />
                    <Chip tone={verdictTone(item.verdict)}>{VERDICT_LABELS[item.verdict]}</Chip>
                    <Score value={item.score} />
                  </div>

                  <div className="row row-wrap tiny muted" style={{ marginBottom: 6 }}>
                    <span>{item.offer?.dealer.name}</span>
                    <span>·</span>
                    <strong style={{ color: "var(--text)" }}>
                      {formatPrice(item.offer?.price)}
                    </strong>
                    <span>·</span>
                    <span>{item.offer?.year ?? "—"}</span>
                    <span>·</span>
                    <span>{formatKm(item.offer?.mileage_km)}</span>
                    {item.offer?.metrics.price_vs_median_pct !== null &&
                    item.offer?.metrics.price_vs_median_pct !== undefined ? (
                      <>
                        <span>·</span>
                        <span>
                          {formatPct(item.offer.metrics.price_vs_median_pct, true)} vs mediana
                        </span>
                      </>
                    ) : null}
                    {item.offer ? (
                      <>
                        <span>·</span>
                        <a
                          className="cell-link"
                          href={item.offer.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ver oferta ↗
                        </a>
                      </>
                    ) : null}
                  </div>

                  {item.reasoning ? <p className="ranked-reason">{item.reasoning}</p> : null}

                  {item.pros?.length || item.cons?.length ? (
                    <div className="pros-cons">
                      <div>
                        <div className="label">A favor</div>
                        <ul>
                          {(item.pros ?? []).map((pro, index) => (
                            <li key={index}>{pro}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="label">En contra</div>
                        <ul>
                          {(item.cons ?? []).map((con, index) => (
                            <li key={index}>{con}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Panel único para seguir: elegir un modelo del catálogo o crearlo al vuelo, y
 * fijar los criterios (precio objetivo, km, año, notas) en el mismo paso.
 *
 * Antes eran tres pasos desconectados —crear el modelo, buscarlo en la tabla,
 * pulsar «Seguir»— y los criterios no había forma de tocarlos desde la UI.
 *
 * Sobre un binomio marca-modelo hace lo mismo, pero de una vez sobre todas sus
 * versiones. Ahí no aparece el PVP de referencia: es de la versión, y ponerle a
 * las veintitrés el precio de catálogo de una sola falsearía el descuento de
 * cada una de sus ofertas.
 */
function TrackModelDrawer({
  target,
  touch = false,
  onPickVariant,
  onRanking,
  onClose,
  onSaved,
}: {
  target: TrackTarget;
  /** Por debajo de 860 px el panel es además el detalle del binomio: recoge las
   *  columnas de la tabla que no caben en la ficha y el acceso a sus versiones y
   *  a su ranking. En escritorio esas tres cosas están en la fila y el panel se
   *  queda exactamente como estaba. */
  touch?: boolean;
  onPickVariant?: (model: CarModelWithStats) => void;
  onRanking?: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const group = target.kind === "group" ? target.group : null;
  const model = target.kind === "variant" ? target.model : null;
  const current = currentCriteria(target);

  const [source, setSource] = useState<"existing" | "new">("existing");
  const [picked, setPicked] = useState<CarModelWithStats | null>(model);
  const [search, setSearch] = useState("");

  const [make, setMake] = useState("");
  const [modelName, setModelName] = useState("");
  const [trim, setTrim] = useState("");

  const [referencePrice, setReferencePrice] = useState(
    model?.reference_price != null ? String(model.reference_price) : "",
  );
  const [targetPrice, setTargetPrice] = useState(
    current.target_price != null ? String(current.target_price) : "",
  );
  const [maxMileage, setMaxMileage] = useState(
    current.max_mileage_km != null ? String(current.max_mileage_km) : "",
  );
  const [minYear, setMinYear] = useState(
    current.min_year != null ? String(current.min_year) : "",
  );
  const [notes, setNotes] = useState(current.notes ?? "");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const picking = target.kind === "pick";
  // El buscador solo hace falta cuando no viene nada fijado desde la tabla.
  const debouncedSearch = useDebounced(search);
  const results = useAsync<CarModelWithStats[]>(
    () =>
      picking && source === "existing"
        ? api.get("/car-models", { q: debouncedSearch || undefined })
        : Promise.resolve([]),
    [picking, source, debouncedSearch],
  );

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!group && source === "existing" && picked === null) {
      setError("Elige un modelo del catálogo o crea uno nuevo.");
      return;
    }

    setBusy(true);
    try {
      const criteria = {
        target_price: numberOrNull(targetPrice),
        max_mileage_km: numberOrNull(maxMileage),
        min_year: numberOrNull(minYear),
        notes: notes.trim() || null,
      };

      if (group) {
        await api.post("/tracked-models/bulk", {
          ...criteria,
          car_model_ids: group.variants.map((variant) => variant.id),
        });
      } else if (source === "new") {
        await api.post("/tracked-models", {
          ...criteria,
          make: make.trim(),
          model: modelName.trim(),
          trim: trim.trim(),
          reference_price: numberOrNull(referencePrice),
        });
      } else if (picked) {
        // El PVP de referencia es del modelo (compartido), no del seguimiento.
        const nextReference = numberOrNull(referencePrice);
        if (nextReference !== (picked.reference_price ?? null)) {
          await api.patch(`/car-models/${picked.id}`, { reference_price: nextReference });
        }
        await api.post("/tracked-models", { ...criteria, car_model_id: picked.id });
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el seguimiento");
    } finally {
      setBusy(false);
    }
  }

  async function untrack() {
    setError(null);
    setBusy(true);
    try {
      if (group) {
        await api.delete("/tracked-models/bulk", {
          car_model_ids: group.variants.map((variant) => variant.id).join(","),
        });
      } else if (picked) {
        await api.delete(`/tracked-models/${picked.id}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dejar de seguir");
    } finally {
      setBusy(false);
    }
  }

  const alreadyTracked = group ? group.tracked_variants > 0 : (picked?.is_tracked ?? false);
  const versions = group ? theVersions(group.variant_count) : "";

  return (
    <Drawer
      title={group ? group.label : model ? model.display_name : "Seguir un modelo"}
      subtitle={
        group
          ? `Criterios para ${versions} del binomio · ${group.tracked_variants} en seguimiento`
          : model
            ? alreadyTracked
              ? "Editando los criterios de seguimiento"
              : "Empezar a seguirlo con criterios"
            : "Elige un modelo del catálogo o créalo al vuelo"
      }
      onClose={onClose}
      actions={
        // En táctil la fila no tiene sitio para tres botones: el ranking se
        // alcanza desde aquí. Deshabilitado dice lo mismo que decía el `title`
        // de la tabla, porque debajo está «Ofertas activas 0» en letra.
        onRanking && group ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={group.active_offers === 0}
            onClick={onRanking}
          >
            Ranking IA
          </button>
        ) : undefined
      }
    >
      {error ? <Banner kind="error">{error}</Banner> : null}
      {current.mixed ? (
        <Banner kind="warn">
          Los criterios que tienes puestos no son los mismos en todas las versiones que
          sigues. Al guardar, estos se aplican a {versions}.
        </Banner>
      ) : null}

      <form className="stack" onSubmit={submit}>
        {picking ? (
          <>
            {/* Dos opciones excluyentes: el seleccionado se marca con el mismo
                «estado puesto» que el resto de la app, no con el relleno sólido
                de la acción principal —que en este panel es «Seguir modelo». */}
            <div className="row" role="group" aria-label="Origen del modelo">
              <button
                type="button"
                className={`btn btn-sm${source === "existing" ? " on" : ""}`}
                aria-pressed={source === "existing"}
                onClick={() => setSource("existing")}
              >
                Del catálogo
              </button>
              <button
                type="button"
                className={`btn btn-sm${source === "new" ? " on" : ""}`}
                aria-pressed={source === "new"}
                onClick={() => {
                  setSource("new");
                  setPicked(null);
                }}
              >
                Modelo nuevo
              </button>
            </div>

            {source === "existing" ? (
              <div className="stack">
                <div className="field">
                  <label htmlFor="pick">Buscar modelo</label>
                  <input
                    id="pick"
                    className="input"
                    placeholder="Marca o modelo…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>

                {results.loading ? (
                  <Loading />
                ) : (results.data ?? []).length === 0 ? (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    Sin coincidencias. Usa «Modelo nuevo» para crearlo.
                  </p>
                ) : (
                  <div className="picker">
                    {(results.data ?? []).map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className={`picker-item${picked?.id === candidate.id ? " on" : ""}`}
                        onClick={() => {
                          setPicked(candidate);
                          setReferencePrice(
                            candidate.reference_price != null
                              ? String(candidate.reference_price)
                              : "",
                          );
                          setTargetPrice(
                            candidate.tracking?.target_price != null
                              ? String(candidate.tracking.target_price)
                              : "",
                          );
                          setMaxMileage(
                            candidate.tracking?.max_mileage_km != null
                              ? String(candidate.tracking.max_mileage_km)
                              : "",
                          );
                          setMinYear(
                            candidate.tracking?.min_year != null
                              ? String(candidate.tracking.min_year)
                              : "",
                          );
                          setNotes(candidate.tracking?.notes ?? "");
                        }}
                      >
                        <span className="picker-name">{candidate.display_name}</span>
                        <span className="tiny muted">
                          {candidate.active_offers} ofertas · mediana{" "}
                          {formatPrice(candidate.median_price)}
                          {candidate.is_tracked ? " · ya lo sigues" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="stack">
                <div className="row">
                  <div className="field grow">
                    <label htmlFor="make">Marca</label>
                    <input
                      id="make"
                      className="input"
                      required
                      value={make}
                      onChange={(event) => setMake(event.target.value)}
                    />
                  </div>
                  <div className="field grow">
                    <label htmlFor="model">Modelo</label>
                    <input
                      id="model"
                      className="input"
                      required
                      value={modelName}
                      onChange={(event) => setModelName(event.target.value)}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="trim">Acabado (opcional)</label>
                  <input
                    id="trim"
                    className="input"
                    placeholder="1.8 Hybrid Active"
                    value={trim}
                    onChange={(event) => setTrim(event.target.value)}
                  />
                </div>
              </div>
            )}
          </>
        ) : null}

        <div className="card">
          <p className="card-title">Criterios de seguimiento</p>
          <div className="stack">
            <div className="row">
              <div className="field grow">
                <label htmlFor="target">Precio objetivo (€)</label>
                <input
                  id="target"
                  className="input"
                  type="number"
                  min={0}
                  step={500}
                  placeholder="Avísame por debajo de…"
                  value={targetPrice}
                  onChange={(event) => setTargetPrice(event.target.value)}
                />
              </div>
              {group ? null : (
                <div className="field grow">
                  <label htmlFor="ref">PVP de referencia (€)</label>
                  <input
                    id="ref"
                    className="input"
                    type="number"
                    min={0}
                    step={500}
                    value={referencePrice}
                    onChange={(event) => setReferencePrice(event.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="row">
              <div className="field grow">
                <label htmlFor="maxkm">Km máximos</label>
                <input
                  id="maxkm"
                  className="input"
                  type="number"
                  min={0}
                  step={5000}
                  value={maxMileage}
                  onChange={(event) => setMaxMileage(event.target.value)}
                />
              </div>
              <div className="field grow">
                <label htmlFor="minyear">Año mínimo</label>
                <input
                  id="minyear"
                  className="input"
                  type="number"
                  min={1950}
                  max={2100}
                  value={minYear}
                  onChange={(event) => setMinYear(event.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="notes">Notas</label>
              <textarea
                id="notes"
                className="textarea"
                placeholder="Ej: prefiero automático y con garantía oficial"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>
          <p className="tiny muted" style={{ margin: "10px 0 0" }}>
            {group
              ? `Se aplican a ${versions} del binomio. El PVP de referencia no: es de la versión y se pone en cada una.`
              : "El PVP de referencia es del modelo y lo ven todos; el resto son tus criterios."}
          </p>
        </div>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {alreadyTracked ? "Guardar criterios" : group ? `Seguir ${versions}` : "Seguir modelo"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancelar
          </button>
          <div className="spacer" />
          {alreadyTracked ? (
            <button
              className="btn btn-ghost btn-sm btn-danger"
              type="button"
              disabled={busy}
              onClick={untrack}
            >
              {group ? `Dejar de seguir (${group.tracked_variants})` : "Dejar de seguir"}
            </button>
          ) : null}
        </div>
      </form>

      {/* Lo que en la tabla son ocho columnas más y un desplegable de versiones.
          Solo en táctil: en escritorio siguen en su fila, y repetirlas aquí
          sería contar dos veces lo mismo en la misma pantalla. */}
      {touch && group ? (
        <>
          <section>
            <h3 className="section-title">Cifras del modelo</h3>
            <ul className="record-list">
              {groupFigures(group).map((figure) => (
                <li key={figure.label} className="record-item">
                  <div className="record-head">
                    <span className="record-title">{figure.label}</span>
                    <span className="record-value">{figure.value}</span>
                  </div>
                  {figure.note ? <div className="record-meta">{figure.note}</div> : null}
                </li>
              ))}
            </ul>
          </section>

          {onPickVariant ? (
            <section>
              <h3 className="section-title">Versiones ({group.variant_count})</h3>
              <ul className="record-list">
                {group.variants.map((variant) => (
                  <li key={variant.id} className="record-item">
                    <button
                      type="button"
                      className="record-link"
                      onClick={() => onPickVariant(variant)}
                    >
                      <span className="sr-only">Criterios de </span>
                      <span className="record-head">
                        <span className="record-title">
                          {variant.trim || variant.display_name}
                        </span>
                        <span className="record-value">
                          {formatPrice(variant.median_price)}
                          <span className="sr-only"> de mediana</span>
                        </span>
                      </span>
                      <span className="record-meta">{variantMeta(variant)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="tiny muted" style={{ margin: "10px 0 0" }}>
                Cada versión se sigue, se deja de seguir y se afina desde su propia ficha.
              </p>
            </section>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
