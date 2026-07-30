import { useState } from "react";

import { PageHeader } from "../components/Layout";
import { Banner, Chip, Empty, Loading, Metric, Score } from "../components/ui";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  FUEL_LABELS,
  formatDate,
  formatKm,
  formatNumber,
  formatPct,
  formatPrice,
  VERDICT_LABELS,
} from "../lib/format";
import { useAsync, useDebounced } from "../lib/hooks";
import type {
  CarModelWithStats,
  DealerWithStats,
  Offer,
  OverviewStats,
  Page,
} from "../types";

const SORTS: { value: string; label: string }[] = [
  { value: "value_score", label: "Mejor valor" },
  { value: "ai_score", label: "Puntuación IA" },
  { value: "price", label: "Precio ↑" },
  { value: "-price", label: "Precio ↓" },
  { value: "mileage_km", label: "Menos km" },
  { value: "-year", label: "Más nuevo" },
  { value: "-first_seen_at", label: "Más recientes" },
];

const PAGE_SIZE = 50;

export function OffersPage() {
  const [search, setSearch] = useState("");
  const [modelId, setModelId] = useState("");
  const [dealerId, setDealerId] = useState("");
  const [condition, setCondition] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState("value_score");
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [page, setPage] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [favBusyId, setFavBusyId] = useState<number | null>(null);

  const debouncedSearch = useDebounced(search);
  const debouncedMaxPrice = useDebounced(maxPrice);

  const stats = useAsync<OverviewStats>(() => api.get("/stats/overview"), []);
  const models = useAsync<CarModelWithStats[]>(() => api.get("/car-models"), []);
  const dealers = useAsync<DealerWithStats[]>(() => api.get("/dealers"), []);

  const offers = useAsync<Page<Offer>>(
    () =>
      api.get("/offers", {
        q: debouncedSearch || undefined,
        car_model_id: modelId || undefined,
        dealer_id: dealerId || undefined,
        condition: condition || undefined,
        max_price: debouncedMaxPrice || undefined,
        tracked_only: trackedOnly || undefined,
        favorites_only: favoritesOnly || undefined,
        status: showDismissed ? "dismissed" : undefined,
        sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [
      debouncedSearch,
      modelId,
      dealerId,
      condition,
      debouncedMaxPrice,
      trackedOnly,
      favoritesOnly,
      showDismissed,
      sort,
      page,
    ],
  );

  function resetPageAnd<T>(setter: (value: T) => void) {
    return (value: T) => {
      setPage(0);
      setter(value);
    };
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

      const current = offers.data;
      if (current) {
        // Si estamos viendo solo favoritos, al desmarcar la fila desaparece.
        const drop = favoritesOnly && !updated.is_favorite;
        offers.setData({
          ...current,
          items: drop
            ? current.items.filter((item) => item.id !== updated.id)
            : current.items.map((item) => (item.id === updated.id ? updated : item)),
          total: drop ? Math.max(0, current.total - 1) : current.total,
        });
      }

      const currentStats = stats.data;
      if (currentStats) {
        stats.setData({
          ...currentStats,
          favorite_offers: Math.max(
            0,
            currentStats.favorite_offers + (updated.is_favorite ? 1 : -1),
          ),
        });
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "No se pudo actualizar el favorito",
      );
    } finally {
      setFavBusyId(null);
    }
  }

  async function dismiss(offer: Offer) {
    if (!confirm(`¿Descartar "${offer.title}" de la lista?`)) return;
    setActionError(null);
    try {
      await api.delete(`/offers/${offer.id}`);
      offers.reload();
      stats.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo descartar");
    }
  }

  async function restore(offer: Offer) {
    setActionError(null);
    try {
      await api.post(`/offers/${offer.id}/restore`);
      offers.reload();
      stats.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo restaurar");
    }
  }

  const total = offers.data?.total ?? 0;
  const items = offers.data?.items ?? [];
  const overview = stats.data;

  return (
    <>
      <PageHeader
        title="Ofertas"
        meta={total ? `${formatNumber(total)} resultados` : undefined}
        actions={
          <button className="btn btn-sm" onClick={() => offers.reload()}>
            Actualizar
          </button>
        }
      />

      <div className="content">
        {overview && !overview.ai_enabled ? (
          <Banner kind="warn">
            El ranking con IA está desactivado: define <code>ANTHROPIC_API_KEY</code> en el
            entorno del backend para activarlo.
          </Banner>
        ) : null}

        <div className="metric-grid">
          <Metric
            label="Ofertas activas"
            value={formatNumber(overview?.active_offers ?? 0)}
            hint={`${formatNumber(overview?.dismissed_offers ?? 0)} descartadas · ${formatNumber(
              overview?.favorite_offers ?? 0,
            )} favoritas`}
          />
          <Metric label="Dealers" value={formatNumber(overview?.dealers ?? 0)} />
          <Metric
            label="Modelos"
            value={formatNumber(overview?.car_models ?? 0)}
            hint={`${formatNumber(overview?.tracked_models ?? 0)} en seguimiento`}
          />
          <Metric
            label="Descuento medio"
            value={formatPct(overview?.avg_discount_pct)}
            hint="sobre PVP anunciado"
          />
          <Metric
            label="Mejor chollo"
            value={formatPrice(overview?.best_deal?.price)}
            hint={overview?.best_deal?.car_model.display_name ?? "—"}
          />
        </div>

        <div className="filters">
          <div className="field grow">
            <label htmlFor="q">Buscar</label>
            <input
              id="q"
              className="input"
              placeholder="Título de la oferta…"
              value={search}
              onChange={(event) => resetPageAnd(setSearch)(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="model">Modelo</label>
            <select
              id="model"
              className="select"
              value={modelId}
              onChange={(event) => resetPageAnd(setModelId)(event.target.value)}
            >
              <option value="">Todos</option>
              {(models.data ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name} ({model.active_offers})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="dealer">Dealer</label>
            <select
              id="dealer"
              className="select"
              value={dealerId}
              onChange={(event) => resetPageAnd(setDealerId)(event.target.value)}
            >
              <option value="">Todos</option>
              {(dealers.data ?? []).map((dealer) => (
                <option key={dealer.id} value={dealer.id}>
                  {dealer.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="condition">Estado</label>
            <select
              id="condition"
              className="select"
              value={condition}
              onChange={(event) => resetPageAnd(setCondition)(event.target.value)}
            >
              <option value="">Cualquiera</option>
              {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="maxPrice">Precio máx.</label>
            <input
              id="maxPrice"
              className="input"
              type="number"
              min={0}
              step={500}
              style={{ width: 110 }}
              placeholder="€"
              value={maxPrice}
              onChange={(event) => resetPageAnd(setMaxPrice)(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="sort">Ordenar</label>
            <select
              id="sort"
              className="select"
              value={sort}
              onChange={(event) => resetPageAnd(setSort)(event.target.value)}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <label className="row tiny muted" style={{ height: 28 }}>
            <input
              type="checkbox"
              checked={trackedOnly}
              onChange={(event) => resetPageAnd(setTrackedOnly)(event.target.checked)}
            />
            Solo seguidos
          </label>

          <label className="row tiny muted" style={{ height: 28 }}>
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={(event) => resetPageAnd(setFavoritesOnly)(event.target.checked)}
            />
            Solo favoritos
          </label>

          <label className="row tiny muted" style={{ height: 28 }}>
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(event) => resetPageAnd(setShowDismissed)(event.target.checked)}
            />
            Descartadas
          </label>
        </div>

        {actionError ? <Banner kind="error">{actionError}</Banner> : null}
        {offers.error ? <Banner kind="error">{offers.error}</Banner> : null}

        <div className="table-wrap">
          {offers.loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty
              title="No hay ofertas que cumplan el filtro"
              hint={
                favoritesOnly
                  ? "Marca ofertas con la estrella para que aparezcan aquí."
                  : "El servicio scraper alimenta esta tabla vía POST /api/v1/offers/bulk."
              }
            />
          ) : (
            <table className="records">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <span className="sr-only">Favorito</span>
                  </th>
                  <th style={{ width: 44 }}>IA</th>
                  <th>Oferta</th>
                  <th>Dealer</th>
                  <th className="num">Precio</th>
                  <th className="num">vs mediana</th>
                  <th className="num">Dto.</th>
                  <th className="num">Año</th>
                  <th className="num">Km</th>
                  <th>Combustible</th>
                  <th>Estado</th>
                  <th className="num">Valor</th>
                  <th className="num">Días</th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((offer) => (
                  <tr key={offer.id}>
                    <td>
                      <button
                        className={`star${offer.is_favorite ? " on" : ""}`}
                        disabled={favBusyId === offer.id}
                        aria-pressed={offer.is_favorite}
                        aria-label={
                          offer.is_favorite ? "Quitar de favoritos" : "Marcar como favorito"
                        }
                        title={offer.is_favorite ? "Quitar de favoritos" : "Marcar como favorito"}
                        onClick={() => toggleFavorite(offer)}
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

                    <td>
                      <a
                        className="cell-primary cell-link"
                        href={offer.url}
                        target="_blank"
                        rel="noreferrer"
                        title={offer.title}
                        style={{ display: "block" }}
                      >
                        {offer.title}
                      </a>
                    </td>

                    <td className="cell-muted">
                      {offer.dealer.name}
                      {offer.dealer.rating ? (
                        <span className="tiny muted"> · {offer.dealer.rating.toFixed(1)}★</span>
                      ) : null}
                    </td>

                    <td className="num" style={{ fontWeight: 500 }}>
                      {formatPrice(offer.price)}
                    </td>

                    <td className="num">
                      {offer.metrics.price_vs_median_pct === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <Chip
                          tone={
                            offer.metrics.price_vs_median_pct <= -5
                              ? "positive"
                              : offer.metrics.price_vs_median_pct >= 5
                                ? "negative"
                                : "neutral"
                          }
                        >
                          {formatPct(offer.metrics.price_vs_median_pct, true)}
                        </Chip>
                      )}
                    </td>

                    <td className="num">
                      {offer.metrics.discount_pct ? (
                        <Chip tone="warm">{formatPct(offer.metrics.discount_pct)}</Chip>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>

                    <td className="num cell-muted">{offer.year ?? "—"}</td>
                    <td className="num cell-muted">{formatKm(offer.mileage_km)}</td>

                    <td className="cell-muted">
                      {offer.fuel_type ? FUEL_LABELS[offer.fuel_type] : "—"}
                    </td>

                    <td>
                      <Chip tone={offer.condition === "used" ? "neutral" : "accent"}>
                        {CONDITION_LABELS[offer.condition]}
                      </Chip>
                    </td>

                    <td className="num">
                      <Score value={offer.metrics.value_score} />
                    </td>

                    <td className="num cell-muted" title={`Vista el ${formatDate(offer.first_seen_at)}`}>
                      {offer.metrics.days_listed}
                    </td>

                    <td>
                      <div className="row-actions">
                        {offer.status === "dismissed" ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => restore(offer)}
                            title="Restaurar en la lista"
                          >
                            Restaurar
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-sm btn-danger"
                            onClick={() => dismiss(offer)}
                            title="Descartar de la lista"
                          >
                            Descartar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {total > PAGE_SIZE ? (
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <span className="tiny muted">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} de{" "}
              {formatNumber(total)}
            </span>
            <button
              className="btn btn-sm"
              disabled={page === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              Anterior
            </button>
            <button
              className="btn btn-sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              Siguiente
            </button>
          </div>
        ) : null}

        {sort === "value_score" || sort === "ai_score" ? (
          <p className="tiny muted" style={{ marginTop: 10 }}>
            Ordenar por puntuación evalúa hasta 500 ofertas coincidentes; para catálogos más
            grandes, filtra por modelo o dealer.
          </p>
        ) : null}
      </div>
    </>
  );
}
