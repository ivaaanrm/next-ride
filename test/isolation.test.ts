/**
 * Aislamiento por cuenta: lo que ingesta el scraper de una cuenta no lo ve,
 * no lo cuenta y no lo toca ninguna otra. Dos cuentas que rastrean lo mismo
 * —la misma URL, el mismo dealer, el mismo binomio— tienen cada una lo suyo.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { account, adminClient, Client, offerPayload, unique } from "./client";

/** Dos cuentas con el mismo binomio, el mismo dealer y un anuncio en común. */
async function twoAccounts() {
  const a = await account("Ana");
  const b = await account("Bea");
  const make = unique("Aislada");
  const dealer = unique("Dealer Compartido");
  const offer = (price: number) =>
    offerPayload({ make, model: "Uno", title: `${make} Uno ${price}`, dealer_name: dealer, price });
  const shared = offer(20000);
  const ingested = await a.scraper.post("/api/v1/offers/bulk", {
    offers: [shared, offer(22000), offer(24000)],
  });
  expect(ingested.body).toMatchObject({ created: 3, skipped: 0 });
  return { a, b, make, dealer, shared, aIds: ingested.body.offer_ids as number[] };
}

const q = (make: string) => `q=${encodeURIComponent(make.toLowerCase())}`;

describe("ofertas", () => {
  it("una cuenta no ve en ningún listado ni agregado lo que ha ingestado otra", async () => {
    const { a, b, make, dealer } = await twoAccounts();

    expect((await a.user.get(`/api/v1/offers?${q(make)}`)).body.total).toBe(3);
    expect((await b.user.get(`/api/v1/offers?${q(make)}`)).body).toMatchObject({ total: 0, items: [] });
    expect((await b.user.get("/api/v1/offers")).body.total).toBe(0);

    const stats = (await b.user.get(`/api/v1/offers/stats?${q(make)}`)).body;
    expect(stats).toMatchObject({ count: 0, best_deal: null, price_floor: null });

    const overview = (await b.user.get("/api/v1/stats/overview")).body;
    expect(overview).toMatchObject({
      active_offers: 0,
      dismissed_offers: 0,
      dealers: 0,
      car_models: 0,
      best_deal: null,
    });

    const segments = (await b.user.get(`/api/v1/analytics/segments?${q(make)}`)).body;
    expect(segments).toMatchObject({ segments: [], offers: 0 });

    expect((await b.user.get(`/api/v1/dealers?q=${encodeURIComponent(dealer.toLowerCase())}`)).body).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await b.user.get(`/api/v1/car-models?${q(make)}`)).body).toMatchObject({ items: [], total: 0 });
    expect((await b.user.get(`/api/v1/car-models/groups?${q(make)}`)).body).toEqual([]);
    expect((await b.user.get("/api/v1/offers/facets")).body).toEqual({ car_models: [], dealers: [] });
  });

  it("una oferta de otra cuenta es un 404 en todos los verbos, y queda intacta", async () => {
    const { a, b, aIds } = await twoAccounts();
    const id = aIds[0];
    const before = (await a.user.get(`/api/v1/offers/${id}`)).body;

    const attempts = [
      b.user.get(`/api/v1/offers/${id}`),
      b.user.get(`/api/v1/offers/${id}/raw`),
      b.user.get(`/api/v1/offers/${id}/price-history`),
      b.user.patch(`/api/v1/offers/${id}`, { price: 1000, title: "Robada" }),
      b.user.put(`/api/v1/offers/${id}/rating`, { equipment_rating: 1 }),
      b.user.delete(`/api/v1/offers/${id}`, { reason: "ajena" }),
      b.user.post(`/api/v1/offers/${id}/expire`),
      b.user.post(`/api/v1/offers/${id}/restore`),
      b.user.post(`/api/v1/offers/${id}/favorite`),
      b.user.delete(`/api/v1/offers/${id}/favorite`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.detail).toBe("Oferta no encontrada");
    }

    const after = (await a.user.get(`/api/v1/offers/${id}`)).body;
    expect(after).toMatchObject({
      status: "active",
      price: before.price,
      title: before.title,
      equipment_rating: null,
      manual_fields: [],
      is_favorite: false,
    });
  });

  it("el mismo anuncio en dos cuentas son dos ofertas, con su precio y su estado", async () => {
    const { a, b, shared, aIds } = await twoAccounts();

    const [bId] = (await b.scraper.post("/api/v1/offers/bulk", { offers: [{ ...shared, price: 18000 }] }))
      .body.offer_ids;
    expect(bId).not.toBe(aIds[0]);

    // B la descarta y la corrige: en la cuenta de A no ha pasado nada.
    await b.user.delete(`/api/v1/offers/${bId}`, { reason: "no" });
    await b.user.patch(`/api/v1/offers/${bId}`, { year: 2001 });
    const mine = (await a.user.get(`/api/v1/offers/${aIds[0]}`)).body;
    expect(mine).toMatchObject({ status: "active", price: 20000, year: shared.year, manual_fields: [] });

    // Y el siguiente pase del scraper de A no despierta ni toca la de B.
    await a.scraper.post("/api/v1/offers/bulk", { offers: [{ ...shared, price: 19000 }] });
    const theirs = (await b.user.get(`/api/v1/offers/${bId}`)).body;
    expect(theirs).toMatchObject({ status: "dismissed", price: 18000, year: 2001 });
    const history = (await b.user.get(`/api/v1/offers/${bId}/price-history`)).body;
    expect(history.map((p: { price: number }) => p.price)).toEqual([18000]);
    const aHistory = (await a.user.get(`/api/v1/offers/${aIds[0]}/price-history`)).body;
    expect(aHistory.map((p: { price: number }) => p.price)).toEqual([20000, 19000]);
  });

  it("el mercado contra el que se puntúa es el de la cuenta", async () => {
    const { b, make } = await twoAccounts();
    // A tiene 20.000, 22.000 y 24.000 €; B, una sola oferta del mismo binomio.
    const [bId] = (
      await b.scraper.post("/api/v1/offers/bulk", {
        offers: [offerPayload({ make, model: "Uno", price: 30000 })],
      })
    ).body.offer_ids;
    const offer = (await b.user.get(`/api/v1/offers/${bId}`)).body;
    // Con la mediana de A delante sería +36,36 %; sola en su mercado, 0.
    expect(offer.metrics.price_vs_median_pct).toBe(0);

    const [group] = (await b.user.get(`/api/v1/car-models/groups?${q(make)}`)).body;
    expect(group).toMatchObject({ active_offers: 1, median_price: 30000, dealers_count: 1 });
  });
});

