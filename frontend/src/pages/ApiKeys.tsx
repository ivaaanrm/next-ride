import { useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { Banner, Chip, Empty, Loading } from "../components/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAsync } from "../lib/hooks";
import type { ApiKey, ApiKeyCreated } from "../types";

export function ApiKeysPage() {
  const keys = useAsync<ApiKey[]>(() => api.get("/api-keys"), []);

  const [name, setName] = useState("scraper");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeCount = (keys.data ?? []).filter((key) => key.is_active).length;

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
          <p className="card-title">API keys para el servicio scraper</p>
          <p className="tiny muted" style={{ marginTop: -4 }}>
            El scraper (servicio aparte, aún sin implementar) ingesta ofertas contra{" "}
            <code className="mono">POST /api/v1/offers/bulk</code> enviando la cabecera{" "}
            <code className="mono">X-API-Key</code>.
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

          <form className="row" style={{ margin: "10px 0 14px" }} onSubmit={createKey}>
            <input
              className="input grow"
              placeholder="Nombre de la clave"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? <span className="spinner" /> : null} Generar
            </button>
          </form>

          <div className="table-wrap">
            {keys.loading ? (
              <Loading />
            ) : (keys.data ?? []).length === 0 ? (
              <Empty title="No hay API keys" hint="Genera una para el servicio scraper." />
            ) : (
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
            )}
          </div>
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
          >{`curl -X POST http://localhost:8000/api/v1/offers/bulk \\
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
            solos si no existen. Documentación completa en{" "}
            <a className="cell-link" href="/docs" target="_blank" rel="noreferrer">
              /docs
            </a>
            .
          </p>
        </div>
      </div>
    </>
  );
}
