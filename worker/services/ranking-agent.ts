/**
 * Agente de IA que rankea las ofertas de un binomio marca-modelo.
 *
 * Loop agéntico manual sobre la Messages API y no el tool runner del SDK,
 * porque hace falta control explícito de tres cosas: un número acotado de
 * iteraciones, una tool terminal (`submit_ranking`) que cierra el loop con
 * salida validada contra las candidatas reales, y la persistencia de traza y
 * consumo en `ranking_runs`.
 *
 * El loop lo conduce `workflows/ranking.ts`: cada llamada al modelo es un paso
 * durable de un Workflow. Este módulo tiene todo lo demás, y lo tiene partido a
 * propósito entre lo que toca la red o la base (`buildContext`, `callModel`,
 * `persistRanking`) y lo que es puro (`runTool`): las tools se resuelven sobre
 * un contexto ya cargado, así que al rehidratar el Workflow la conversación se
 * reconstruye idéntica sin volver a consultar nada.
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  carModels,
  nowIso,
  offerPriceHistory,
  offers,
  rankingRuns,
  VERDICT,
  type Verdict,
} from "../db/schema";
import { inList, round, type Db } from "../lib/db";
import { int, nullable, num } from "../schemas/common";
import { binomioMarket, computeMetrics, firstSeenPrices } from "./metrics";
import { getScoringConfig } from "./scoring";
import { loadOffers } from "./serialize";

export class RankingError extends Error {}

/** Parámetros opcionales para orientar al agente. */
export const RankingRequest = z
  .object({
    max_budget: nullable(num(z.number().gt(0))),
    max_mileage_km: nullable(int(z.number().min(0))),
    min_year: nullable(int(z.number().min(1950).max(2100))),
    priorities: nullable(z.string().max(1000)),
  })
  .nullish()
  .transform(
    (value) =>
      value ?? { max_budget: null, max_mileage_km: null, min_year: null, priorities: null },
  );
export type RankingRequest = z.output<typeof RankingRequest>;

// --------------------------------------------------------------------------- //
// Tools
// --------------------------------------------------------------------------- //
export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "get_market_stats",
    description:
      "Estadísticas agregadas del mercado del modelo que se está analizando, con " +
      "todas sus versiones dentro: número de ofertas activas, cuántas versiones " +
      "distintas hay, precio mínimo/mediano/máximo, kilometraje y año medios y " +
      "número de dealers distintos. Úsala primero para situar el rango de precios " +
      "antes de juzgar ofertas concretas.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_offers",
    description:
      "Lista las ofertas activas candidatas con todos sus datos y las métricas ya " +
      "calculadas por la plataforma (descuento sobre PVP, desviación respecto a la " +
      "mediana, km/año, días publicada, bajada de precio y una puntuación heurística " +
      "de referencia). Es la fuente de verdad sobre qué ofertas puedes rankear.",
    input_schema: {
      type: "object",
      properties: {
        sort_by: {
          type: "string",
          enum: ["price", "value_score", "mileage", "year", "days_listed"],
          description: "Criterio de ordenación. Por defecto 'price'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_offer_price_history",
    description:
      "Historial de precios de una oferta concreta, en orden cronológico. Útil para " +
      "detectar bajadas recientes, coches estancados o precios que suben.",
    input_schema: {
      type: "object",
      properties: { offer_id: { type: "integer", description: "ID de la oferta." } },
      required: ["offer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_ranking",
    description:
      "Entrega el ranking final. Debe incluir TODAS las ofertas candidatas, cada una " +
      "con su posición, puntuación 0-100, veredicto y justificación. Llama a esta tool " +
      "una sola vez, al terminar el análisis.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "2-4 frases en español sobre el estado del mercado para este modelo " +
            "y qué debería hacer el comprador.",
        },
        rankings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              offer_id: { type: "integer" },
              rank: { type: "integer", description: "1 es la mejor oferta. Sin empates." },
              score: {
                type: "integer",
                description: "0-100. 100 es una oportunidad excepcional.",
              },
              verdict: { type: "string", enum: [...VERDICT] },
              reasoning: {
                type: "string",
                description: "1-3 frases en español justificando la posición.",
              },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
            },
            required: ["offer_id", "rank", "score", "verdict", "reasoning", "pros", "cons"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "rankings"],
      additionalProperties: false,
    },
  },
];

