import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../worker/index";
import { Client, offerPayload, signedUpClient, unique } from "./client";

const scraper = new Client("nr_boot0000_bootstrap-secret-for-tests");

describe("modelos y dealers", () => {
  it("lista modelos y grupos por binomio con sus agregados", async () => {
    const user = await signedUpClient();
    const make = unique("Grupo");
    await scraper.post("/api/v1/offers/bulk", {
      offers: [
        offerPayload({ make, model: "Uno", trim: "A", price: 10000 }),
        offerPayload({ make, model: "Uno", trim: "B", price: 20000 }),
        // Misma marca escrita de otra forma: mismo binomio.
        offerPayload({ make: make.toUpperCase(), model: "UNO", trim: "C", price: 30000 }),
      ],
    });
    const q = encodeURIComponent(make.toLowerCase());
    const models = (await user.get(`/api/v1/car-models?q=${q}`)).body;
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({ active_offers: 1, is_tracked: false, tracking: null });
    expect(models[0].display_name).toContain("Uno");

    const groups = (await user.get(`/api/v1/car-models/groups?q=${q}`)).body;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: `${make.toLowerCase()}|uno`,
      make,
      model: "Uno",
      label: `${make} Uno`,
      active_offers: 3,
      median_price: 20000,
      variant_count: 3,
      reference_price: null,
      last_ranked_at: null,
    });

    await user.patch(`/api/v1/car-models/${models[0].id}`, { reference_price: 30000 });
    const withPvp = (await user.get(`/api/v1/car-models/groups?q=${q}`)).body[0];
    expect(withPvp).toMatchObject({ reference_price: 30000, reference_variants: 1 });

    expect((await user.post("/api/v1/car-models", { make, model: "Uno", trim: "A" })).status).toBe(409);
    const created = await user.post("/api/v1/car-models", { make, model: "Dos" });
    expect(created.status).toBe(201);
    expect((await user.get(`/api/v1/car-models/${created.body.id}`)).body.active_offers).toBe(0);
  });

  it("dealers con agregados, edición de notas y búsqueda", async () => {
    const user = await signedUpClient();
    const name = unique("Smoke Dealer");
    await scraper.post("/api/v1/offers/bulk", {
      offers: [offerPayload({ dealer_name: name, price: 20000, original_price: 25000 })],
    });
    const [dealer] = (await user.get(`/api/v1/dealers?q=${encodeURIComponent(name.toLowerCase())}`)).body;
    expect(dealer).toMatchObject({ active_offers: 1, avg_discount_pct: 20, best_price: 20000, notes: null });

    const patched = await user.patch(`/api/v1/dealers/${dealer.id}`, { notes: "llamar antes" });
    expect(patched.body.notes).toBe("llamar antes");
    expect((await user.post("/api/v1/dealers", { name })).status).toBe(409);
  });
});

describe("seguimiento de modelos", () => {
  it("seguir, re-seguir, en bloque y dejar de seguir", async () => {
    const user = await signedUpClient();
    const make = unique("Sigue");
    await scraper.post("/api/v1/offers/bulk", {
      offers: [offerPayload({ make, model: "M", trim: "1" }), offerPayload({ make, model: "M", trim: "2" })],
    });
    const models = (await user.get(`/api/v1/car-models?q=${encodeURIComponent(make.toLowerCase())}`)).body;

    const tracked = await user.post("/api/v1/tracked-models", { car_model_id: models[0].id, target_price: 20000 });
    expect(tracked.status).toBe(201);
    expect(tracked.body).toMatchObject({ car_model_id: models[0].id, target_price: 20000, is_active: true });
    const again = await user.post("/api/v1/tracked-models", { car_model_id: models[0].id, target_price: 19000 });
    expect(again.body).toMatchObject({ id: tracked.body.id, target_price: 19000 });

    const onlyTracked = (await user.get("/api/v1/car-models?tracked_only=true")).body;
    expect(onlyTracked.map((m: { id: number }) => m.id)).toEqual([models[0].id]);

    const bulk = await user.post("/api/v1/tracked-models/bulk", {
      car_model_ids: models.map((m: { id: number }) => m.id),
      max_mileage_km: 80000,
    });
    expect(bulk.status).toBe(201);
    expect(bulk.body).toHaveLength(2);
    const group = (await user.get(`/api/v1/car-models/groups?tracked_only=true`)).body[0];
    expect(group).toMatchObject({ tracked_variants: 2, target_price: null });

    const patched = await user.patch(`/api/v1/tracked-models/${tracked.body.id}`, { notes: "ojo" });
    expect(patched.body.notes).toBe("ojo");

    expect((await user.delete(`/api/v1/tracked-models/${models[0].id}`)).status).toBe(204);
    expect((await user.delete(`/api/v1/tracked-models/${models[0].id}`)).status).toBe(404);
    const ids = models.map((m: { id: number }) => m.id).join(",");
    expect((await user.delete(`/api/v1/tracked-models/bulk?car_model_ids=${ids}`)).status).toBe(204);
    expect((await user.get("/api/v1/tracked-models")).body).toEqual([]);
    expect((await user.delete("/api/v1/tracked-models/bulk?car_model_ids=x")).status).toBe(422);
  });

  it("seguir un modelo que no existe lo crea, con su PVP", async () => {
    const user = await signedUpClient();
    const make = unique("Nuevo");
    const res = await user.post("/api/v1/tracked-models", { make, model: "Z", reference_price: 21000 });
    expect(res.status).toBe(201);
    expect(res.body.car_model).toMatchObject({ make, model: "Z", reference_price: 21000 });
    expect((await user.post("/api/v1/tracked-models", {})).status).toBe(422);
  });
});

