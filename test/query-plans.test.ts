/**
 * Los planes de las consultas de las pantallas principales.
 *
 * D1 no tiene estadísticas: SQLite elige índice por la forma de la consulta, y
 * cree que `user_id = ?` es tan selectivo como cualquier clave. Un filtro de
 * cuenta de más en una unión (`o.user_id = ?` en las ofertas de cada dealer) le
 * bastó para recorrer todas las ofertas de la cuenta **por cada dealer**: 2,6
 * millones de filas y 8 s en producción, y las demás peticiones esperando
 * detrás (`lib/tenant.ts`).
 *
 * Aquí se registra cada sentencia que lanzan las pantallas y se pide su plan.
 * Un índice de cuenta sobre `offers` solo puede abrir una consulta: dentro de
 * un bucle (el segundo de una unión, una subconsulta correlacionada) es leer la
 * cuenta entera una vez por fila. Sin estadísticas el plan no depende de
 * cuántas filas haya, así que unas pocas ofertas bastan para verlo.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { account, offerPayload, unique } from "./client";

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** Un índice de cuenta sobre las ofertas: `ix_offers_user_*` o la clave única por URL. */
const TENANT_INDEX = /^SEARCH (offers|o) USING (COVERING )?INDEX (ix_offers_user_\w+|uq_offers_user_url)\b/;
/** Un bucle: lo que recorre filas, frente a las anotaciones del plan. */
const LOOP = /^(SEARCH|SCAN) /;

/** Lo que el plan hace mal: búsquedas por cuenta dentro de un bucle y recorridos enteros de `offers`. */
function violations(plan: PlanRow[]): string[] {
  const byId = new Map(plan.map((row) => [row.id, row]));
  const correlated = (row: PlanRow): boolean => {
    for (let up = byId.get(row.parent); up; up = byId.get(up.parent)) {
      if (up.detail.includes("CORRELATED")) return true;
    }
    return false;
  };
  const found: string[] = [];
  for (const row of plan) {
    if (/^SCAN (offers|o)\b/.test(row.detail)) found.push(`recorrido entero: ${row.detail}`);
    if (!TENANT_INDEX.test(row.detail)) continue;
    const outer = plan.find((other) => other.parent === row.parent && LOOP.test(other.detail));
    if (outer !== row) found.push(`dentro de una unión: ${row.detail}`);
    else if (correlated(row)) found.push(`en una subconsulta correlacionada: ${row.detail}`);
  }
  return found;
}

/**
 * Con un filtro por clave (`dealer_id = ?`, `car_model_id = ?`) las ofertas
 * tienen que salir del índice de esa clave: el de la cuenta las leería todas
 * para quedarse con las de un dealer, aunque abra la consulta.
 */
function ignoredKeys(sql: string, plan: PlanRow[]): string[] {
  const keys = [...sql.matchAll(/"offers"\."(dealer_id|car_model_id)" = \?/g)].map((m) => m[1]);
  const viaTenant = plan.filter((row) => TENANT_INDEX.test(row.detail));
  return keys.length && viaTenant.length
    ? viaTenant.map((row) => `ignora el filtro por ${keys.join(", ")}: ${row.detail}`)
    : [];
}

