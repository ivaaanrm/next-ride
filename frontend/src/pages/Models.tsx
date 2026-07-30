import { useEffect, useRef, useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { Banner, Chip, Drawer, Empty, Loading, Score } from "../components/ui";
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
import type { CarModelWithStats, RankingRunDetail } from "../types";

const POLL_MS = 3000;

export function ModelsPage() {
  const [search, setSearch] = useState("");
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openModel, setOpenModel] = useState<CarModelWithStats | null>(null);
  // `null` = panel cerrado. `{ model: null }` = abierto sin modelo elegido todavía.
  const [tracking, setTracking] = useState<{ model: CarModelWithStats | null } | null>(null);

  const debouncedSearch = useDebounced(search);
  const models = useAsync<CarModelWithStats[]>(
    () =>
      api.get("/car-models", {
        q: debouncedSearch || undefined,
        tracked_only: trackedOnly || undefined,
      }),
    [debouncedSearch, trackedOnly],
  );

  /** Atajo de un clic. Los criterios se editan en el panel «Criterios». */
  async function toggleTracking(model: CarModelWithStats) {
    setError(null);
    setBusyId(model.id);
    try {
      if (model.is_tracked) {
        await api.delete(`/tracked-models/${model.id}`);
      } else {
        await api.post("/tracked-models", { car_model_id: model.id });
      }
      models.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el seguimiento");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Modelos"
        meta={models.data ? `${models.data.length} modelos` : undefined}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => models.reload()}>
              Actualizar
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setTracking({ model: null })}
            >
              Seguir un modelo
            </button>
          </>
        }
      />

      <div className="content">
        <div className="filters">
          <div className="field grow">
            <label htmlFor="q">Buscar</label>
            <input
              id="q"
              className="input"
              placeholder="Marca o modelo…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <label className="row tiny muted" style={{ height: 28 }}>
            <input
              type="checkbox"
              checked={trackedOnly}
              onChange={(event) => setTrackedOnly(event.target.checked)}
            />
            Solo los que sigo
          </label>
        </div>

        {error ? <Banner kind="error">{error}</Banner> : null}
        {models.error ? <Banner kind="error">{models.error}</Banner> : null}

        <div className="table-wrap">
          {models.loading ? (
            <Loading />
          ) : (models.data ?? []).length === 0 ? (
            <Empty
              title="Todavía no hay modelos"
              hint="Se crean automáticamente al ingestar ofertas, o a mano con «Seguir un modelo»."
            />
          ) : (
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Seguir</th>
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
                {(models.data ?? []).map((model) => (
                  <tr key={model.id}>
                    <td>
                      <button
                        className={`btn btn-sm${model.is_tracked ? " btn-primary" : ""}`}
                        disabled={busyId === model.id}
                        onClick={() => toggleTracking(model)}
                      >
                        {model.is_tracked ? "Siguiendo" : "Seguir"}
                      </button>
                    </td>
                    <td className="cell-primary">{model.display_name}</td>
                    <td className="num">{model.active_offers}</td>
                    <td className="num cell-muted">{model.dealers_count}</td>
                    <td className="num">{formatPrice(model.min_price)}</td>
                    <td className="num" style={{ fontWeight: 500 }}>
                      {formatPrice(model.median_price)}
                    </td>
                    <td className="num cell-muted">{formatPrice(model.max_price)}</td>
                    <td className="num cell-muted">{formatPrice(model.reference_price)}</td>
                    <td className="num">
                      <TargetCell model={model} />
                    </td>
                    <td className="cell-muted tiny">
                      {model.last_ranked_at ? formatDateTime(model.last_ranked_at) : "—"}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => setTracking({ model })}
                          title={
                            model.is_tracked
                              ? "Editar los criterios de seguimiento"
                              : "Seguir con criterios (precio objetivo, km, año)"
                          }
                        >
                          Criterios
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={model.active_offers === 0}
                          onClick={() => setOpenModel(model)}
                          title={
                            model.active_offers === 0
                              ? "Este modelo no tiene ofertas activas"
                              : "Ver / generar ranking con IA"
                          }
                        >
                          Ranking IA
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {openModel ? (
        <RankingDrawer
          model={openModel}
          onClose={() => {
            setOpenModel(null);
            models.reload();
          }}
        />
      ) : null}

      {tracking ? (
        <TrackModelDrawer
          model={tracking.model}
          onClose={() => setTracking(null)}
          onSaved={() => {
            setTracking(null);
            models.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */

/** Precio objetivo del seguimiento, y si ya hay una oferta por debajo. */
function TargetCell({ model }: { model: CarModelWithStats }) {
  const target = model.tracking?.target_price ?? null;
  if (target === null) return <span className="muted">—</span>;

  const reached = model.min_price !== null && model.min_price <= target;
  return (
    <Chip
      tone={reached ? "positive" : "neutral"}
      title={
        reached
          ? `Ya hay una oferta desde ${formatPrice(model.min_price)}`
          : "Ninguna oferta baja todavía del objetivo"
      }
    >
      {formatPrice(target)}
      {reached ? " ✓" : ""}
    </Chip>
  );
}

/* ------------------------------------------------------------------------- */

function RankingDrawer({
  model,
  onClose,
}: {
  model: CarModelWithStats;
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
      .get<RankingRunDetail>(`/car-models/${model.id}/ranking`)
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
  }, [model.id]);

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
      const created = await api.post<{ id: number }>(`/car-models/${model.id}/rank`, {
        priorities: priorities.trim() || null,
        max_budget: maxBudget ? Number(maxBudget) : null,
      });
      pollRun(created.id);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "No se pudo lanzar el ranking");
    }
  }

  const running = status === "running";

  return (
    <Drawer
      title={model.display_name}
      subtitle={`${model.active_offers} ofertas activas · mediana ${formatPrice(
        model.median_price,
      )}`}
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
 * Panel único para seguir un modelo: elegir uno del catálogo o crearlo al vuelo,
 * y fijar los criterios (precio objetivo, km, año, notas) en el mismo paso.
 *
 * Antes eran tres pasos desconectados —crear el modelo, buscarlo en la tabla,
 * pulsar «Seguir»— y los criterios no había forma de tocarlos desde la UI.
 */
function TrackModelDrawer({
  model,
  onClose,
  onSaved,
}: {
  model: CarModelWithStats | null;
  onClose: () => void;
  onSaved: () => void;
}) {
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
    model?.tracking?.target_price != null ? String(model.tracking.target_price) : "",
  );
  const [maxMileage, setMaxMileage] = useState(
    model?.tracking?.max_mileage_km != null ? String(model.tracking.max_mileage_km) : "",
  );
  const [minYear, setMinYear] = useState(
    model?.tracking?.min_year != null ? String(model.tracking.min_year) : "",
  );
  const [notes, setNotes] = useState(model?.tracking?.notes ?? "");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // El buscador solo hace falta cuando el modelo no viene fijado desde la tabla.
  const debouncedSearch = useDebounced(search);
  const results = useAsync<CarModelWithStats[]>(
    () =>
      model === null && source === "existing"
        ? api.get("/car-models", { q: debouncedSearch || undefined })
        : Promise.resolve([]),
    [model, source, debouncedSearch],
  );

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (source === "existing" && picked === null) {
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

      if (source === "new") {
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
    if (!picked) return;
    setError(null);
    setBusy(true);
    try {
      await api.delete(`/tracked-models/${picked.id}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dejar de seguir");
    } finally {
      setBusy(false);
    }
  }

  const alreadyTracked = picked?.is_tracked ?? false;

  return (
    <Drawer
      title={model ? model.display_name : "Seguir un modelo"}
      subtitle={
        model
          ? alreadyTracked
            ? "Editando los criterios de seguimiento"
            : "Empezar a seguirlo con criterios"
          : "Elige un modelo del catálogo o créalo al vuelo"
      }
      onClose={onClose}
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      <form className="stack" onSubmit={submit}>
        {model === null ? (
          <>
            <div className="row">
              <button
                type="button"
                className={`btn btn-sm${source === "existing" ? " btn-primary" : ""}`}
                onClick={() => setSource("existing")}
              >
                Del catálogo
              </button>
              <button
                type="button"
                className={`btn btn-sm${source === "new" ? " btn-primary" : ""}`}
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
            El PVP de referencia es del modelo y lo ven todos; el resto son tus criterios.
          </p>
        </div>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {alreadyTracked ? "Guardar criterios" : "Seguir modelo"}
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
              Dejar de seguir
            </button>
          ) : null}
        </div>
      </form>
    </Drawer>
  );
}