describe("configuración de rastreo", () => {
  it("sirve la semilla al skill, con las URLs renderizadas", async () => {
    const config = (await scraper.get("/api/v1/scraping/config")).body;
    expect(config.max_per_target).toBe(15);
    const flexicar = config.targets.find(
      (t: { source: { key: string }; make_model_key: string }) =>
        t.source.key === "flexicar" && t.make_model_key === "audi|a3",
    );
    expect(flexicar.search_url).toBe("https://www.flexicar.es/audi/a3/segunda-mano/");
    const ocasion = config.targets.find(
      (t: { source: { key: string } }) => t.source.key === "ocasionplus",
    );
    expect(ocasion.search_url).toBeNull();
    const ctc = config.targets.find(
      (t: { source: { key: string }; make_model_key: string }) =>
        t.source.key === "compramostucoche" && t.make_model_key === "mitsubishi|montero",
    );
    expect(ctc.search_params).toEqual({ brand: "MITSUBISHI", model_tokens: ["PAJERO"] });
  });

  it("el skill persiste lo descubierto y la UI reemplaza la selección conservándolo", async () => {
    const user = await signedUpClient();
    const sources = (await user.get("/api/v1/scraping/sources")).body;
    const ocasion = sources.find((s: { key: string }) => s.key === "ocasionplus");
    const targets = (await user.get("/api/v1/scraping/targets")).body;
    const target = targets.find(
      (t: { source_id: number; make_model_key: string }) =>
        t.source_id === ocasion.id && t.make_model_key === "audi|a3",
    );

    const patched = await scraper.patch(`/api/v1/scraping/targets/${target.id}`, {
      search_url: "https://www.ocasionplus.com/coches-segunda-mano/audi/a3",
      search_params: { discovered: true },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.source.key).toBe("ocasionplus");

    const replaced = await user.put("/api/v1/scraping/targets", {
      max_per_target: 20,
      targets: [
        { source_id: ocasion.id, make: "Audi", model: "  A3  " },
        { source_id: ocasion.id, make: "Seat", model: "León" },
      ],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toHaveLength(2);
    expect(replaced.body[0]).toMatchObject({
      id: target.id,
      max_results: 20,
      search_url: "https://www.ocasionplus.com/coches-segunda-mano/audi/a3",
      search_params: { discovered: true },
    });

    const active = (await user.get("/api/v1/scraping/targets")).body;
    expect(active.every((t: { source_id: number }) => t.source_id === ocasion.id)).toBe(true);
    expect((await scraper.get("/api/v1/scraping/config")).body.max_per_target).toBe(20);

    const dup = await user.put("/api/v1/scraping/targets", {
      targets: [
        { source_id: ocasion.id, make: "Seat", model: "León" },
        { source_id: ocasion.id, make: "seat", model: "LEÓN" },
      ],
    });
    expect(dup.status).toBe(422);
    expect((await user.put("/api/v1/scraping/targets", { targets: [{ source_id: 9999, make: "a", model: "b" }] })).status).toBe(422);
  });

  it("alta y edición de fuentes", async () => {
    const user = await signedUpClient();
    const key = unique("src").toLowerCase();
    const created = await user.post("/api/v1/scraping/sources", {
      key,
      name: "Fuente",
      base_url: "https://fuente.example",
      access: "fetch",
    });
    expect(created.status).toBe(201);
    expect((await user.post("/api/v1/scraping/sources", { ...created.body, key })).status).toBe(409);
    const off = await user.patch(`/api/v1/scraping/sources/${created.body.id}`, { is_active: false });
    expect(off.body.is_active).toBe(false);
    expect((await user.post("/api/v1/scraping/sources", { key: "Mal Clave", name: "x", base_url: "x", access: "fetch" })).status).toBe(422);
  });
});

describe("ranking con IA", () => {
  it("sin ANTHROPIC_API_KEY responde 503 y no crea runs", async () => {
    const user = await signedUpClient();
    const res = await user.post(`/api/v1/car-model-groups/rank?key=${encodeURIComponent("audi|a3")}`);
    expect(res.status).toBe(503);
    expect((await user.get(`/api/v1/car-model-groups/ranking?key=${encodeURIComponent("audi|a3")}`)).status).toBe(404);
    expect((await user.get(`/api/v1/car-model-groups/ranking-runs?key=${encodeURIComponent("audi|a3")}`)).body).toEqual([]);
    expect((await user.get("/api/v1/ranking-runs/12345")).status).toBe(404);
  });

  it("el último veredicto de un run completado viaja con cada oferta del binomio", async () => {
    const user = await signedUpClient();
    const make = unique("Rank");
    const { offer_ids: ids } = (
      await scraper.post("/api/v1/offers/bulk", {
        offers: [
          offerPayload({ make, model: "R", trim: "a", title: `${make} R a` }),
          offerPayload({ make, model: "R", trim: "b", title: `${make} R b` }),
        ],
      })
    ).body;
    const key = `${make.toLowerCase()}|r`;
    const run = await env.DB.prepare(
      `INSERT INTO ranking_runs (make_model_key, label, status, created_at) VALUES (?1, ?2, 'completed', ?3) RETURNING id`,
    )
      .bind(key, `${make} R`, new Date().toISOString())
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO offer_rankings (run_id, offer_id, rank, score, verdict, reasoning, pros, cons) VALUES (?1, ?2, 1, 91, 'excellent', 'barato', '["km"]', '[]'), (?1, ?3, 2, 40, 'fair', NULL, '[]', '[]')`,
    )
      .bind(run!.id, ids[1], ids[0])
      .run();

    const offer = (await user.get(`/api/v1/offers/${ids[0]}`)).body;
    expect(offer.ai).toMatchObject({ rank: 2, score: 40, verdict: "fair", run_id: run!.id });

    const sorted = (await user.get(`/api/v1/offers?q=${encodeURIComponent(make.toLowerCase())}&sort=ai_score`)).body.items;
    expect(sorted.map((o: { id: number }) => o.id)).toEqual([ids[1], ids[0]]);

    const latest = (await user.get(`/api/v1/car-model-groups/ranking?key=${encodeURIComponent(key)}`)).body;
    expect(latest.items.map((i: { offer_id: number }) => i.offer_id)).toEqual([ids[1], ids[0]]);
    expect(latest.items[0]).toMatchObject({ verdict: "excellent", pros: ["km"], offer: { id: ids[1] } });

    const groups = (await user.get(`/api/v1/car-models/groups?q=${encodeURIComponent(make.toLowerCase())}`)).body;
    expect(groups[0].last_ranked_at).not.toBeNull();
  });
});

describe("backup programado", () => {
  it("vuelca las tablas a R2 en NDJSON comprimido", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.parse("2026-10-07T03:17:00Z"), cron: "17 3 * * *", noRetry() {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const object = await env.BUCKET.get("backups/2026-10-07/scrape_sources.ndjson.gz");
    expect(object).not.toBeNull();
    const text = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.some((row: { key: string }) => row.key === "flexicar")).toBe(true);
    expect(await env.BUCKET.head("backups/2026-10-07/sessions.ndjson.gz")).toBeNull();
  });
});
