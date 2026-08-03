import { useState, type FormEvent } from "react";

import { PageHeader } from "../components/Layout";
import { useTouchLayout } from "../components/SwipeRow";
import { Banner, Chip, Drawer, Empty, Loading, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { formatNumber, formatPct, formatPrice } from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import { slugify } from "../lib/slug";
import type { DealerWithStats } from "../types";

/** «41 ofertas» / «1 oferta»: la cifra que decide si este dealer importa hoy. */
const offersOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "oferta" : "ofertas"}`;

/**
 * La segunda línea de la ficha, ya escrita: las seis columnas que no caben en la
 * primera, por orden de lo que decide. Lo que no hay no deja hueco ni pone «—»:
 * en una línea que se lee de corrido, un guion suelto ocupa lo mismo que un dato
 * y no dice nada.
 *
 * «Inactivo» va primero porque cambia el sentido de todo lo demás: las cifras de
 * un dealer apagado describen un pasado.
 */
function dealerMeta(dealer: DealerWithStats): string {
  return [
    dealer.is_active ? null : "Inactivo",
    [dealer.city, dealer.country].filter(Boolean).join(" · ") || null,
    dealer.rating !== null ? `${dealer.rating.toFixed(1)} ★` : null,
    dealer.avg_discount_pct !== null ? `${formatPct(dealer.avg_discount_pct)} dto.` : null,
    dealer.best_price !== null ? `desde ${formatPrice(dealer.best_price)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function DealersPage() {
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  // `null` = panel cerrado. `{ dealer: null }` = alta de un dealer nuevo.
  const [editing, setEditing] = useState<{ dealer: DealerWithStats | null } | null>(null);
  const touch = useTouchLayout();

  const debouncedSearch = useDebounced(search);
  const dealers = useAsync<DealerWithStats[]>(
    () =>
      api.get("/dealers", {
        q: debouncedSearch || undefined,
        include_inactive: includeInactive || undefined,
      }),
    [debouncedSearch, includeInactive],
  );

  const items = dealers.data ?? [];

  return (
    <>
      <PageHeader
        title="Dealers"
        meta={dealers.data ? `${items.length} dealers` : undefined}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => dealers.reload()}>
              Actualizar
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setEditing({ dealer: null })}
            >
              Nuevo dealer
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
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Nombre o ciudad…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {/* La casilla nativa mide 13 px de tinta dentro de una etiqueta de 28:
              por debajo del suelo táctil por partida doble. El interruptor dice
              lo mismo, con estado leído por `aria-pressed`, y ya vale 44 pt. */}
          {touch ? (
            <Toggle on={includeInactive} onChange={setIncludeInactive}>
              Incluir inactivos
            </Toggle>
          ) : (
            <label className="row tiny muted" style={{ height: 28 }}>
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
              />
              Incluir inactivos
            </label>
          )}
        </div>

        {dealers.error ? <Banner kind="error">{dealers.error}</Banner> : null}

        {dealers.loading || items.length === 0 ? (
          <div className="table-wrap">
            {dealers.loading ? (
              <Loading />
            ) : (
              <Empty
                title="Todavía no hay dealers"
                hint="Se crean automáticamente al ingestar ofertas."
              />
            )}
          </div>
        ) : touch ? (
          /* Una `<ul>` de `<li>` y no la tabla con `display: block`: una tabla
             desmontada con CSS pierde su semántica sin avisar, y lo que hay aquí
             ya no son ocho columnas sino un registro por fila. La fila entera
             abre la edición, que en esta pantalla es el único detalle que hay;
             en la tabla ese botón solo aparecía al pasar el ratón por encima. */
          <ul className="record-list">
            {items.map((dealer) => {
              const meta = dealerMeta(dealer);
              return (
                <li key={dealer.id} className="record-item">
                  <button
                    type="button"
                    className="record-link"
                    onClick={() => setEditing({ dealer })}
                  >
                    <span className="sr-only">Editar </span>
                    <span className="record-head">
                      <span className="record-title">{dealer.name}</span>
                      <span className="record-value">{offersOf(dealer.active_offers)}</span>
                    </span>
                    {meta ? <span className="record-meta">{meta}</span> : null}
                  </button>
                  {dealer.website ? (
                    <div className="record-actions">
                      <a
                        className="btn btn-sm"
                        href={dealer.website}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Abrir la web de ${dealer.name}`}
                      >
                        Web ↗
                      </a>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="table-wrap">
            <table className="records">
              <thead>
                <tr>
                  <th>Dealer</th>
                  <th>Ciudad</th>
                  <th className="num">Valoración</th>
                  <th className="num">Ofertas activas</th>
                  <th className="num">Dto. medio</th>
                  <th className="num">Mejor precio</th>
                  <th>Web</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((dealer) => (
                  <tr key={dealer.id}>
                    <td className="cell-primary">
                      {dealer.name}
                      {dealer.is_active ? null : (
                        <span style={{ marginLeft: 6 }}>
                          <Chip tone="neutral">Inactivo</Chip>
                        </span>
                      )}
                    </td>
                    <td className="cell-muted">
                      {dealer.city ?? "—"}
                      {dealer.country ? (
                        <span className="tiny muted"> · {dealer.country}</span>
                      ) : null}
                    </td>
                    <td className="num">
                      {dealer.rating === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <Chip
                          tone={
                            dealer.rating >= 4.3
                              ? "positive"
                              : dealer.rating >= 3.5
                                ? "warm"
                                : "negative"
                          }
                        >
                          {dealer.rating.toFixed(1)} ★
                        </Chip>
                      )}
                    </td>
                    <td className="num">{dealer.active_offers}</td>
                    <td className="num cell-muted">{formatPct(dealer.avg_discount_pct)}</td>
                    <td className="num">{formatPrice(dealer.best_price)}</td>
                    <td className="cell-muted">
                      {dealer.website ? (
                        <a
                          className="cell-link"
                          href={dealer.website}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {dealer.website.replace(/^https?:\/\//, "")} ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditing({ dealer })}
                          title="Editar el dealer"
                        >
                          Editar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing ? (
        <DealerDrawer
          dealer={editing.dealer}
          known={items}
          onPickExisting={(dealer) => setEditing({ dealer })}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            dealers.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Alta y edición en el mismo panel. Al crear, avisa si el slug ya existe y
 * ofrece editar ese dealer en lugar de estrellarse contra el 409 del backend:
 * los dealers los crea el scraper solos, así que el caso normal es *corregir*
 * uno existente, no crear uno desde cero.
 */
function DealerDrawer({
  dealer,
  known,
  onPickExisting,
  onClose,
  onSaved,
}: {
  dealer: DealerWithStats | null;
  known: DealerWithStats[];
  onPickExisting: (dealer: DealerWithStats) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(dealer?.name ?? "");
  const [website, setWebsite] = useState(dealer?.website ?? "");
  const [city, setCity] = useState(dealer?.city ?? "");
  const [country, setCountry] = useState(dealer?.country ?? "ES");
  const [rating, setRating] = useState(dealer?.rating != null ? String(dealer.rating) : "");
  const [notes, setNotes] = useState(dealer?.notes ?? "");
  const [isActive, setIsActive] = useState(dealer?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Solo al crear: ¿hay ya un dealer con este mismo slug?
  const duplicate =
    dealer === null && name.trim()
      ? (known.find((candidate) => candidate.slug === slugify(name)) ?? null)
      : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        website: website.trim() || null,
        city: city.trim() || null,
        country: country.trim().toUpperCase() || null,
        rating: rating.trim() === "" ? null : Number(rating),
        notes: notes.trim() || null,
      };

      if (dealer) {
        await api.patch(`/dealers/${dealer.id}`, { ...body, is_active: isActive });
      } else {
        await api.post("/dealers", body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el dealer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={dealer ? dealer.name : "Nuevo dealer"}
      subtitle={dealer ? `slug ${dealer.slug} · ${dealer.active_offers} ofertas activas` : undefined}
      onClose={onClose}
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {duplicate ? (
        <Banner kind="warn">
          Ya existe <strong>{duplicate.name}</strong> con este mismo slug.{" "}
          <button
            className="btn btn-sm"
            type="button"
            style={{ marginLeft: 6 }}
            onClick={() => onPickExisting(duplicate)}
          >
            Editarlo
          </button>
        </Banner>
      ) : null}

      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="name">Nombre</label>
          <input
            id="name"
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="website">Web</label>
          <input
            id="website"
            className="input"
            placeholder="https://…"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>
        <div className="row">
          <div className="field grow">
            <label htmlFor="city">Ciudad</label>
            <input
              id="city"
              className="input"
              value={city}
              onChange={(event) => setCity(event.target.value)}
            />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="country">País</label>
            <input
              id="country"
              className="input"
              maxLength={2}
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label htmlFor="rating">Valoración</label>
            <input
              id="rating"
              className="input"
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={rating}
              onChange={(event) => setRating(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="notes">Notas</label>
          <textarea
            id="notes"
            className="textarea"
            placeholder="Ej: tarda en responder, pero los precios son reales"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        {dealer ? (
          <label className="row tiny muted">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            Activo — al desactivarlo desaparece de los listados, pero sus ofertas se conservan
          </label>
        ) : null}

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {dealer ? "Guardar" : "Crear"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Drawer>
  );
}
