import { describe, expect, it } from "vitest";

import { Client, offerPayload, signedUpClient, unique } from "./client";

const scraper = new Client("nr_boot0000_bootstrap-secret-for-tests");

/** Un binomio propio por prueba: los filtros por modelo la aíslan del resto. */
async function seedMarket(count = 6, extra: Record<string, unknown>[] = []) {
  const make = unique("Marca");
  const offers = [
    ...Array.from({ length: count }, (_, i) =>
      offerPayload({
        make,
        model: "Modelo X",
        title: `${make} Modelo X ${i}`,
        trim: i % 2 ? "Sport" : "Base",
        price: 15000 + i * 2500,
        year: 2016 + i,
        mileage_km: i === 2 ? null : 120000 - i * 15000,
        condition: i === 0 ? "km0" : "used",
        dealer_name: `Dealer ${i % 3}`,
      }),
    ),
    ...extra.map((overrides) => offerPayload({ make, model: "Modelo X", title: `${make} extra`, ...overrides })),
  ];
  const res = await scraper.post("/api/v1/offers/bulk", { offers });
  expect(res.body.skipped).toBe(0);
  return { make, ids: res.body.offer_ids as number[] };
}

describe("listado de ofertas", () => {
  it("ordena por cada columna, con los nulos al final en los dos sentidos", async () => {
    const user = await signedUpClient();
    const { make } = await seedMarket();
    const q = `q=${encodeURIComponent(make.toLowerCase())}`;
    const list = async (sort: string) =>
      (await user.get(`/api/v1/offers?${q}&sort=${sort}`)).body.items as Array<Record<string, any>>;

    const prices = (await list("price")).map((o) => o.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect((await list("-price")).map((o) => o.price)).toEqual([...prices].reverse());

    const kmAsc = (await list("mileage_km")).map((o) => o.mileage_km);
    expect(kmAsc.at(-1)).toBeNull();
    const kmDesc = (await list("-mileage_km")).map((o) => o.mileage_km);
    expect(kmDesc.at(-1)).toBeNull();
    expect(kmDesc.slice(0, -1)).toEqual([...kmDesc.slice(0, -1)].sort((a, b) => b - a));

    const scores = (await list("value_score")).map((o) => o.metrics.value_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect((await user.get(`/api/v1/offers?${q}&sort=ai_score`)).status).toBe(200);
    expect((await user.get(`/api/v1/offers?sort=nope`)).status).toBe(422);
  });

  it("filtra y pagina", async () => {
    const user = await signedUpClient();
    const { make } = await seedMarket();
    const q = `q=${encodeURIComponent(make.toLowerCase())}`;
    const page = (await user.get(`/api/v1/offers?${q}&max_price=20000`)).body;
    expect(page.total).toBe(3);
    expect(page.items.every((o: { price: number }) => o.price <= 20000)).toBe(true);

    expect((await user.get(`/api/v1/offers?${q}&condition=km0`)).body.total).toBe(1);
    expect((await user.get(`/api/v1/offers?${q}&min_year=2019&max_year=2020`)).body.total).toBe(2);

    const paged = (await user.get(`/api/v1/offers?${q}&sort=price&limit=2&offset=2`)).body;
    expect(paged).toMatchObject({ total: 6, limit: 2, offset: 2 });
    expect(paged.items.map((o: { price: number }) => o.price)).toEqual([20000, 22500]);
  });

  it("calcula las métricas contra el mercado del binomio, con desglose auditable", async () => {
    const user = await signedUpClient();
    const { make } = await seedMarket();
    const items = (await user.get(`/api/v1/offers?q=${encodeURIComponent(make.toLowerCase())}&sort=price`))
      .body.items;
    // Seis ofertas de 15.000 a 27.500 €: mediana 21.250 €.
    expect(items[0].metrics.price_vs_median_pct).toBe(-29.41);
    for (const offer of items) {
      const m = offer.metrics;
      expect(m.score_breakdown).toHaveLength(10);
      const points = m.score_breakdown.reduce((sum: number, c: { points: number | null }) => sum + (c.points ?? 0), 0);
      expect(Math.abs(points - m.value_score)).toBeLessThanOrEqual(0.1);
      const pct = m.score_breakdown.reduce((sum: number, c: { weight_pct: number }) => sum + c.weight_pct, 0);
      expect(Math.abs(pct - 100)).toBeLessThanOrEqual(0.5);
      // Sin PVP curado, el valor esperado sale del mercado (curva invertida).
      expect(m.expected_price_source).toBe("mercado");
      const missing = m.score_breakdown.filter((c: { available: boolean }) => !c.available);
      expect(missing.every((c: { weight_pct: number }) => c.weight_pct === 0)).toBe(true);
    }
  });
});

describe("métricas del conjunto filtrado", () => {
  it("describen exactamente las filas del filtro, y el dominio de los deslizadores ignora su propio filtro", async () => {
    const user = await signedUpClient();
    const { make } = await seedMarket();
    const q = `q=${encodeURIComponent(make.toLowerCase())}`;

    const all = (await user.get(`/api/v1/offers/stats?${q}`)).body;
    expect(all).toMatchObject({ count: 6, car_models: 2, price_floor: 15000, price_ceiling: 27500 });
    expect(all.avg_price).toBe(21250);
    // La oferta sin kilómetros no cuenta en la media.
    expect(all.avg_mileage_km).toBe(Math.round((120000 + 105000 + 75000 + 60000 + 45000) / 5));
    expect(all.best_deal).not.toBeNull();

    const filtered = (await user.get(`/api/v1/offers/stats?${q}&max_price=20000`)).body;
    expect(filtered.count).toBe(3);
    expect(filtered.avg_price).toBe(17500);
    expect(filtered).toMatchObject({ price_floor: 15000, price_ceiling: 27500 });

    const empty = (await user.get(`/api/v1/offers/stats?${q}&max_price=1`)).body;
    expect(empty).toMatchObject({ count: 0, avg_price: null, best_deal: null, price_floor: 15000 });

    const years = (await user.get(`/api/v1/offers/stats?${q}&min_year=2019`)).body;
    expect(years).toMatchObject({ year_floor: 2016, year_ceiling: 2021 });
  });
});

describe("configuración de la puntuación", () => {
  it("se lee con sus explicaciones, se edita, se valida y se restaura", async () => {
    const user = await signedUpClient();
    const config = (await user.get("/api/v1/scoring/config")).body;
    expect(config.components).toHaveLength(10);
    expect(config.components.every((c: { description: string }) => c.description.length > 20)).toBe(true);
    expect(config.default_weights.price_vs_market).toBe(30);

    const { ids } = await seedMarket(4);
    const zeroed = Object.fromEntries(Object.keys(config.weights).map((key) => [key, 0]));
    const onlyFresh = await user.put("/api/v1/scoring/config", { weights: { ...zeroed, freshness: 100 } });
    expect(onlyFresh.status).toBe(200);
    expect(onlyFresh.body.updated_at).not.toBeNull();
    const fresh = (await user.get(`/api/v1/offers/${ids[0]}`)).body;
    expect(fresh.metrics.value_score).toBe(100);

    expect((await user.put("/api/v1/scoring/config", { weights: zeroed })).status).toBe(422);
    expect((await user.put("/api/v1/scoring/config", { weights: { ...config.weights, age: -1 } })).status).toBe(422);
    expect(
      (await user.put("/api/v1/scoring/config", { params: { ...config.params, power_mid_hp: 500 } })).status,
    ).toBe(422);

    const restored = await user.put("/api/v1/scoring/config", { weights: config.default_weights });
    expect(restored.body.weights).toEqual(config.default_weights);
  });
});

describe("acciones sobre una oferta", () => {
  it("descartar, expirar y restaurar", async () => {
    const user = await signedUpClient();
    const { make, ids } = await seedMarket(3);
    const q = `q=${encodeURIComponent(make.toLowerCase())}`;

    const dismissed = await user.delete(`/api/v1/offers/${ids[0]}`);
    expect(dismissed.body).toMatchObject({ status: "dismissed", dismiss_reason: null });
    expect((await user.get(`/api/v1/offers?${q}`)).body.total).toBe(2);
    expect((await user.get(`/api/v1/offers?${q}&status=dismissed`)).body.total).toBe(1);

    const restored = await user.post(`/api/v1/offers/${ids[0]}/restore`);
    expect(restored.body).toMatchObject({ status: "active", dismissed_at: null });
    expect((await user.get("/api/v1/offers/999999999")).status).toBe(404);
  });

  it("valida las correcciones", async () => {
    const user = await signedUpClient();
    const { ids } = await seedMarket(1);
    expect((await user.patch(`/api/v1/offers/${ids[0]}`, { title: null })).status).toBe(422);
    expect((await user.patch(`/api/v1/offers/${ids[0]}`, { price: 0 })).status).toBe(422);
    expect((await user.patch(`/api/v1/offers/${ids[0]}`, { car_model_id: 999999 })).status).toBe(404);
    const blanked = await user.patch(`/api/v1/offers/${ids[0]}`, { mileage_km: null });
    expect(blanked.body).toMatchObject({ mileage_km: null, manual_fields: ["mileage_km"] });
  });

  it("las notas manuales puntúan, se borran con null y no anclan nada", async () => {
    const user = await signedUpClient();
    const { ids } = await seedMarket(4);
    const rated = await user.put(`/api/v1/offers/${ids[1]}/rating`, { equipment_rating: 5 });
    expect(rated.body).toMatchObject({ equipment_rating: 5, apparent_condition_rating: null, manual_fields: [] });
    const equipment = rated.body.metrics.score_breakdown.find((c: { key: string }) => c.key === "equipment");
    expect(equipment).toMatchObject({ available: true, subscore: 100 });

    const cleared = await user.put(`/api/v1/offers/${ids[1]}/rating`, { equipment_rating: null });
    expect(cleared.body.equipment_rating).toBeNull();
    expect((await user.put(`/api/v1/offers/${ids[1]}/rating`, { equipment_rating: 6 })).status).toBe(422);
    expect((await user.put(`/api/v1/offers/${ids[1]}/rating`, { other: 1 })).status).toBe(422);
  });

  it("los favoritos son idempotentes y por usuario", async () => {
    const user = await signedUpClient();
    const other = await signedUpClient();
    const { ids } = await seedMarket(1);
    const before = (await user.get("/api/v1/stats/overview")).body.favorite_offers;

    expect((await user.post(`/api/v1/offers/${ids[0]}/favorite`)).body.is_favorite).toBe(true);
    expect((await user.post(`/api/v1/offers/${ids[0]}/favorite`)).body.is_favorite).toBe(true);
    expect((await user.get(`/api/v1/offers/${ids[0]}`)).body.is_favorite).toBe(true);
    expect((await user.get("/api/v1/offers?favorites_only=true")).body.items.map((o: { id: number }) => o.id)).toEqual([
      ids[0],
    ]);
    expect((await user.get("/api/v1/stats/overview")).body.favorite_offers).toBe(before + 1);
    expect((await other.get(`/api/v1/offers/${ids[0]}`)).body.is_favorite).toBe(false);

    expect((await user.delete(`/api/v1/offers/${ids[0]}/favorite`)).body.is_favorite).toBe(false);
    expect((await user.get("/api/v1/offers?favorites_only=true")).body.total).toBe(0);
  });
});

describe("analítica", () => {
  it("agrega por binomio y detalla los pedidos", async () => {
    const user = await signedUpClient();
    const { make } = await seedMarket(6);
    const key = `${make.toLowerCase()}|modelo x`;
    const res = await user.get(
      `/api/v1/analytics/segments?q=${encodeURIComponent(make.toLowerCase())}&keys=${encodeURIComponent(key)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ detail_keys: [key], offers: 6, max_detail: 3 });
    const [segment] = res.body.segments;
    expect(segment).toMatchObject({
      key,
      label: `${make} Modelo X`,
      offers: 6,
      dealers: 3,
      trims: 2,
      min_price: 15000,
      median_price: 21250,
      p25_price: 18125,
      p75_price: 24375,
      detailed: true,
      offers_sampled: 6,
    });
    expect(segment.by_year).toHaveLength(6);
    expect(segment.by_dealer).toHaveLength(3);
    expect(segment.mix.condition).toEqual([
      { key: "used", offers: 5 },
      { key: "km0", offers: 1 },
    ]);
    expect(segment.points).toHaveLength(6);
    expect(segment.trend).toMatchObject({ n: 5 });
    expect(segment.trend.price_per_10k_km).toBeGreaterThan(0);
  });
});