async function planOf(sql: string, params: unknown[]): Promise<PlanRow[]> {
  const { results } = await original.call(env.DB, `EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<PlanRow>();
  return results;
}

// ---- Registro de sentencias ------------------------------------------------- //
const original = env.DB.prepare;
let recorded: { sql: string; params: unknown[] }[] = [];

beforeEach(() => {
  recorded = [];
  env.DB.prepare = function (this: D1Database, sql: string) {
    const statement = original.call(this, sql);
    const entry = { sql, params: [] as unknown[] };
    recorded.push(entry);
    const bind = statement.bind.bind(statement);
    statement.bind = (...params: unknown[]) => {
      entry.params = params;
      return bind(...params);
    };
    return statement;
  };
});

afterEach(() => {
  env.DB.prepare = original;
});

/** Una cuenta con unas cuantas ofertas repartidas en dos binomios y tres dealers. */
async function seeded() {
  const owner = await account("Planes");
  const make = unique("Planes");
  const offers = [0, 1, 2, 3, 4, 5].map((i) =>
    offerPayload({
      make,
      model: i % 2 ? "Uno" : "Dos",
      trim: `T${i % 3}`,
      title: `${make} ${i}`,
      dealer_name: `Dealer ${make} ${i % 3}`,
      price: 18000 + i * 1000,
    }),
  );
  const res = await owner.scraper.post("/api/v1/offers/bulk", { offers });
  expect(res.body).toMatchObject({ created: offers.length, skipped: 0 });
  return { ...owner, make, ids: res.body.offer_ids as number[] };
}

describe("planes de consulta", () => {
  // Con los índices de la 0004 SQLite ya no elige esos planes por su cuenta:
  // `INDEXED BY` los fuerza, para que el detector no apruebe por no mirar.
  it("el detector señala el plan de /dealers que leía 2,6 millones de filas", async () => {
    const owner = await account("Detector");
    const plan = await planOf(
      `SELECT d.id, COUNT(o.id) FROM dealers d
       LEFT JOIN offers o INDEXED BY ix_offers_user_status_last_seen
         ON o.dealer_id = d.id AND o.user_id = ?1 AND o.status = 'active'
       WHERE d.user_id = ?1 GROUP BY d.id`,
      [owner.id],
    );
    expect(violations(plan)).toEqual([
      expect.stringMatching(/^dentro de una unión: SEARCH o USING .*INDEX ix_offers_user_/),
    ]);
  });

  it("el detector señala un filtro por dealer resuelto con el índice de la cuenta", async () => {
    const owner = await account("Detector");
    const sql = `SELECT "offers"."id" FROM "offers" INDEXED BY ix_offers_user_status_price
      WHERE "offers"."user_id" = ? AND "offers"."status" = 'active' AND "offers"."dealer_id" = ?
      ORDER BY "offers"."price"`;
    const plan = await planOf(sql, [owner.id, 1]);
    expect(violations(plan)).toEqual([]);
    expect(ignoredKeys(sql, plan)).toEqual([expect.stringMatching(/^ignora el filtro por dealer_id: /)]);
  });

  it("ninguna pantalla busca por cuenta dentro de un bucle ni recorre las ofertas enteras", async () => {
    const { user, make, ids } = await seeded();
    const q = encodeURIComponent(make.toLowerCase());
    const groups = (await user.get(`/api/v1/car-models/groups?q=${q}`)).body;
    const modelId = groups[0].variants[0].id as number;
    const dealerId = (await user.get(`/api/v1/offers/${ids[0]}`)).body.dealer.id as number;

    recorded = [];
    const screens = [
      "/api/v1/offers",
      "/api/v1/offers?sort=price",
      "/api/v1/offers?sort=-last_seen_at&offset=2&limit=2",
      "/api/v1/offers?sort=ai_score",
      `/api/v1/offers?q=${q}&min_price=19000&max_year=2030`,
      `/api/v1/offers?car_model_id=${modelId}`,
      `/api/v1/offers?dealer_id=${dealerId}`,
      `/api/v1/offers?dealer_id=${dealerId}&sort=-year`,
      `/api/v1/offers?car_model_id=${modelId}&sort=mileage_km`,
      "/api/v1/offers?tracked_only=true&favorites_only=true",
      "/api/v1/offers/stats",
      `/api/v1/offers/stats?dealer_id=${dealerId}`,
      "/api/v1/offers/facets",
      `/api/v1/offers/${ids[1]}`,
      `/api/v1/offers/${ids[1]}/price-history`,
      "/api/v1/dealers",
      "/api/v1/car-models",
      `/api/v1/car-models/${modelId}`,
      `/api/v1/car-models/groups?q=${q}`,
      "/api/v1/stats/overview",
      `/api/v1/stats/car-models/${modelId}`,
      `/api/v1/analytics/segments?q=${q}`,
      "/api/v1/tracked-models",
    ];
    for (const path of screens) {
      const res = await user.get(path);
      expect(res.status, path).toBe(200);
    }

    const selects = recorded.filter((entry) => /^\s*select\b/i.test(entry.sql));
    expect(selects.length).toBeGreaterThan(screens.length);
    const problems: string[] = [];
    for (const { sql, params } of selects) {
      const plan = await planOf(sql, params);
      for (const problem of [...violations(plan), ...ignoredKeys(sql, plan)]) {
        problems.push(`${problem}\n    ${sql}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
