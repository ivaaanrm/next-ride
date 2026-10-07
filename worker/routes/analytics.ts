/**
 * Agregados por binomio marca-modelo para la vista Analítica.
 *
 * Comparte los filtros del listado de ofertas (`OfferFilters`) por la misma
 * razón que `/offers/stats`: si divergieran, los gráficos describirían un
 * conjunto distinto del que enseña la tabla.
 *
 * Antes eran cinco consultas con `percentile_cont` y `mode()` de Postgres.
 * SQLite no los tiene, así que se trae el conjunto filtrado una vez y se pliega
 * aquí: mismas cuentas, misma interpolación, los mismos topes.
 */
import { asc } from "drizzle-orm";
import { router } from "../app";
import { offers } from "../db/schema";
import { round, roundOrNull } from "../lib/db";
import { parseQuery, qString } from "../lib/http";
import { average, maxOf, minOf, mode, percentileCont } from "../lib/stats";
import { requireUser } from "../middleware";
import { enrichOffers, type OfferWithRelations } from "../services/metrics";
import { loadOffers } from "../services/serialize";
import { OfferFilters, filterConditions } from "./offers";

/** Binomios que devuelve el selector: una lista de opciones, no una descarga. */
const SEGMENT_CAP = 40;
/** Binomios con detalle: las ranuras de color que la paleta separa bajo daltonismo. */
const DETAIL_CAP = 3;
/** Ofertas puntuadas por binomio (`value_score` se calcula aquí, se acota). */
const POINT_CAP = 600;
/** Dealers por binomio en la barra de stock: más allá de ocho deja de comparar. */
const DEALER_CAP = 8;
/** Tope de filas que se traen para agregar. Muy por encima del catálogo real. */
const ROW_CAP = 20_000;

interface SegmentPoint {
  id: number;
  price: number;
  mileage_km: number | null;
  year: number | null;
  km_per_year: number | null;
  value_score: number | null;
  discount_pct: number | null;
  dealer: string;
  trim: string;
  title: string;
}

/**
 * Mínimos cuadrados de precio sobre kilómetros, aquí y no en el navegador para
 * que la cifra de la tabla y la recta dibujada sean la misma cuenta. Con menos
 * de cuatro ofertas no se devuelve nada: una recta por dos puntos siempre ajusta.
 */
function fitTrend(points: SegmentPoint[]) {
  const sample = points.flatMap((p) => (p.mileage_km !== null ? [[p.mileage_km, p.price]] : []));
  const n = sample.length;
  if (n < 4) return null;
  const meanX = sample.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = sample.reduce((sum, [, y]) => sum + y, 0) / n;
  const sxx = sample.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  if (sxx === 0) return null;
  const sxy = sample.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const slope = sxy / sxx;
  const syy = sample.reduce((sum, [, y]) => sum + (y - meanY) ** 2, 0);
  return {
    slope,
    intercept: meanY - slope * meanX,
    r2: round(syy > 0 ? sxy ** 2 / (sxx * syy) : 0, 3),
    n,
    // Lo que el mercado cobra por cada 10.000 km *menos*: la pendiente es
    // negativa en un mercado normal, así que se le da la vuelta.
    price_per_10k_km: round(-slope * 10_000, 0),
  };
}

const kmPerYear = (offer: OfferWithRelations, nowYear: number) =>
  offer.mileage_km !== null && offer.year !== null
    ? offer.mileage_km / Math.max(nowYear - offer.year, 1)
    : null;

const discount = (offer: OfferWithRelations) =>
  offer.original_price && offer.original_price > 0
    ? ((offer.original_price - offer.price) / offer.original_price) * 100
    : null;

