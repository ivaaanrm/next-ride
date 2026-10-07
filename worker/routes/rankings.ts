/**
 * Disparo y consulta de los rankings del agente de IA.
 *
 * El binomio va en query y no en la ruta: la clave lleva una barra vertical y
 * espacios («audi|a4 allroad quattro»), y un segmento de ruta con eso dentro
 * depende de que nadie normalice el porcentaje por el camino.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { router, type AppEnv } from "../app";
import { carModels, offerRankings, offers, rankingRuns, type RankingRun } from "../db/schema";
import { inList } from "../lib/db";
import { ApiError, conflict, notFound, parseBody, parseId, parseQuery, qInt } from "../lib/http";
import { mode } from "../lib/stats";
import { requireUser } from "../middleware";
import { RankingRequest, rankingSettings } from "../services/ranking-agent";
import { loadOffers, serializeOffers } from "../services/serialize";

const runRead = (run: RankingRun) => ({
  id: run.id,
  make_model_key: run.make_model_key,
  label: run.label,
  status: run.status,
  model_used: run.model_used,
  effort: run.effort,
  offers_considered: run.offers_considered,
  iterations: run.iterations,
  input_tokens: run.input_tokens,
  output_tokens: run.output_tokens,
  summary: run.summary,
  error: run.error,
  created_at: run.created_at,
  finished_at: run.finished_at,
});

async function loadDetail(c: Context<AppEnv>, runId: number) {
  const db = c.var.db;
  const [run] = await db.select().from(rankingRuns).where(eq(rankingRuns.id, runId));
  if (!run) throw notFound("Run no encontrado");

  const items = await db
    .select()
    .from(offerRankings)
    .where(eq(offerRankings.run_id, runId))
    .orderBy(asc(offerRankings.rank));
  const list = items.length
    ? await loadOffers(db, {
        where: inList(
          offers.id,
          items.map((item) => item.offer_id),
        ),
      })
    : [];
  const serialized = new Map(
    (await serializeOffers(db, list, c.var.user.id)).map((offer) => [offer.id, offer]),
  );

  return {
    ...runRead(run),
    tool_trace: run.tool_trace,
    items: items.map((item) => ({
      id: item.id,
      offer_id: item.offer_id,
      rank: item.rank,
      score: item.score,
      verdict: item.verdict,
      reasoning: item.reasoning,
      pros: item.pros,
      cons: item.cons,
      offer: serialized.get(item.offer_id) ?? null,
    })),
  };
}

const KeyQuery = z.object({ key: z.string().min(1) });

// `requireUser` va en cada ruta y no con `use()`: este router se monta en la
// raíz de /api/v1, y un `use()` ahí convertiría cualquier ruta desconocida en
// un 401 en lugar de un 404.
export const rankingsRoutes = router();

/**
 * Lanza el agente sobre las ofertas activas del binomio. Responde 202 de
 * inmediato: el run se completa en un Workflow y se consulta con
 * `GET /ranking-runs/{id}`.
 */
rankingsRoutes.post("/car-model-groups/rank", requireUser, async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    throw new ApiError(503, "El ranking con IA no está configurado (falta ANTHROPIC_API_KEY)");
  }
  const { key } = parseQuery(c, KeyQuery);
  const request = await parseBody(c, RankingRequest);
  const db = c.var.db;

  // La etiqueta es la grafía más frecuente entre las versiones, igual que en el
  // listado agrupado: la clave viene en minúsculas y no vale para enseñarla.
  const versions = await db
    .select({ make: carModels.make, model: carModels.model })
    .from(carModels)
    .where(eq(carModels.make_model_key, key));
  if (!versions.length) throw notFound(`Binomio '${key}' no encontrado`);
  const label = `${mode(versions.map((v) => v.make))} ${mode(versions.map((v) => v.model))}`;

  const [inFlight] = await db
    .select({ id: rankingRuns.id })
    .from(rankingRuns)
    .where(
      and(eq(rankingRuns.make_model_key, key), inArray(rankingRuns.status, ["pending", "running"])),
    )
    .limit(1);
  if (inFlight) {
    throw conflict(`Ya hay un ranking en curso para este modelo (run ${inFlight.id})`);
  }

  const settings = rankingSettings(c.env);
  const [run] = await db
    .insert(rankingRuns)
    .values({
      make_model_key: key,
      label,
      triggered_by_id: c.var.user.id,
      status: "pending",
      model_used: settings.model,
      effort: settings.effort,
      request,
    })
    .returning();

  try {
    await c.env.RANKING_WORKFLOW.create({ id: `ranking-run-${run.id}`, params: { runId: run.id } });
  } catch (error) {
    await db
      .update(rankingRuns)
      .set({ status: "failed", error: `No se pudo lanzar el Workflow: ${String(error)}` })
      .where(eq(rankingRuns.id, run.id));
    throw error;
  }
  return c.json(runRead(run), 202);
});

/** Último ranking completado del binomio, con todas las ofertas valoradas. */
rankingsRoutes.get("/car-model-groups/ranking", requireUser, async (c) => {
  const { key } = parseQuery(c, KeyQuery);
  const [run] = await c.var.db
    .select({ id: rankingRuns.id })
    .from(rankingRuns)
    .where(and(eq(rankingRuns.make_model_key, key), eq(rankingRuns.status, "completed")))
    .orderBy(desc(rankingRuns.created_at), desc(rankingRuns.id))
    .limit(1);
  if (!run) throw notFound("Este modelo no tiene todavía ningún ranking completado");
  return c.json(await loadDetail(c, run.id));
});

rankingsRoutes.get("/car-model-groups/ranking-runs", requireUser, async (c) => {
  const { key, limit } = parseQuery(c, KeyQuery.extend({ limit: qInt().default(20) }));
  const runs = await c.var.db
    .select()
    .from(rankingRuns)
    .where(eq(rankingRuns.make_model_key, key))
    .orderBy(desc(rankingRuns.created_at), desc(rankingRuns.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return c.json(runs.map(runRead));
});

/** Estado y resultado de un run. Se usa para hacer polling tras el 202. */
rankingsRoutes.get("/ranking-runs/:id", requireUser, async (c) => c.json(await loadDetail(c, parseId(c, "id"))));