describe("catálogo", () => {
  it("dealers y versiones son de cada cuenta: ni se leen, ni se editan, ni se reatribuyen", async () => {
    const { a, b, make, dealer, aIds } = await twoAccounts();
    const [aDealer] = (await a.user.get(`/api/v1/dealers?q=${encodeURIComponent(dealer.toLowerCase())}`)).body.items;
    const [aModel] = (await a.user.get(`/api/v1/car-models?${q(make)}`)).body.items;
    await a.user.patch(`/api/v1/dealers/${aDealer.id}`, { notes: "negociado a 19.000" });

    expect((await b.user.get(`/api/v1/dealers/${aDealer.id}`)).status).toBe(404);
    expect((await b.user.patch(`/api/v1/dealers/${aDealer.id}`, { notes: "mía" })).status).toBe(404);
    expect((await b.user.get(`/api/v1/car-models/${aModel.id}`)).status).toBe(404);
    expect((await b.user.patch(`/api/v1/car-models/${aModel.id}`, { reference_price: 1 })).status).toBe(404);
    expect((await b.user.get(`/api/v1/stats/car-models/${aModel.id}`)).body.count).toBe(0);

    // Ni seguir una versión ajena, ni colgarle a una oferta propia la versión
    // o el dealer de otra cuenta: serían su ventana a lo de A.
    expect((await b.user.post("/api/v1/tracked-models", { car_model_id: aModel.id })).status).toBe(404);
    expect((await b.user.post("/api/v1/tracked-models/bulk", { car_model_ids: [aModel.id] })).status).toBe(404);
    const [bId] = (await b.scraper.post("/api/v1/offers/bulk", { offers: [offerPayload()] })).body.offer_ids;
    expect((await b.user.patch(`/api/v1/offers/${bId}`, { car_model_id: aModel.id })).status).toBe(404);
    expect((await b.user.patch(`/api/v1/offers/${bId}`, { dealer_id: aDealer.id })).status).toBe(404);

    // Dar de alta a mano lo que ya existe en la otra cuenta no choca con ella.
    expect((await b.user.post("/api/v1/dealers", { name: dealer })).status).toBe(201);
    const created = await b.user.post("/api/v1/car-models", { make: aModel.make, model: aModel.model, trim: aModel.trim });
    expect(created.status).toBe(201);
    expect(created.body.id).not.toBe(aModel.id);

    // El mismo nombre en B es otro dealer, sin las notas de A; y A sigue igual.
    await b.scraper.post("/api/v1/offers/bulk", { offers: [offerPayload({ make, model: "Uno", dealer_name: dealer })] });
    const [bDealer] = (await b.user.get(`/api/v1/dealers?q=${encodeURIComponent(dealer.toLowerCase())}`)).body.items;
    expect(bDealer.id).not.toBe(aDealer.id);
    expect(bDealer).toMatchObject({ notes: null, active_offers: 1 });
    expect((await a.user.get(`/api/v1/dealers/${aDealer.id}`)).body.notes).toBe("negociado a 19.000");
    const [aDealerRow] = (await a.user.get(`/api/v1/dealers?q=${encodeURIComponent(dealer.toLowerCase())}`)).body.items;
    expect(aDealerRow).toMatchObject({ id: aDealer.id, active_offers: 3 });
    expect((await a.user.get(`/api/v1/car-models/${aModel.id}`)).body).toMatchObject({
      reference_price: null,
      active_offers: 3,
    });
    expect((await a.user.get(`/api/v1/offers/${aIds[0]}`)).body.car_model.id).toBe(aModel.id);
  });

  it("seguir un binomio crea las versiones en la cuenta, no reutiliza las de otra", async () => {
    const { a, b, make } = await twoAccounts();
    const followed = await b.user.put("/api/v1/tracked-models/group", { make, model: "Uno", target_price: 15000 });
    expect(followed.body).toMatchObject({ tracked_variants: 1 });
    const [bModel] = (await b.user.get(`/api/v1/car-models?${q(make)}`)).body.items;
    expect(bModel).toMatchObject({ active_offers: 0, is_tracked: true });

    // Las ofertas que A ingesta después no le llegan a B ni heredan su seguimiento.
    await a.scraper.post("/api/v1/offers/bulk", { offers: [offerPayload({ make, model: "Uno", trim: "Nueva" })] });
    expect((await b.user.get(`/api/v1/car-models?${q(make)}`)).body.items).toHaveLength(1);
    expect((await a.user.get(`/api/v1/car-models?${q(make)}&tracked_only=true`)).body.items).toEqual([]);
    expect((await b.user.get(`/api/v1/offers?tracked_only=true`)).body.total).toBe(0);
  });
});