function tally(values: (string | null)[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value ?? "unknown", (counts.get(value ?? "unknown") ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => ({ key, offers: n }));
}

export const analyticsRoutes = router();
analyticsRoutes.use(requireUser);

analyticsRoutes.get("/segments", async (c) => {
  const { keys, ...filters } = parseQuery(c, OfferFilters.extend({ keys: qString }));
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  const nowYear = new Date().getUTCFullYear();

  // Ordenadas por precio: es el orden en que se recortan los puntos.
  const rows = await loadOffers(db, tenantId, {
    where: filterConditions(filters, tenantId),
    orderBy: [asc(offers.price), asc(offers.id)],
    limit: ROW_CAP,
  });
  const byKey = Map.groupBy(rows, (offer) => offer.car_model.make_model_key);

  // ---- Cabecera: agregados de todos los binomios ----------------------------- //
  const ordered = [...byKey.entries()]
    .sort(([keyA, a], [keyB, b]) => b.length - a.length || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
    .slice(0, SEGMENT_CAP);

  const segments = ordered.map(([key, group]) => {
    const prices = group.map((offer) => offer.price);
    // La grafía más frecuente, no la que gane alfabéticamente.
    const make = mode(group.map((offer) => offer.car_model.make)) ?? "";
    const model = mode(group.map((offer) => offer.car_model.model)) ?? "";
    return {
      key,
      make,
      model,
      label: `${make} ${model}`,
      offers: group.length,
      dealers: new Set(group.map((offer) => offer.dealer_id)).size,
      trims: new Set(group.map((offer) => offer.car_model_id)).size,
      min_price: roundOrNull(minOf(prices)),
      p25_price: roundOrNull(percentileCont(prices, 0.25)),
      median_price: roundOrNull(percentileCont(prices, 0.5)),
      p75_price: roundOrNull(percentileCont(prices, 0.75)),
      max_price: roundOrNull(maxOf(prices)),
      avg_price: roundOrNull(average(prices)),
      avg_mileage_km: roundOrNull(average(group.map((offer) => offer.mileage_km)), 0),
      avg_year: roundOrNull(average(group.map((offer) => offer.year)), 1),
      avg_km_per_year: roundOrNull(average(group.map((offer) => kmPerYear(offer, nowYear))), 0),
      avg_discount_pct: roundOrNull(average(group.map(discount))),
      // Solo en los binomios con detalle: dependen de la puntuación.
      detailed: false,
      offers_sampled: 0,
      avg_value_score: null as number | null,
      trend: null as ReturnType<typeof fitTrend>,
      by_year: [] as { year: number; offers: number; median_price: number }[],
      by_dealer: [] as {
        dealer_id: number;
        dealer: string;
        offers: number;
        median_price: number;
        min_price: number;
      }[],
      mix: { fuel: [], transmission: [], condition: [] } as Record<
        "fuel" | "transmission" | "condition",
        { key: string; offers: number }[]
      >,
      points: [] as SegmentPoint[],
    };
  });
  const segmentByKey = new Map(segments.map((segment) => [segment.key, segment]));

  const requested = (keys ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  let detailKeys = requested.filter((key) => segmentByKey.has(key)).slice(0, DETAIL_CAP);
  // Sin selección, los binomios con más oferta: es lo que se mira de todas formas.
  if (!detailKeys.length) detailKeys = segments.slice(0, DETAIL_CAP).map((segment) => segment.key);

  const result = {
    segments,
    detail_keys: detailKeys,
    offers: segments.reduce((sum, segment) => sum + segment.offers, 0),
    max_detail: DETAIL_CAP,
  };
  if (!detailKeys.length) return c.json(result);

  // ---- Detalle ---------------------------------------------------------------- //
  // `offers_sampled` dice sobre cuántas ofertas se calculó la puntuación, para
  // que no se lea como si describiera todo el binomio cuando no lo hace.
  // Las más baratas de todos los binomios con detalle juntos, y luego el tope
  // por binomio: el mismo recorte que hacía la consulta de antes.
  const detailSet = new Set(detailKeys);
  const sampled = rows
    .filter((offer) => detailSet.has(offer.car_model.make_model_key))
    .slice(0, POINT_CAP * DETAIL_CAP);
  const sampledByKey = Map.groupBy(sampled, (offer) => offer.car_model.make_model_key);
  const metrics = await enrichOffers(db, tenantId, sampled);

  for (const key of detailKeys) {
    const segment = segmentByKey.get(key)!;
    const group = byKey.get(key)!;
    segment.detailed = true;

    // Precio por año de matriculación.
    const byYear = Map.groupBy(
      group.filter((offer) => offer.year !== null),
      (offer) => offer.year!,
    );
    segment.by_year = [...byYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, items]) => ({
        year,
        offers: items.length,
        median_price: round(percentileCont(items.map((offer) => offer.price), 0.5)!, 2),
      }));

    // Stock por dealer.
    segment.by_dealer = [...Map.groupBy(group, (offer) => offer.dealer_id).entries()]
      .map(([dealerId, items]) => {
        const prices = items.map((offer) => offer.price);
        return {
          dealer_id: dealerId,
          dealer: items[0].dealer.name,
          offers: items.length,
          median_price: round(percentileCont(prices, 0.5)!, 2),
          min_price: round(Math.min(...prices), 2),
        };
      })
      .sort((a, b) => b.offers - a.offers || a.min_price - b.min_price)
      .slice(0, DEALER_CAP);

    // Composición: combustible, cambio y estado.
    segment.mix = {
      fuel: tally(group.map((offer) => offer.fuel_type)),
      transmission: tally(group.map((offer) => offer.transmission)),
      condition: tally(group.map((offer) => offer.condition)),
    };

    // Nube de puntos y puntuación de valor.
    segment.points = (sampledByKey.get(key) ?? []).slice(0, POINT_CAP).map((offer) => {
      const metric = metrics.get(offer.id)!;
      return {
        id: offer.id,
        price: offer.price,
        mileage_km: offer.mileage_km,
        year: offer.year,
        km_per_year: metric.km_per_year,
        value_score: metric.value_score,
        discount_pct: metric.discount_pct,
        dealer: offer.dealer.name,
        trim: offer.car_model.trim,
        title: offer.title,
      };
    });
    segment.offers_sampled = segment.points.length;
    const scores = segment.points.flatMap((p) => (p.value_score !== null ? [p.value_score] : []));
    segment.avg_value_score = scores.length
      ? round(scores.reduce((sum, score) => sum + score, 0) / scores.length, 1)
      : null;
    segment.trend = fitTrend(segment.points);
  }

  return c.json(result);
});

