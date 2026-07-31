import { useEffect, useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { Banner, Chip, Loading } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import type { OverviewStats, ScoreConfig, ScoreWeights } from "../types";

export function SettingsPage() {
  const { user } = useAuth();
  const stats = useAsync<OverviewStats>(() => api.get("/stats/overview"), []);

  return (
    <>
      <PageHeader title="Ajustes" meta={user?.email} />

      <div className="content stack" style={{ maxWidth: 860 }}>
        <div className="card">
          <p className="card-title">Cuenta</p>
          <div className="row row-wrap">
            <Chip tone="accent">{user?.email}</Chip>
            {user?.full_name ? <Chip>{user.full_name}</Chip> : null}
            {user?.is_superuser ? <Chip tone="warm">Superusuario</Chip> : null}
            <Chip tone={stats.data?.ai_enabled ? "positive" : "negative"}>
              Ranking IA {stats.data?.ai_enabled ? "activo" : "desactivado"}
            </Chip>
          </div>
        </div>

        <ScoringCard />
      </div>
    </>
  );
}

/**
 * Editor de la puntuación de valor: los pesos de cada señal y el parámetro de
 * kilometraje esperado. Es la otra mitad de la transparencia: el desglose del
 * panel de cada oferta enseña los pesos finales, y aquí es donde se cambian.
 *
 * Los pesos son relativos —no tienen que sumar 100—: el % efectivo que se
 * enseña al lado es peso/total, que es exactamente el que usa el backend antes
 * de repartir el de las señales sin dato de cada oferta.
 */
function ScoringCard() {
  const config = useAsync<ScoreConfig>(() => api.get("/scoring/config"), []);

  const [weights, setWeights] = useState<ScoreWeights | null>(null);
  const [kmPerYear, setKmPerYear] = useState<number>(15000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // El formulario se rellena con lo vigente cada vez que llega del backend.
  useEffect(() => {
    if (config.data) {
      setWeights({ ...config.data.weights });
      setKmPerYear(config.data.params.expected_km_per_year);
    }
  }, [config.data]);

  if (config.loading) {
    return (
      <div className="card">
        <p className="card-title">Puntuación de valor</p>
        <Loading />
      </div>
    );
  }
  if (config.error || !config.data || !weights) {
    return (
      <div className="card">
        <p className="card-title">Puntuación de valor</p>
        <Banner kind="error">{config.error ?? "No se pudo cargar la configuración"}</Banner>
      </div>
    );
  }

  const data = config.data;
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const dirty =
    kmPerYear !== data.params.expected_km_per_year ||
    Object.entries(weights).some(([key, value]) => data.weights[key] !== value);
  const isDefault =
    Object.entries(weights).every(([key, value]) => data.default_weights[key] === value) &&
    kmPerYear === data.default_params.expected_km_per_year;

  const pctOf = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!weights) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const updated = await api.put<ScoreConfig>("/scoring/config", {
        weights,
        params: { ...data.params, expected_km_per_year: kmPerYear },
      });
      config.setData(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  function restoreDefaults() {
    setWeights({ ...data.default_weights });
    setKmPerYear(data.default_params.expected_km_per_year);
    setSaved(false);
  }

  return (
    <div className="card">
      <p className="card-title">Puntuación de valor</p>
      <p className="tiny muted" style={{ marginTop: -4 }}>
        Cada oferta se puntúa de 0 a 100 como media ponderada de estas señales, y su panel
        enseña el desglose exacto. Los pesos son relativos: el porcentaje final es
        peso/total y, si a una oferta le falta una señal, su peso se reparte entre las
        demás. Se aplican a todo el catálogo en el momento de guardar.
      </p>

      {error ? <Banner kind="error">{error}</Banner> : null}
      {saved ? <Banner kind="info">Pesos guardados: la puntuación ya los usa.</Banner> : null}

      <form onSubmit={save}>
        <div className="score-weights">
          <div className="score-weight-row head">
            <span>Señal</span>
            <span className="num">Peso</span>
            <span className="num" title="Peso / total: el que se usa de verdad">
              Final
            </span>
          </div>
          {data.components.map((component) => (
            <div className="score-weight-row" key={component.key}>
              <div className="score-weight-info">
                <span>{component.label}</span>
                <span className="tiny muted">{component.description}</span>
              </div>
              <input
                className="input num"
                type="number"
                min={0}
                max={100}
                step={1}
                value={weights[component.key] ?? 0}
                aria-label={`Peso de ${component.label}`}
                onChange={(event) =>
                  setWeights({
                    ...weights,
                    [component.key]: Math.max(0, Math.min(100, Number(event.target.value))),
                  })
                }
              />
              <span className="num score-weight-pct">
                {formatNumber(pctOf(weights[component.key] ?? 0))} %
              </span>
            </div>
          ))}
        </div>

        <div className="score-params">
          <label className="score-param">
            <span className="tiny muted">Km/año esperados (media de uso)</span>
            <input
              className="input num"
              type="number"
              min={1000}
              max={100000}
              step={500}
              value={kmPerYear}
              onChange={(event) => setKmPerYear(Number(event.target.value))}
            />
          </label>
          <div className="score-param grow">
            <span className="tiny muted">
              Depreciación media aplicada (fracción del PVP por edad)
            </span>
            <div className="row row-wrap" style={{ gap: 4 }}>
              {data.params.residual_curve.map((fraction, age) => (
                <Chip key={age} title={`${age} años: ${Math.round(fraction * 100)} % del PVP`}>
                  {age}a·{Math.round(fraction * 100)}%
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          {data.updated_at ? (
            <span className="tiny muted">Editada el {formatDateTime(data.updated_at)}</span>
          ) : null}
          <div className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={restoreDefaults}
            disabled={busy || isDefault}
          >
            Valores por defecto
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !dirty || total <= 0}>
            {busy ? <span className="spinner" /> : null} Guardar
          </button>
        </div>
        {total <= 0 ? (
          <p className="tiny" style={{ color: "var(--negative)", marginBottom: 0 }}>
            Al menos una señal necesita peso mayor que cero.
          </p>
        ) : null}
      </form>
    </div>
  );
}
