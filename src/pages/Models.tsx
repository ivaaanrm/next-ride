import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";

import {
  FollowModelDrawer,
  followStatus,
  NumberField,
  type FollowTarget,
} from "../components/FollowModelDrawer";
import { IconPlus, IconRadar, IconRefresh, IconSearch } from "../components/icons";
import { HeaderButton, PageHeader } from "../components/Layout";
import { ScrapingConfigDrawer } from "../components/ScrapingConfigDrawer";
import { useTouchLayout } from "../components/SwipeRow";
import {
  Banner,
  Chip,
  Drawer,
  Empty,
  Loading,
  Score,
  ToastStack,
  useToasts,
} from "../components/ui";
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

/** «las 23 versiones» / «la versión»: los botones hablan de todas a la vez. */
const theVersions = (count: number) => (count === 1 ? "la versión" : `las ${count} versiones`);

const offersOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "oferta" : "ofertas"}`;

/**
 * Qué dice y qué hace el botón de seguimiento del binomio en la tabla del
 * escritorio. En táctil no hay botón por fila: la fila abre la ficha, y seguir
 * se decide allí con los portales y los criterios a la vista.
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

/**
 * La segunda línea de la ficha del binomio, ya escrita, con ranuras fijas: lo
 * que hay para mirar y entre qué precios se mueve. Lo que falta no deja hueco
 * ni pone «—». El número de versiones se fue: «206 versiones» no ayuda a
 * decidir nada y se comía el rango de precios.
 */
function groupMeta(group: CarModelGroup): string {
  return [
    group.active_offers === 0 ? "Sin ofertas aún" : offersOf(group.active_offers),
    priceRange(group.min_price, group.max_price),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Lo que solo importa de lo que se sigue: el objetivo y si ya se ha alcanzado,
 * y si el seguimiento es parcial. Va en su propia línea, con color cuando hay
 * algo que mirar.
 */
function TrackLine({ group }: { group: CarModelGroup }) {
  const partial = group.tracked_variants < group.variant_count;
  const reached =
    group.target_price !== null && group.min_price !== null && group.min_price <= group.target_price;
  const parts = [
    group.target_price !== null
      ? reached
        ? `Objetivo ${formatPrice(group.target_price)} alcanzado`
        : `Objetivo ${formatPrice(group.target_price)}`
      : null,
    partial ? followStatus(group) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className={`record-meta track-line${reached ? " reached" : ""}`}>{parts.join(" · ")}</span>;
}

type Scope = "all" | "tracked";

export function ModelsPage() {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [error, setError] = useState<string | null>(null);
  // Clave del binomio, o `variant:{id}`: hay un botón por fila y por versión.
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [ranking, setRanking] = useState<CarModelGroup | null>(null);
  const [follow, setFollow] = useState<FollowTarget | null>(null);
  const [variant, setVariant] = useState<CarModelWithStats | null>(null);
  const [scrapingConfig, setScrapingConfig] = useState(false);
  const touch = useTouchLayout();
  const toasts = useToasts();

  // El filtro de «los que sigo» es local: son decenas de binomios, y así el
  // conmutador es instantáneo y los dos contadores salen de la misma lista.
  const debouncedSearch = useDebounced(search);
  const groups = useAsync<CarModelGroup[]>(
    () => api.get("/car-models/groups", { q: debouncedSearch || undefined }),
    [debouncedSearch],
  );

  const all = groups.data ?? [];
  const followed = all.filter((group) => group.tracked_variants > 0);
  const rows = scope === "tracked" ? followed : all;
  const versions = rows.reduce((total, group) => total + group.variant_count, 0);

  function toggleExpanded(key: string) {
    setExpanded((open) =>
      open.includes(key) ? open.filter((other) => other !== key) : [...open, key],
    );
  }

  /** Atajo de un clic del escritorio sobre el binomio entero. */
  async function toggleGroup(group: CarModelGroup) {
    setError(null);
    setBusy(group.key);
    const ids = group.variants.map((item) => item.id).join(",");
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

  function followSaved(message: string, undo?: () => Promise<void>) {
    setFollow(null);
    groups.reload();
    toasts.push({
      message,
      undo: undo
        ? async () => {
            try {
              await undo();
              groups.reload();
            } catch (err) {
              setError(err instanceof Error ? err.message : "No se pudo deshacer");
            }
          }
        : undefined,
    });
  }

  const startFollow = () => setFollow({ kind: "new" });

  return (
    <>
      <PageHeader
        title="Modelos"
        meta={
          groups.data
            ? touch
              ? `${formatNumber(followed.length)} de ${formatNumber(all.length)} seguidos`
              : `${formatNumber(rows.length)} modelos · ${formatNumber(versions)} versiones`
            : undefined
        }
        actions={
          <>
            <HeaderButton icon={IconRefresh} label="Actualizar" onClick={() => groups.reload()} />
            <HeaderButton
              icon={IconRadar}
              label="Configurar captación"
              onClick={() => setScrapingConfig(true)}
            />
            <HeaderButton icon={IconPlus} label="Seguir un modelo" primary onClick={startFollow} />
          </>
        }
      />

      <div className="content">
        {touch ? (
          <div className="models-filters">
            <div className="search-field">
              <IconSearch size={18} />
              <label className="sr-only" htmlFor="q">
                Buscar
              </label>
              <input
                id="q"
                className="input"
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                placeholder="Buscar marca o modelo"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {/* Dos ámbitos que se excluyen: un control segmentado, que es lo que
                iOS usa para esto, con el recuento de cada uno a la vista. */}
            <div className="scope-switch" role="group" aria-label="Qué modelos ver">
              {(
                [
                  ["all", "Todos", all.length],
                  ["tracked", "Siguiendo", followed.length],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? "on" : undefined}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                  {groups.data ? <span className="scope-switch-count">{count}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="filters">
            <div className="field grow">
              <label htmlFor="q">Buscar</label>
              <input
                id="q"
                className="input"
                type="search"
                autoComplete="off"
                placeholder="Marca, modelo o versión…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <label className="row tiny muted" style={{ height: 28 }}>
              <input
                type="checkbox"
                checked={scope === "tracked"}
                onChange={(event) => setScope(event.target.checked ? "tracked" : "all")}
              />
              Solo los que sigo
            </label>
          </div>
        )}

        {error ? <Banner kind="error">{error}</Banner> : null}
        {groups.error ? <Banner kind="error">{groups.error}</Banner> : null}

        {groups.loading && !groups.data ? (
          <div className="table-wrap">
            <Loading />
          </div>
        ) : rows.length === 0 ? (
          <div className="models-empty">
            <Empty
              title={
                search
                  ? "Ningún modelo coincide"
                  : scope === "tracked"
                    ? "Todavía no sigues ningún modelo"
                    : "Todavía no hay modelos"
              }
              hint={
                search
                  ? "Si es uno nuevo, síguelo y se añade al catálogo y a la captación."
                  : "Elige uno del catálogo o escribe uno nuevo: se busca en los portales que marques."
              }
            />
            <button type="button" className="btn btn-primary" onClick={startFollow}>
              <IconPlus size={16} />
              Seguir un modelo
            </button>
          </div>
        ) : touch ? (
          /* Una `<ul>` y no la tabla con `display: block`: una tabla desmontada
             con CSS pierde su semántica sin avisar. La fila entera abre la ficha
             del binomio, que es donde se sigue, se eligen los portales y se
             ponen los criterios. Sin botón al lado: un «Seguir» por fila era la
             mitad del ruido de la pantalla y seguía sin decir dónde se buscaba. */
          <>
            {scope === "all" && followed.length > 0 && followed.length < rows.length ? (
              <>
                <ModelSection
                  title="Siguiendo"
                  groups={followed}
                  onOpen={(group) => setFollow({ kind: "group", group })}
                />
                <ModelSection
                  title="Resto del catálogo"
                  groups={rows.filter((group) => group.tracked_variants === 0)}
                  onOpen={(group) => setFollow({ kind: "group", group })}
                />
              </>
            ) : (
              <ModelSection groups={rows} onOpen={(group) => setFollow({ kind: "group", group })} />
            )}
          </>
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
                  const state = followState(group);
                  return (
                    <Fragment key={group.key}>
                      <tr className="group-row">
                        <td>
                          <button
                            className={`btn btn-sm${group.tracked_variants > 0 ? " on" : ""}`}
                            disabled={busy === group.key}
                            aria-pressed={group.tracked_variants > 0}
                            onClick={() => toggleGroup(group)}
                            title={state.hint}
                          >
                            {state.label}
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
                              onClick={() => setFollow({ kind: "group", group })}
                              title={`Portales y criterios para ${theVersions(group.variant_count)}`}
                            >
                              Seguimiento
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
                        ? group.variants.map((item) => (
                            <tr key={item.id} className="variant-row">
                              <td>
                                <button
                                  className={`btn btn-sm${item.is_tracked ? " on" : ""}`}
                                  disabled={busy === `variant:${item.id}`}
                                  aria-pressed={item.is_tracked}
                                  onClick={() => toggleVariant(item)}
                                >
                                  {item.is_tracked ? "Siguiendo" : "Seguir"}
                                </button>
                              </td>
                              <td className="cell-clip variant-name" title={item.display_name}>
                                {item.trim || item.display_name}
                              </td>
                              <td className="num">{item.active_offers}</td>
                              <td className="num cell-muted">{item.dealers_count}</td>
                              <td className="num">{formatPrice(item.min_price)}</td>
                              <td className="num">{formatPrice(item.median_price)}</td>
                              <td className="num cell-muted">{formatPrice(item.max_price)}</td>
                              <td className="num cell-muted">{formatPrice(item.reference_price)}</td>
                              <td className="num">
                                <TargetCell
                                  target={item.tracking?.target_price ?? null}
                                  minPrice={item.min_price}
                                />
                              </td>
                              {/* El ranking es del modelo entero: la celda es del
                                  binomio y aquí queda vacía a propósito. */}
                              <td className="cell-muted tiny">—</td>
                              <td>
                                <div className="row" style={{ justifyContent: "flex-end" }}>
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => setVariant(item)}
                                    title={
                                      item.is_tracked
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

      {follow ? (
        /* La `key` remonta el panel al cambiar de binomio: el formulario nace
           relleno con los criterios de lo que se le pasa. */
        <FollowModelDrawer
          key={follow.kind === "group" ? follow.group.key : "new"}
          target={follow}
          touch={touch}
          onPickVariant={(model) => setVariant(model)}
          onRanking={(group) => {
            setFollow(null);
            setRanking(group);
          }}
          onClose={() => setFollow(null)}
          onSaved={followSaved}
        />
      ) : null}

      {variant ? (
        <VariantDrawer
          key={variant.id}
          model={variant}
          over={follow !== null}
          onClose={() => setVariant(null)}
          onSaved={(message) => {
            setVariant(null);
            setFollow(null);
            groups.reload();
            toasts.push({ message });
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

      <ToastStack {...toasts} />
    </>
  );
}

/** Una sección de la lista táctil, con su rótulo si hay más de una. */
function ModelSection({
  title,
  groups,
  onOpen,
}: {
  title?: string;
  groups: CarModelGroup[];
  onOpen: (group: CarModelGroup) => void;
}) {
  const list = (
    <ul className="record-list flush">
      {groups.map((group) => (
        <li key={group.key} className="record-item">
          <button type="button" className="record-link" onClick={() => onOpen(group)}>
            <span className="sr-only">Ver el detalle de </span>
            <span className="record-head">
              <span className="record-title">{group.label}</span>
              {/* La cifra sola se leería como «el precio»: para quien no ve la
                  columna, la palabra que la califica va detrás. */}
              {group.median_price !== null ? (
                <span className="record-value">
                  {formatPrice(group.median_price)}
                  <span className="sr-only"> de mediana</span>
                </span>
              ) : null}
            </span>
            <span className="record-meta">{groupMeta(group)}</span>
            {group.tracked_variants > 0 ? <TrackLine group={group} /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
  if (!title) return list;
  return (
    <section className="models-section" aria-label={title}>
      <h2 className="models-section-title">
        {title} <span className="section-title-hint">{groups.length}</span>
      </h2>
      {list}
    </section>
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

  /* El contexto se pliega cuando ya hay un ranking: lo que se viene a leer es
     el resultado, y el formulario solo hace falta para regenerarlo. Sin
     ranking es lo único que hay, y va abierto. */
  const context = (
    <details className="card ranking-context" open={!run}>
      <summary className="card-title">Contexto para el agente (opcional)</summary>
      <div className="follow-grid">
        <div className="field ranking-priorities">
          <label htmlFor="priorities">Qué priorizas</label>
          <textarea
            id="priorities"
            className="textarea"
            rows={2}
            placeholder="Bajo kilometraje, garantía oficial, automático…"
            value={priorities}
            onChange={(event) => setPriorities(event.target.value)}
          />
        </div>
        <NumberField
          id="budget"
          label="Presupuesto máximo"
          unit="€"
          step={500}
          value={maxBudget}
          onChange={setMaxBudget}
        />
      </div>
    </details>
  );

  return (
    <Drawer
      title={group.label}
      subtitle={`${offersOf(group.active_offers)} de ${theVersions(
        group.variant_count,
      )} · mediana ${formatPrice(group.median_price)}`}
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary follow-submit"
          disabled={running || status === "loading"}
          onClick={startRanking}
        >
          {running ? <span className="spinner" /> : null}
          {running ? "Analizando…" : run ? "Regenerar ranking" : "Generar ranking"}
        </button>
      }
    >
      {run ? null : context}

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
          {context}
        </>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Los criterios de **una** versión, con su PVP de referencia.
 *
 * Seguir un modelo es cosa del binomio (`FollowModelDrawer`); esto es el ajuste
 * fino que solo tiene sentido por acabado: un RS3 no comparte precio de
 * catálogo con un 1.0 TFSI, y alguien puede querer seguir solo el híbrido. Por
 * eso aquí, y solo aquí, está el PVP.
 */
function VariantDrawer({
  model,
  over,
  onClose,
  onSaved,
}: {
  model: CarModelWithStats;
  over: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const prefs = model.tracking;
  const text = (value: number | null | undefined) => (value == null ? "" : String(value));
  const [referencePrice, setReferencePrice] = useState(text(model.reference_price));
  const [targetPrice, setTargetPrice] = useState(text(prefs?.target_price));
  const [maxMileage, setMaxMileage] = useState(text(prefs?.max_mileage_km));
  const [minYear, setMinYear] = useState(text(prefs?.min_year));
  const [notes, setNotes] = useState(prefs?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));
  const name = model.trim || model.display_name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // El PVP de referencia es de la versión (compartido), no del seguimiento.
      const nextReference = numberOrNull(referencePrice);
      if (nextReference !== (model.reference_price ?? null)) {
        await api.patch(`/car-models/${model.id}`, { reference_price: nextReference });
      }
      await api.post("/tracked-models", {
        car_model_id: model.id,
        target_price: numberOrNull(targetPrice),
        max_mileage_km: numberOrNull(maxMileage),
        min_year: numberOrNull(minYear),
        notes: notes.trim() || null,
      });
      onSaved(`${model.is_tracked ? "Guardado" : "Siguiendo"} ${name}`);
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
      await api.delete(`/tracked-models/${model.id}`);
      onSaved(`Has dejado de seguir ${name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dejar de seguir");
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={model.display_name}
      subtitle={`${offersOf(model.active_offers)} · ${
        model.is_tracked ? "la sigues" : "no la sigues"
      }`}
      onClose={onClose}
      over={over}
      footer={
        <>
          {model.is_tracked ? (
            <button
              className="btn btn-ghost btn-danger follow-unfollow"
              type="button"
              disabled={busy}
              onClick={() => void untrack()}
            >
              Dejar de seguir
            </button>
          ) : null}
          <button
            className="btn btn-primary follow-submit"
            type="submit"
            form="variant-form"
            disabled={busy}
          >
            {busy ? <span className="spinner" /> : null}
            {model.is_tracked ? "Guardar cambios" : "Seguir esta versión"}
          </button>
        </>
      }
    >
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form id="variant-form" className="follow-form" onSubmit={submit}>
        <section className="follow-section">
          <h3 className="section-title">
            Avísame si… <span className="section-title-hint">opcional</span>
          </h3>
          <div className="follow-grid">
            <NumberField
              id="variant-target"
              label="Precio por debajo de"
              unit="€"
              step={500}
              value={targetPrice}
              onChange={setTargetPrice}
            />
            <NumberField
              id="variant-km"
              label="Kilómetros, como mucho"
              unit="km"
              step={5000}
              value={maxMileage}
              onChange={setMaxMileage}
            />
            <NumberField
              id="variant-year"
              label="Año, desde"
              min={1950}
              max={2100}
              value={minYear}
              onChange={setMinYear}
            />
          </div>
          <div className="field">
            <label htmlFor="variant-notes">Notas</label>
            <textarea
              id="variant-notes"
              className="textarea"
              rows={2}
              placeholder="Automático, con garantía oficial…"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </section>

        <section className="follow-section">
          <h3 className="section-title">Precio de catálogo</h3>
          <div className="follow-grid">
            <NumberField
              id="variant-ref"
              label="PVP de referencia"
              unit="€"
              step={500}
              value={referencePrice}
              onChange={setReferencePrice}
            />
          </div>
          <p className="follow-note">
            Ancla el descuento de cada oferta de esta versión. Es de la versión, no tuyo: lo ve
            cualquiera que la mire.
          </p>
        </section>
      </form>
    </Drawer>
  );
}