describe("API keys y captación", () => {
  it("cada cuenta ve y revoca solo sus claves", async () => {
    const { a, b } = await twoAccounts();
    const aKeys = (await a.user.get("/api/v1/api-keys")).body as { id: number }[];
    const bKeys = (await b.user.get("/api/v1/api-keys")).body as { id: number }[];
    expect(aKeys).toHaveLength(1);
    expect(bKeys).toHaveLength(1);
    expect(bKeys[0].id).not.toBe(aKeys[0].id);

    expect((await b.user.delete(`/api/v1/api-keys/${aKeys[0].id}`)).status).toBe(404);
    expect((await a.scraper.get("/api/v1/scraping/config")).status).toBe(200);
  });

  it("el scraper de una cuenta recibe solo sus targets y no puede tocar los de otra", async () => {
    const { a, b, make } = await twoAccounts();
    const sources = (await a.user.get("/api/v1/scraping/sources")).body as { id: number }[];
    await a.user.put("/api/v1/tracked-models/group", { make, model: "Uno", source_ids: [sources[0].id] });

    const aConfig = (await a.scraper.get("/api/v1/scraping/config")).body;
    expect(aConfig.targets.map((t: { make: string }) => t.make)).toEqual([make]);
    const [target] = aConfig.targets;

    // Ni la semilla del superusuario ni lo de A: B empieza sin nada que buscar.
    expect((await b.scraper.get("/api/v1/scraping/config")).body.targets).toEqual([]);
    expect((await b.user.get("/api/v1/scraping/targets?include_inactive=true")).body).toEqual([]);

    const hijack = await b.scraper.patch(`/api/v1/scraping/targets/${target.id}`, {
      search_url: "https://evil.example/",
    });
    expect(hijack.status).toBe(404);
    expect((await a.scraper.get("/api/v1/scraping/config")).body.targets[0].search_url).toBe(target.search_url);

    // Reemplazar la matriz de B no apaga nada de A.
    expect((await b.user.put("/api/v1/scraping/targets", { targets: [] })).status).toBe(200);
    expect((await a.scraper.get("/api/v1/scraping/config")).body.targets).toHaveLength(1);
    await b.user.delete(`/api/v1/tracked-models/group?key=${encodeURIComponent(target.make_model_key)}&stop_scraping=true`);
    expect((await a.scraper.get("/api/v1/scraping/config")).body.targets).toHaveLength(1);
  });

  it("la clave del bootstrap ingesta en la cuenta del superusuario", async () => {
    const admin = await adminClient();
    const bootstrap = new Client("nr_boot0000_bootstrap-secret-for-tests");
    const payload = offerPayload({ make: unique("Boot") });
    const [id] = (await bootstrap.post("/api/v1/offers/bulk", { offers: [payload] })).body.offer_ids;
    expect((await admin.get(`/api/v1/offers/${id}`)).body.url).toBe(payload.url);
    const { user } = await account();
    expect((await user.get(`/api/v1/offers/${id}`)).status).toBe(404);
  });

  it("una clave cuya cuenta está desactivada no entra", async () => {
    const { scraper, id } = await account();
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE id = ?1").bind(id).run();
    const res = await scraper.post("/api/v1/offers/bulk", { offers: [offerPayload()] });
    expect(res.status).toBe(403);
  });
});

