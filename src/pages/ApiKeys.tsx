import { useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { useTouchLayout } from "../components/SwipeRow";
import { Banner, Chip, Empty, Loading } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAsync } from "../lib/hooks";
import type { ApiKey, ApiKeyCreated } from "../types";

/**
 * La segunda línea de la ficha, sin el prefijo, que va aparte porque va en mono.
 *
 * El último uso va antes que la fecha de alta a propósito: en esta pantalla la
 * pregunta operativa es «¿sigue ingestando el scraper?», y la respuesta es esa
 * fecha. «Sin usar todavía» en vez del guion de la tabla, que en una línea
 * corrida no se distingue de un dato que falta.
 */
const keyMeta = (key: ApiKey): string =>
  [
    key.last_used_at ? `último uso ${formatDateTime(key.last_used_at)}` : "sin usar todavía",
    `creada ${formatDateTime(key.created_at)}`,
  ].join(" · ");

export function ApiKeysPage() {
  const keys = useAsync<ApiKey[]>(() => api.get("/api-keys"), []);
  const touch = useTouchLayout();

  const [name, setName] = useState("scraper");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeCount = (keys.data ?? []).filter((key) => key.is_active).length;
  // El ejemplo apunta a donde se está mirando la página, no a un puerto de
  // desarrollo fijo: en producción, copiar el `curl` tal cual tiene que valer.
  const origin = window.location.origin;

  async function createKey(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setCreated(await api.post<ApiKeyCreated>("/api-keys", { name: name.trim() }));
      keys.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear la API key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`¿Revocar la API key "${key.name}"? El scraper dejará de poder ingestar.`))
      return;
    setError(null);
    try {
      await api.delete(`/api-keys/${key.id}`);
      keys.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar la API key");
    }
  }

  return (
    <>
      <PageHeader
        title="API Keys"
        meta={keys.data ? `${activeCount} activa${activeCount === 1 ? "" : "s"}` : undefined}
      />

      <div className="content stack" style={{ maxWidth: 860 }}>
        <div className="card">
          <p className="card-title">API keys del scraper</p>
          <p className="tiny muted" style={{ marginTop: -4 }}>
            El scraper es la skill <code className="mono">next-ride/</code>: lee qué captar de{" "}
            <code className="mono">GET /api/v1/scraping/config</code> e ingesta con{" "}
            <code className="mono">POST /api/v1/offers/bulk</code>, siempre con la cabecera{" "}
            <code className="mono">X-API-Key</code>. Toma la clave de{" "}
            <code className="mono">NR_API_KEY</code> y la URL base de{" "}
            <code className="mono">NR_API_BASE_URL</code>, que para esta instancia es{" "}
            <code className="mono">{origin}</code>.
          </p>

          {error ? <Banner kind="error">{error}</Banner> : null}

          {created ? (
            <Banner kind="warn">
              <div>
                <strong>Copia la clave ahora</strong> — no se puede volver a ver.
                <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
                  {created.api_key}
                </div>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    navigator.clipboard?.writeText(created.api_key);
                    setCreated(null);
                  }}
                >
                  Copiar y cerrar
                </button>
              </div>
            </Banner>
          ) : null}

          {/* Rótulo visible y no solo `aria-label`: con el valor por defecto
              puesto —«scraper»— el marcador no se ve nunca, y el campo se
              quedaba sin decir qué es. */}
          <form className="field" style={{ margin: "10px 0 14px" }} onSubmit={createKey}>
            <label htmlFor="key-name">Nombre de la nueva clave</label>
            <div className="row">
              <input
                id="key-name"
                className="input grow"
                placeholder="Ej: scraper"
                enterKeyHint="done"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : null} Generar
              </button>
            </div>
          </form>

          {keys.loading || (keys.data ?? []).length === 0 ? (
            <div className="table-wrap">
              {keys.loading ? (
                <Loading />
              ) : (
                <Empty title="No hay API keys" hint="Genera una para el servicio scraper." />
              )}
            </div>
          ) : touch ? (
            /* Una `<ul>` de `<li>` y no la tabla con `display: block`: una tabla
               desmontada con CSS pierde su semántica sin avisar. La ficha no es
               pulsable entera —una clave no tiene detalle que abrir, y lo único
               que se puede hacer con ella es revocarla— así que el único
               objetivo de la fila es ese botón, al margen y en rojo: es
               destructivo, y en una tercera línea pedía 40 px por clave para
               decir una palabra. */
            <ul className="record-list">
              {(keys.data ?? []).map((key) => (
                <li key={key.id} className="record-item split key-item">
                  <div className="key-body">
                    <div className="record-head">
                      <span className="record-title">{key.name}</span>
                      <Chip tone={key.is_active ? "positive" : "neutral"}>
                        {key.is_active ? "Activa" : "Revocada"}
                      </Chip>
                    </div>
                    {/* El prefijo en su propia línea y en mono: es lo que se
                        compara contra la clave del entorno del scraper. Las
                        fechas debajo, partiendo línea antes que recortarse. */}
                    <div className="record-meta mono">nr_{key.prefix}_…</div>
                    <div className="record-meta key-dates">{keyMeta(key)}</div>
                  </div>
                  {key.is_active ? (
                    <div className="record-actions">
                      <button
                        type="button"
                        className="btn btn-ghost key-revoke"
                        aria-label={`Revocar la API key ${key.name}`}
                        onClick={() => revoke(key)}
                      >
                        Revocar
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="table-wrap">
              <table className="records">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Prefijo</th>
                    <th>Estado</th>
                    <th>Creada</th>
                    <th>Último uso</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {(keys.data ?? []).map((key) => (
                    <tr key={key.id}>
                      <td className="cell-primary">{key.name}</td>
                      <td className="mono cell-muted">nr_{key.prefix}_…</td>
                      <td>
                        <Chip tone={key.is_active ? "positive" : "neutral"}>
                          {key.is_active ? "Activa" : "Revocada"}
                        </Chip>
                      </td>
                      <td className="cell-muted tiny">{formatDateTime(key.created_at)}</td>
                      <td className="cell-muted tiny">{formatDateTime(key.last_used_at)}</td>
                      <td>
                        <div className="row-actions">
                          {key.is_active ? (
                            <button
                              className="btn btn-ghost btn-sm btn-danger"
                              onClick={() => revoke(key)}
                            >
                              Revocar
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <p className="card-title">Contrato de ingesta</p>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 12,
              background: "var(--surface-sunken)",
              borderRadius: 4,
              overflowX: "auto",
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >{`curl -X POST ${origin}/api/v1/offers/bulk \\
  -H "X-API-Key: nr_xxxx_yyyy" \\
  -H "Content-Type: application/json" \\
  -d '{"offers": [{
        "url": "https://dealer.example/coche/123",
        "title": "Toyota Corolla 1.8 Hybrid Active (2022)",
        "price": 24500,
        "original_price": 27900,
        "dealer_name": "Autos Ribera",
        "make": "Toyota", "model": "Corolla", "trim": "1.8 Hybrid Active",
        "year": 2022, "mileage_km": 38000, "condition": "used",
        "fuel_type": "hybrid", "transmission": "automatic"
      }]}'`}</pre>
          <p className="tiny muted" style={{ marginBottom: 0, marginTop: 10 }}>
            El upsert se hace por <code className="mono">url</code>. Dealers y modelos se crean
            solos si no existen. Un lote admite hasta 500 ofertas; las que no validan se
            devuelven en <code className="mono">errors</code> sin tumbar el resto.
          </p>
        </div>
      </div>
    </>
  );
}
