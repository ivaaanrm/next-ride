/**
 * El Workflow del agente, de punta a punta, con lo único externo sustituido:
 * las vueltas del modelo (`model-turn-N`) se simulan con el contrato de la
 * Messages API. La carga del contexto, las tools y la persistencia son reales.
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { account, offerPayload, unique, type Client } from "./client";

/** Tres ofertas de un binomio en la cuenta, y un run pendiente suyo sobre ellas. */
async function seedRun({ scraper, id: userId }: { scraper: Client; id: string }) {
  const make = unique("Agente");
  const { offer_ids: ids } = (
    await scraper.post("/api/v1/offers/bulk", {
      offers: [
        offerPayload({ make, model: "W", trim: "a", price: 18000 }),
        offerPayload({ make, model: "W", trim: "b", price: 21000 }),
        offerPayload({ make, model: "W", trim: "c", price: 25000 }),
      ],
    })
  ).body as { offer_ids: number[] };
  const key = `${make.toLowerCase()}|w`;
  const run = await env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, make_model_key, label, status, request) VALUES (?4, ?1, ?2, 'pending', ?3) RETURNING id`,
  )
    .bind(key, `${make} W`, JSON.stringify({ max_budget: 22000 }), userId)
    .first<{ id: number }>();
  return { key, ids, runId: run!.id };
}

const turn = (content: unknown[], stopReason: string) =>
  JSON.stringify({ content, stopReason, refusalCategory: null });

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});

describe("RankingWorkflow", () => {
  it("investiga con las tools, entrega el ranking y lo guarda validado", async () => {
    const owner = await account();
    const { user } = owner;
    const { key, ids, runId } = await seedRun(owner);
    const instanceId = `ranking-run-${runId}`;
    await using instance = await introspectWorkflowInstance(env.RANKING_WORKFLOW, instanceId);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: "model-turn-1" },
        turn(
          [
            { type: "thinking", thinking: "", signature: "sig" },
            toolUse("t1", "get_market_stats"),
            toolUse("t2", "list_offers", { sort_by: "price" }),
            toolUse("t3", "get_offer_price_history", { offer_id: ids[0] }),
          ],
          "tool_use",
        ),
      );
      await m.mockStepResult(
        { name: "model-turn-2" },
        turn(
          [
            toolUse("t4", "submit_ranking", {
              summary: "  Mercado estrecho; el más barato es la compra.  ",
              rankings: [
                { offer_id: ids[0], rank: 1, score: 88, verdict: "EXCELLENT", reasoning: "barato", pros: ["precio"], cons: [] },
                // Inventado y duplicado: se descartan en silencio.
                { offer_id: 999999, rank: 2, score: 70, verdict: "good", reasoning: "x", pros: [], cons: [] },
                { offer_id: ids[0], rank: 3, score: 10, verdict: "poor", reasoning: "dup", pros: [], cons: [] },
                { offer_id: ids[2], rank: 5, score: 150, verdict: "rarísimo", reasoning: "", pros: [], cons: ["sobre presupuesto"] },
                { offer_id: ids[1], rank: 5, score: 60, verdict: "good", reasoning: "ok", pros: [], cons: [] },
              ],
            }),
          ],
          "tool_use",
        ),
      );
    });

    await env.RANKING_WORKFLOW.create({ id: instanceId, params: { runId } });
    await instance.waitForStatus("complete");

    const detail = (await user.get(`/api/v1/ranking-runs/${runId}`)).body;
    expect(detail).toMatchObject({
      status: "completed",
      summary: "Mercado estrecho; el más barato es la compra.",
      offers_considered: 3,
      effort: "high",
    });
    expect(detail.tool_trace.map((t: { tool: string }) => t.tool)).toEqual([
      "get_market_stats",
      "list_offers",
      "get_offer_price_history",
      "submit_ranking",
    ]);
    // Renumerado sin huecos; empate en el 5 resuelto por puntuación; tope 100;
    // veredicto desconocido a «fair».
    expect(
      detail.items.map((i: { offer_id: number; rank: number; score: number; verdict: string }) => [
        i.offer_id,
        i.rank,
        i.score,
        i.verdict,
      ]),
    ).toEqual([
      [ids[0], 1, 88, "excellent"],
      [ids[2], 2, 100, "fair"],
      [ids[1], 3, 60, "good"],
    ]);
    expect(detail.items[0].offer.ai).toMatchObject({ rank: 1, run_id: runId });

    const latest = (await user.get(`/api/v1/car-model-groups/ranking?key=${encodeURIComponent(key)}`)).body;
    expect(latest.id).toBe(runId);
  });

  it("un turno sin `submit_ranking` deja el run fallido con el motivo", async () => {
    const owner = await account();
    const { user } = owner;
    const { runId } = await seedRun(owner);
    const instanceId = `ranking-run-${runId}`;
    await using instance = await introspectWorkflowInstance(env.RANKING_WORKFLOW, instanceId);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: "model-turn-1" },
        turn([{ type: "text", text: "No puedo." }], "end_turn"),
      );
    });
    await env.RANKING_WORKFLOW.create({ id: instanceId, params: { runId } });
    await instance.waitForStatus("complete");

    const run = (await user.get(`/api/v1/ranking-runs/${runId}`)).body;
    expect(run).toMatchObject({
      status: "failed",
      error: "El agente terminó el turno sin llamar a `submit_ranking`.",
      items: [],
    });
    expect(run.finished_at).not.toBeNull();
  });

  it("sin clave de API, la primera vuelta falla sin reintentar y el run queda fallido", async () => {
    const owner = await account();
    const { user } = owner;
    const { runId } = await seedRun(owner);
    const instanceId = `ranking-run-${runId}`;
    await using instance = await introspectWorkflowInstance(env.RANKING_WORKFLOW, instanceId);
    await env.RANKING_WORKFLOW.create({ id: instanceId, params: { runId } });
    await instance.waitForStatus("complete");
    const run = (await user.get(`/api/v1/ranking-runs/${runId}`)).body;
    expect(run.status).toBe("failed");
    expect(run.error).toBe(
      "ANTHROPIC_API_KEY no está configurada: el ranking con IA está deshabilitado.",
    );
  });
});