describe("puntuación y rankings", () => {
  it("los pesos de la puntuación son de cada cuenta", async () => {
    const { a, b } = await twoAccounts();
    const defaults = (await a.user.get("/api/v1/scoring/config")).body;
    const zeroed = Object.fromEntries(Object.keys(defaults.weights).map((key) => [key, 0]));
    await b.user.put("/api/v1/scoring/config", { weights: { ...zeroed, freshness: 100 } });

    const mine = (await a.user.get("/api/v1/scoring/config")).body;
    expect(mine).toMatchObject({ weights: defaults.default_weights, updated_at: null });
    expect((await b.user.get("/api/v1/scoring/config")).body.weights.freshness).toBe(100);
  });

  it("un run del agente y sus veredictos son solo de su cuenta", async () => {
    const { a, b, make, shared, aIds } = await twoAccounts();
    const key = `${make.toLowerCase()}|uno`;
    const run = await env.DB.prepare(
      `INSERT INTO ranking_runs (user_id, make_model_key, label, status) VALUES (?1, ?2, ?3, 'completed') RETURNING id`,
    )
      .bind(a.id, key, `${make} Uno`)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO offer_rankings (run_id, offer_id, rank, score, verdict, reasoning) VALUES (?1, ?2, 1, 95, 'excellent', 'de A')`,
    )
      .bind(run!.id, aIds[0])
      .run();
    expect((await a.user.get(`/api/v1/offers/${aIds[0]}`)).body.ai).toMatchObject({ run_id: run!.id });

    // B tiene el mismo binomio y el mismo anuncio, pero no el veredicto de A.
    const [bId] = (await b.scraper.post("/api/v1/offers/bulk", { offers: [shared] })).body.offer_ids;
    expect((await b.user.get(`/api/v1/offers/${bId}`)).body.ai).toBeNull();
    const encoded = encodeURIComponent(key);
    expect((await b.user.get(`/api/v1/ranking-runs/${run!.id}`)).status).toBe(404);
    expect((await b.user.get(`/api/v1/car-model-groups/ranking?key=${encoded}`)).status).toBe(404);
    expect((await b.user.get(`/api/v1/car-model-groups/ranking-runs?key=${encoded}`)).body).toEqual([]);
    const [group] = (await b.user.get(`/api/v1/car-models/groups?${q(make)}`)).body;
    expect(group.last_ranked_at).toBeNull();
  });
});

describe("la base de datos", () => {
  it("no deja que una fila apunte a otra cuenta aunque la API se equivoque", async () => {
    const { a, b, make, aIds } = await twoAccounts();
    const [bId] = (await b.scraper.post("/api/v1/offers/bulk", { offers: [offerPayload()] })).body.offer_ids;
    const aModel = await env.DB.prepare("SELECT car_model_id AS id FROM offers WHERE id = ?1")
      .bind(aIds[0])
      .first<{ id: number }>();

    const rejected = (sql: string, ...params: unknown[]) =>
      expect(env.DB.prepare(sql).bind(...params).run()).rejects.toThrow(/misma cuenta|propia cuenta|su cuenta/);

    await rejected("INSERT INTO offer_favorites (user_id, offer_id) VALUES (?1, ?2)", b.id, aIds[0]);
    await rejected("INSERT INTO tracked_models (user_id, car_model_id) VALUES (?1, ?2)", b.id, aModel!.id);
    await rejected("UPDATE offers SET car_model_id = ?1 WHERE id = ?2", aModel!.id, bId);
    await rejected("UPDATE offers SET user_id = ?1 WHERE id = ?2", b.id, aIds[0]);

    const bRun = await env.DB.prepare(
      `INSERT INTO ranking_runs (user_id, make_model_key, label) VALUES (?1, ?2, '') RETURNING id`,
    )
      .bind(b.id, `${make.toLowerCase()}|uno`)
      .first<{ id: number }>();
    await rejected(
      "INSERT INTO offer_rankings (run_id, offer_id, rank, score, verdict) VALUES (?1, ?2, 1, 1, 'fair')",
      bRun!.id,
      aIds[0],
    );
    expect((await a.user.get(`/api/v1/offers/${aIds[0]}`)).body.is_favorite).toBe(false);
  });
});