export const SYSTEM_PROMPT = `Eres un analista experto en compraventa de vehículos. Tu trabajo es rankear las \
ofertas de un mismo modelo procedentes de distintos dealers y decidir cuáles son \
realmente buenas oportunidades.

Las ofertas son de un modelo (marca + modelo), y dentro conviven sus **versiones**: \
motorizaciones, acabados y carrocerías distintas, en el campo \`version\` de cada \
oferta. El mercado con el que comparas es el del modelo entero —es el conjunto real \
en el que elige un comprador—, pero la versión explica buena parte de la diferencia \
de precio, así que tenla en cuenta antes de llamar cara a una y barata a otra.

Método:
1. Llama a \`get_market_stats\` para situar el rango de precios del modelo.
2. Llama a \`list_offers\` para ver las ofertas candidatas y sus métricas.
3. Si el historial de precios de alguna oferta puede cambiar tu criterio (bajadas \
recientes, coches estancados meses), consulta \`get_offer_price_history\`.
4. Cierra con una única llamada a \`submit_ranking\` incluyendo TODAS las ofertas \
candidatas.

Cómo valorar:
- El precio frente a la mediana del modelo es la señal principal, pero corrígelo \
siempre por versión, kilometraje, año, potencia y estado (nuevo / km0 / usado). Un \
coche barato con el doble de kilómetros no es una buena oferta, y una versión tope de \
gama por encima de la mediana puede seguir siéndolo.
- Desconfía del precio anormalmente bajo sin explicación: márcalo y dilo en \`cons\`.
- Un descuento anunciado grande sobre un PVP inflado no es un descuento real.
- La valoración del dealer y los días publicada son señales secundarias, útiles para \
desempatar y para estimar margen de negociación.
- La puntuación heurística que da la plataforma es una referencia, no una orden: si \
discrepas, explica por qué en \`reasoning\`.

Sé concreto y cuantitativo: cita cifras (precio, km, % sobre la mediana) en lugar de \
adjetivos. Escribe siempre en español.
`;

// --------------------------------------------------------------------------- //
// Contexto del run (serializable: es la salida de un paso del Workflow)
// --------------------------------------------------------------------------- //
interface Candidate {
  offer_id: number;
  payload: Record<string, unknown>;
  // Claves de orden de `list_offers`.
  price: number;
  value_score: number | null;
  mileage_km: number | null;
  year: number | null;
  days_listed: number;
  history: { price_eur: number; recorded_at: string }[];
}

export interface AgentContext {
  label: string;
  request: RankingRequest;
  versions: number;
  marketStats: Record<string, unknown>;
  candidates: Candidate[];
}

const roundTo = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? null : round(value, digits);

export interface RankingSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  maxIterations: number;
  maxOffers: number;
  enableFallbacks: boolean;
}

