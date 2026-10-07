/**
 * El contrato con el skill de captación (`next-ride/`): `X-API-Key`,
 * `POST /offers/bulk` y la semántica del upsert por URL.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { account, Client, offerPayload, signedUpClient, unique } from "./client";

const BOOTSTRAP_KEY = "nr_boot0000_bootstrap-secret-for-tests";

describe("API keys", () => {
  it("se crean, se listan sin hash, sirven para ingestar y se revocan", async () => {
    const user = await signedUpClient();
    const created = await user.post("/api/v1/api-keys", { name: "scraper" });
    expect(created.status).toBe(201);
    expect(created.body.api_key).toMatch(/^nr_[0-9a-f]{8}_/);

    const listed = await user.get("/api/v1/api-keys");
    // Solo las suyas: la del bootstrap es del superusuario.
    expect(listed.body.map((k: { id: number }) => k.id)).toEqual([created.body.id]);
    expect(listed.body.every((k: object) => !("hashed_key" in k) && !("api_key" in k))).toBe(true);

    const scraper = new Client(created.body.api_key);
    expect((await scraper.get("/api/v1/scraping/config")).status).toBe(200);

    expect((await user.delete(`/api/v1/api-keys/${created.body.id}`)).status).toBe(204);
    expect((await scraper.get("/api/v1/scraping/config")).status).toBe(401);
  });

  it("la clave de BOOTSTRAP_SCRAPER_API_KEY vale desde el primer minuto", async () => {
    const res = await new Client(BOOTSTRAP_KEY).get("/api/v1/scraping/config");
    expect(res.status).toBe(200);
  });

  it("una clave inválida o ausente es 401", async () => {
    expect((await new Client("nr_deadbeef_nope").post("/api/v1/offers/bulk", { offers: [{}] })).status).toBe(401);
    const res = await new Client().post("/api/v1/offers/bulk", { offers: [offerPayload()] });
    expect(res.status).toBe(401);
  });
});

describe("ingesta en lote", () => {
  it("crea, actualiza, y reporta las ofertas mal formadas sin tumbar el lote", async () => {
    const { scraper } = await account();
    const good = [offerPayload(), offerPayload({ price: "19990", year: 2019.0 })];
    const bad = { ...offerPayload(), price: -5 };
    const res = await scraper.post("/api/v1/offers/bulk", { offers: [...good, bad, { title: "sin url" }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 0, skipped: 2 });
    expect(res.body.offer_ids).toHaveLength(2);
    expect(res.body.errors[0]).toMatch(/^\[2\] https:\/\/dealer\.example\/.+: price/);
    expect(res.body.errors[1]).toMatch(/^\[3\] sin url:/);

    const again = await scraper.post("/api/v1/offers/bulk", {
      offers: [{ ...good[0], price: 23990 }],
    });
    expect(again.body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(again.body.offer_ids[0]).toBe(res.body.offer_ids[0]);
  });

  it("anota el historial solo cuando cambia el precio", async () => {
    const { user, scraper } = await account();
    const payload = offerPayload();
    const [id] = (await scraper.post("/api/v1/offers/bulk", { offers: [payload] })).body.offer_ids;
    await scraper.post("/api/v1/offers/bulk", { offers: [payload] });
    await scraper.post("/api/v1/offers/bulk", { offers: [{ ...payload, price: 22990 }] });

    const history = await user.get(`/api/v1/offers/${id}/price-history`);
    expect(history.body.map((p: { price: number }) => p.price)).toEqual([24590, 22990]);

    const offer = (await user.get(`/api/v1/offers/${id}`)).body;
    expect(offer.price).toBe(22990);
    expect(offer.metrics.price_drop_pct).toBe(6.51);
    expect(offer.metrics.discount_pct).toBe(17.86);
  });

  it("la misma URL dos veces en un lote: la primera crea y la segunda actualiza", async () => {
    const { scraper } = await account();
    const payload = offerPayload();
    const res = await scraper.post("/api/v1/offers/bulk", {
      offers: [payload, { ...payload, price: 20000 }],
    });
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect(new Set(res.body.offer_ids).size).toBe(1);
  });

  it("normaliza la URL como lo hacía Pydantic", async () => {
    const { scraper } = await account();
    const id = unique("u");
    const first = await scraper.post("/api/v1/offers/bulk", {
      offers: [offerPayload({ url: `HTTPS://Dealer.Example/${id}` })],
    });
    const second = await scraper.post("/api/v1/offers/bulk", {
      offers: [offerPayload({ url: `https://dealer.example/${id}` })],
    });
    expect(second.body.updated).toBe(1);
    expect(second.body.offer_ids).toEqual(first.body.offer_ids);
  });

  it("guarda el crudo en R2 y lo sirve aparte, no en el listado", async () => {
    const { user, scraper } = await account();
    const payload = offerPayload({ raw: { marker: "r2-raw", nested: { a: 1 } } });
    const [id] = (await scraper.post("/api/v1/offers/bulk", { offers: [offerPayload(), payload] })).body
      .offer_ids.slice(1);

    const offer = (await user.get(`/api/v1/offers/${id}`)).body;
    expect(offer).not.toHaveProperty("raw");
    expect(offer).not.toHaveProperty("raw_ref");

    const raw = await user.get(`/api/v1/offers/${id}/raw`);
    expect(raw.body.raw).toEqual({ marker: "r2-raw", nested: { a: 1 } });

    const listed = await env.BUCKET.list({ prefix: "raw/batches/" });
    expect(listed.objects.length).toBeGreaterThan(0);
  });

  it("completa los huecos del dealer sin pisar lo curado", async () => {
    const { user, scraper } = await account();
    const name = unique("Dealer Huecos");
    await scraper.post("/api/v1/offers/bulk", { offers: [offerPayload({ dealer_name: name, dealer_city: null })] });
    const dealers = (await user.get(`/api/v1/dealers?q=${encodeURIComponent(name.toLowerCase())}`)).body.items;
    expect(dealers).toHaveLength(1);
    expect(dealers[0].city).toBeNull();

    await user.patch(`/api/v1/dealers/${dealers[0].id}`, { website: "https://curado.example" });
    await scraper.post("/api/v1/offers/bulk", {
      offers: [offerPayload({ dealer_name: name, dealer_city: "Tudela", dealer_website: "https://scraper.example" })],
    });
    const after = (await user.get(`/api/v1/dealers/${dealers[0].id}`)).body;
    expect(after).toMatchObject({ city: "Tudela", website: "https://curado.example", country: "ES" });
  });

  it("un lote de 500 cabe en una invocación", async () => {
    const { scraper } = await account();
    const offers = Array.from({ length: 500 }, (_, i) =>
      offerPayload({ dealer_name: `Lote Dealer ${i % 40}`, trim: `Versión ${i % 25}` }),
    );
    const res = await scraper.post("/api/v1/offers/bulk", { offers });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 500, skipped: 0 });
  });

  it("un lote que ocupa varios trozos devuelve todos los ids, en el orden de entrada", async () => {
    const { user, scraper } = await account();
    const offers = Array.from({ length: 250 }, (_, i) => offerPayload({ price: 10000 + i }));
    const res = await scraper.post("/api/v1/offers/bulk", { offers });
    expect(res.body).toMatchObject({ created: 250, skipped: 0 });
    const first = (await user.get(`/api/v1/offers/${res.body.offer_ids[0]}`)).body;
    const last = (await user.get(`/api/v1/offers/${res.body.offer_ids[249]}`)).body;
    expect([first.url, last.url]).toEqual([offers[0].url, offers[249].url]);
  });

  it("POST /offers ingesta una sola oferta y devuelve la ficha", async () => {
    const { scraper } = await account();
    const res = await scraper.post("/api/v1/offers", offerPayload());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "active", is_favorite: false });
    expect((await scraper.post("/api/v1/offers", { ...offerPayload(), price: 0 })).status).toBe(422);
  });
});

describe("estado frente al scraper", () => {
  it("el scraper no resucita una descartada, pero sí una expirada (y le quita la marca)", async () => {
    const { user, scraper } = await account();
    const dismissedPayload = offerPayload();
    const expiredPayload = offerPayload();
    const [dismissedId, expiredId] = (
      await scraper.post("/api/v1/offers/bulk", { offers: [dismissedPayload, expiredPayload] })
    ).body.offer_ids;

    await user.delete(`/api/v1/offers/${dismissedId}`, { reason: "no me convence" });
    await user.post(`/api/v1/offers/${expiredId}/expire`, { reason: "vendido" });
    await scraper.post("/api/v1/offers/bulk", { offers: [dismissedPayload, expiredPayload] });

    const dismissed = (await user.get(`/api/v1/offers/${dismissedId}`)).body;
    expect(dismissed).toMatchObject({ status: "dismissed", dismiss_reason: "no me convence" });
    const expired = (await user.get(`/api/v1/offers/${expiredId}`)).body;
    expect(expired).toMatchObject({ status: "active", dismiss_reason: null, dismissed_at: null });
  });

  it("los campos corregidos a mano quedan anclados; soltar los devuelve al scraper", async () => {
    const { user, scraper } = await account();
    const payload = offerPayload({ year: 2019 });
    const [id] = (await scraper.post("/api/v1/offers/bulk", { offers: [payload] })).body.offer_ids;

    const edited = await user.patch(`/api/v1/offers/${id}`, { year: 2018, price: 20990 });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ year: 2018, price: 20990, manual_fields: ["price", "year"] });
    expect(edited.body.edited_at).not.toBeNull();
    expect(edited.body.title).toBe(payload.title);

    await scraper.post("/api/v1/offers/bulk", {
      offers: [{ ...payload, year: 2019, price: 25990, title: "Título nuevo del scraper" }],
    });
    const pinned = (await user.get(`/api/v1/offers/${id}`)).body;
    expect(pinned).toMatchObject({ year: 2018, price: 20990, title: "Título nuevo del scraper" });
    // La corrección de precio entra en el historial; el precio del scraper no.
    const history = (await user.get(`/api/v1/offers/${id}/price-history`)).body;
    expect(history.map((p: { price: number }) => p.price)).toEqual([24590, 20990]);

    const released = await user.patch(`/api/v1/offers/${id}`, { clear_manual: true });
    expect(released.body).toMatchObject({ manual_fields: [], year: 2018 });
    await scraper.post("/api/v1/offers/bulk", { offers: [{ ...payload, year: 2019 }] });
    expect((await user.get(`/api/v1/offers/${id}`)).body.year).toBe(2019);
  });
});