export function rankingSettings(env: Env): RankingSettings {
  const effort = String(env.ANTHROPIC_EFFORT || "high");
  return {
    model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    effort: (["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? effort
      : "high") as RankingSettings["effort"],
    maxTokens: Number(env.ANTHROPIC_MAX_TOKENS) || 16000,
    maxIterations: Number(env.RANKING_MAX_ITERATIONS) || 10,
    maxOffers: Number(env.RANKING_MAX_OFFERS) || 40,
    enableFallbacks: String(env.ANTHROPIC_ENABLE_FALLBACKS ?? "true") !== "false",
  };
}

/**
 * Las ofertas activas del binomio en la cuenta `userId`, con sus métricas
 * contra el mercado del binomio en esa cuenta. El agente no ve nada más: ni
 * ofertas ni medianas de otras cuentas.
 */
export async function buildContext(
  db: Db,
  userId: string,
  key: string,
  label: string,
  request: RankingRequest,
  maxOffers: number,
): Promise<AgentContext> {
  const [version] = await db
    .select({ id: carModels.id })
    .from(carModels)
    .where(and(eq(carModels.user_id, userId), eq(carModels.make_model_key, key)))
    .limit(1);
  if (!version) throw new RankingError(`El binomio '${key}' ya no está en el catálogo.`);

  const candidatesList = await loadOffers(db, userId, {
    where: and(eq(offers.status, "active"), eq(carModels.make_model_key, key)),
    orderBy: [asc(offers.price), asc(offers.id)],
    limit: maxOffers,
  });
  if (!candidatesList.length) throw new RankingError("No hay ofertas activas para este modelo.");

  const config = await getScoringConfig(db, userId);
  const now = new Date();
  const [market, initialPrices, history] = await Promise.all([
    binomioMarket(db, userId, [key], config.params, now),
    firstSeenPrices(
      db,
      candidatesList.map((offer) => offer.id),
    ),
    db
      .select()
      .from(offerPriceHistory)
      .where(
        inList(
          offerPriceHistory.offer_id,
          candidatesList.map((offer) => offer.id),
        ),
      )
      .orderBy(asc(offerPriceHistory.recorded_at), asc(offerPriceHistory.id)),
  ]);
  const stats = market.stats.get(key);
  const historyByOffer = Map.groupBy(history, (point) => point.offer_id);

  const candidates = candidatesList.map((offer): Candidate => {
    const metrics = computeMetrics(
      offer,
      stats,
      initialPrices.get(offer.id),
      config,
      market.anchors.get(key),
      now,
    );
    return {
      offer_id: offer.id,
      price: offer.price,
      value_score: metrics.value_score,
      mileage_km: offer.mileage_km,
      year: offer.year,
      days_listed: metrics.days_listed,
      history: (historyByOffer.get(offer.id) ?? []).map((point) => ({
        price_eur: point.price,
        recorded_at: point.recorded_at,
      })),
      payload: {
        offer_id: offer.id,
        title: offer.title,
        // La versión y su PVP son de la fila de `car_models`, no del binomio:
        // un RS3 y un 1.0 TFSI no se comparan como si fueran el mismo coche.
        version: offer.car_model.trim || null,
        version_reference_price_eur: offer.car_model.reference_price || null,
        dealer: offer.dealer.name,
        dealer_rating: offer.dealer.rating,
        dealer_city: offer.dealer.city,
        price_eur: offer.price,
        original_price_eur: offer.original_price || null,
        year: offer.year,
        mileage_km: offer.mileage_km,
        power_hp: offer.power_hp,
        condition: offer.condition,
        fuel_type: offer.fuel_type,
        transmission: offer.transmission,
        location: offer.location,
        metrics: {
          discount_pct: metrics.discount_pct,
          price_vs_median_pct: metrics.price_vs_median_pct,
          price_vs_reference_pct: metrics.price_vs_reference_pct,
          // Valor teórico por depreciación media: el precio junto a esta cifra
          // dice si el coche está caro *para lo que es*.
          expected_price_eur: metrics.expected_price_eur,
          price_vs_expected_pct: metrics.price_vs_expected_pct,
          price_drop_pct: metrics.price_drop_pct,
          km_per_year: metrics.km_per_year,
          days_listed: metrics.days_listed,
          platform_value_score: metrics.value_score,
        },
      },
    };
  });

  return {
    label,
    request,
    versions: stats?.versions ?? 0,
    marketStats: {
      model: label,
      active_offers: stats?.count ?? 0,
      // Un rango de 7.900 a 39.490 € se lee distinto sabiendo que dentro
      // conviven un 1.0 TFSI y un RS3.
      distinct_versions: stats?.versions ?? 0,
      min_price_eur: roundTo(stats?.min_price),
      median_price_eur: roundTo(stats?.median_price),
      max_price_eur: roundTo(stats?.max_price),
      avg_price_eur: roundTo(stats?.avg_price),
      avg_mileage_km: roundTo(stats?.avg_mileage_km, 0),
      avg_year: roundTo(stats?.avg_year, 1),
      distinct_dealers: stats?.dealers_count ?? 0,
    },
    candidates,
  };
}

export function userPrompt(ctx: AgentContext): string {
  const lines = [
    `Analiza y rankea las ofertas de: ${ctx.label}.`,
    `Hay ${ctx.candidates.length} ofertas candidatas activas, repartidas entre ` +
      `${ctx.versions} versiones del modelo.`,
  ];
  const req = ctx.request;
  const constraints: string[] = [];
  if (req.max_budget) constraints.push(`presupuesto máximo ${req.max_budget.toFixed(0)} EUR`);
  if (req.max_mileage_km) constraints.push(`kilometraje máximo ${req.max_mileage_km} km`);
  if (req.min_year) constraints.push(`año mínimo ${req.min_year}`);
  if (constraints.length) {
    lines.push(
      `Restricciones del comprador: ${constraints.join(", ")}. Las ofertas que no cumplan ` +
        "deben bajar de posición y llevar el motivo en `cons`; no las elimines del ranking.",
    );
  }
  if (req.priorities) lines.push(`Prioridades del comprador: ${req.priorities}`);
  lines.push("Empieza consultando las tools.");
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// Tools: puras sobre el contexto
// --------------------------------------------------------------------------- //
const SORT_KEYS: Record<string, (c: Candidate) => number> = {
  price: (c) => c.price,
  value_score: (c) => -(c.value_score ?? 0),
  mileage: (c) => c.mileage_km ?? 1e9,
  year: (c) => -(c.year ?? 0),
  days_listed: (c) => -c.days_listed,
};

/** `(contenido para el modelo, ranking final o null)`. */
export function runTool(
  ctx: AgentContext,
  name: string,
  input: Record<string, unknown>,
): [string, Record<string, unknown> | null] {
  if (name === "get_market_stats") return [JSON.stringify(ctx.marketStats), null];

  if (name === "list_offers") {
    const key = SORT_KEYS[String(input.sort_by ?? "price")] ?? SORT_KEYS.price;
    const ordered = [...ctx.candidates].sort((a, b) => key(a) - key(b));
    return [JSON.stringify(ordered.map((c) => c.payload)), null];
  }

  if (name === "get_offer_price_history") {
    const offerId = input.offer_id;
    const candidate = ctx.candidates.find((c) => c.offer_id === offerId);
    if (!candidate) {
      return [
        JSON.stringify({
          error: `offer_id ${offerId} no está entre las candidatas.`,
          valid_offer_ids: ctx.candidates.map((c) => c.offer_id).sort((a, b) => a - b),
        }),
        null,
      ];
    }
    return [JSON.stringify({ offer_id: offerId, history: candidate.history }), null];
  }

  if (name === "submit_ranking") return ["Ranking recibido.", input];

  return [JSON.stringify({ error: `Tool desconocida: ${name}` }), null];
}

// --------------------------------------------------------------------------- //
// Llamada al modelo
// --------------------------------------------------------------------------- //
/**
 * Una vuelta del modelo. Con fallbacks activados se piden los de servidor
 * (`fallbacks: "default"`): si un clasificador de seguridad declina, la API
 * reintenta en el modelo que corresponda a la categoría dentro de la misma
 * llamada. Si la cuenta no tiene el beta, se degrada a la llamada normal en
 * lugar de tumbar el run. En streaming para no chocar con tiempos de espera
 * HTTP con un `max_tokens` alto.
 */
export async function callModel(
  apiKey: string,
  settings: RankingSettings,
  messages: Anthropic.Beta.BetaMessageParam[],
): Promise<Anthropic.Beta.BetaMessage> {
  const client = new Anthropic({ apiKey });
  const params = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: SYSTEM_PROMPT,
    output_config: { effort: settings.effort },
    tools: TOOLS,
    messages,
  };
  if (settings.enableFallbacks) {
    try {
      return await client.beta.messages
        .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        .finalMessage();
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError) || !/fallback|beta/i.test(error.message)) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          message: "fallbacks de servidor no disponibles, se continúa sin ellos",
          error: error.message,
        }),
      );
    }
  }
  return client.beta.messages.stream(params).finalMessage();
}

// --------------------------------------------------------------------------- //
// Persistencia
// --------------------------------------------------------------------------- //
const INSERT_RANKINGS = `
  INSERT INTO offer_rankings (run_id, offer_id, rank, score, verdict, reasoning, pros, cons)
  SELECT ?1, json_extract(j.value, '$.offer_id'), json_extract(j.value, '$.rank'),
         json_extract(j.value, '$.score'), json_extract(j.value, '$.verdict'),
         json_extract(j.value, '$.reasoning'), json_extract(j.value, '$.pros'),
         json_extract(j.value, '$.cons')
  FROM json_each(?2) AS j`;

/**
 * Valida el ranking contra las candidatas y lo guarda. Los ids inventados o
 * duplicados se descartan en silencio: el modelo no define qué ofertas existen,
 * solo cómo se ordenan.
 */
export async function persistRanking(
  d1: D1Database,
  runId: number,
  ctx: AgentContext,
  payload: Record<string, unknown>,
  toolTrace: Record<string, unknown>[],
): Promise<void> {
  const raw = Array.isArray(payload.rankings) ? (payload.rankings as Record<string, unknown>[]) : [];
  if (!raw.length) throw new RankingError("`submit_ranking` llegó sin ofertas.");

  const valid = new Set(ctx.candidates.map((c) => c.offer_id));
  const seen = new Set<number>();
  const items: {
    offer_id: number;
    rank: number;
    score: number;
    verdict: Verdict;
    reasoning: string | null;
    pros: string[];
    cons: string[];
  }[] = [];
  for (const item of raw) {
    const offerId = item.offer_id as number;
    if (!valid.has(offerId) || seen.has(offerId)) continue;
    seen.add(offerId);
    const verdict = String(item.verdict ?? "").toLowerCase();
    items.push({
      offer_id: offerId,
      rank: Number(item.rank) || items.length + 1,
      score: Math.max(0, Math.min(100, Math.trunc(Number(item.score) || 0))),
      verdict: (VERDICT as readonly string[]).includes(verdict) ? (verdict as Verdict) : "fair",
      reasoning: String(item.reasoning ?? "").trim() || null,
      pros: ((item.pros as unknown[]) ?? []).map(String).slice(0, 6),
      cons: ((item.cons as unknown[]) ?? []).map(String).slice(0, 6),
    });
  }
  if (!items.length) throw new RankingError("Ninguna de las ofertas devueltas por el agente es válida.");

  // Se renumera por si el modelo dejó huecos o empates.
  items.sort((a, b) => a.rank - b.rank || b.score - a.score);
  items.forEach((item, position) => (item.rank = position + 1));

  await d1.batch([
    d1.prepare("DELETE FROM offer_rankings WHERE run_id = ?1").bind(runId),
    d1.prepare(INSERT_RANKINGS).bind(runId, JSON.stringify(items)),
    d1
      .prepare(
        `UPDATE ranking_runs SET summary = ?2, offers_considered = ?3, tool_trace = ?4,
           status = 'completed', finished_at = ?5 WHERE id = ?1`,
      )
      .bind(
        runId,
        String(payload.summary ?? "").trim() || null,
        ctx.candidates.length,
        JSON.stringify(toolTrace),
        nowIso(),
      ),
  ]);
}

export async function markFailed(db: Db, runId: number, error: string): Promise<void> {
  await db
    .update(rankingRuns)
    .set({ status: "failed", error, finished_at: nowIso() })
    .where(eq(rankingRuns.id, runId));
}
