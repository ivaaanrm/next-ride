/**
 * La migración del aislamiento por cuenta sobre datos de antes de ella: una
 * base con tres personas que lo compartían todo. Se aplica en una D1 aparte
 * (`MIGRATION_DB`), la base de la app ya está migrada cuando arrancan las
 * pruebas.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const LEGACY = [
  // La más antigua no es superusuaria: la dueña es la superusuaria más antigua.
  `INSERT INTO users (id, email, created_at, updated_at, is_superuser) VALUES
     ('member', 'member@next-ride.test', 1000, 1000, 0),
     ('admin', 'admin@next-ride.test', 2000, 2000, 1),
     ('guest', 'guest@next-ride.test', 3000, 3000, 0)`,
  `INSERT INTO dealers (id, slug, name, notes) VALUES (1, 'motor', 'Motor', 'llamar antes')`,
  `INSERT INTO car_models (id, slug, make, model, trim, make_model_key, reference_price) VALUES
     (1, 'audi-a3-base', 'Audi', 'A3', 'Base', 'audi|a3', 30000),
     (2, 'audi-a3-sport', 'Audi', 'A3', 'Sport', 'audi|a3', NULL)`,
  `INSERT INTO offers (id, url, dealer_id, car_model_id, title, price) VALUES
     (1, 'https://dealer.example/1', 1, 1, 'A3 Base', 20000),
     (2, 'https://dealer.example/2', 1, 2, 'A3 Sport', 25000)`,
  `INSERT INTO offer_price_history (offer_id, price) VALUES (1, 21000), (1, 20000), (2, 25000)`,
  `INSERT INTO offer_favorites (user_id, offer_id) VALUES ('admin', 1), ('guest', 1), ('guest', 2)`,
  `INSERT INTO tracked_models (user_id, car_model_id, target_price) VALUES
     ('admin', 1, 19000), ('guest', 1, 18000), ('guest', 2, NULL)`,
  `INSERT INTO api_keys (name, prefix, hashed_key, created_by_id) VALUES
     ('scraper (bootstrap)', 'boot', 'hash-boot', NULL), ('la de guest', 'gues', 'hash-guest', 'guest')`,
  `INSERT INTO ranking_runs (id, make_model_key, label, status, triggered_by_id) VALUES
     (1, 'audi|a3', 'Audi A3', 'completed', 'guest')`,
  `INSERT INTO offer_rankings (run_id, offer_id, rank, score, verdict) VALUES
     (1, 1, 1, 90, 'good'), (1, 2, 2, 50, 'fair')`,
  `INSERT INTO score_config (id, weights, params) VALUES (1, '{"age": 5}', '{}')`,
];

const owners = async (db: D1Database, table: string) =>
  (await db.prepare(`SELECT DISTINCT user_id FROM ${table}`).all<{ user_id: string | null }>()).results.map(
    (row) => row.user_id,
  );

describe("migración 0003: aislamiento por cuenta", () => {
  it("da lo compartido a la superusuaria más antigua y deja lo personal de cada cual coherente", async () => {
    const db = env.MIGRATION_DB;
    await applyD1Migrations(
      db,
      env.TEST_MIGRATIONS.filter((migration) => migration.name < "0003"),
    );
    await db.batch(LEGACY.map((sql) => db.prepare(sql)));
    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    for (const table of ["offers", "dealers", "ranking_runs", "score_config", "scrape_targets"]) {
      expect(await owners(db, table), table).toEqual(["admin"]);
    }
    const seeded = await db.prepare("SELECT COUNT(*) AS n FROM scrape_targets").first<{ n: number }>();
    expect(seeded!.n).toBeGreaterThan(0);

    const keys = (await db.prepare("SELECT prefix, user_id FROM api_keys ORDER BY id").all()).results;
    expect(keys).toEqual([
      { prefix: "boot", user_id: "admin" },
      { prefix: "gues", user_id: "guest" },
    ]);

    // Nada se ha borrado por cascada al tocar `offers`.
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM offer_price_history")).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM offer_rankings")).toBe(2);

    // Los favoritos de guest señalaban ofertas que ya no son suyas.
    const favorites = (await db.prepare("SELECT user_id, offer_id FROM offer_favorites").all()).results;
    expect(favorites).toEqual([{ user_id: "admin", offer_id: 1 }]);

    // Sus seguimientos se quedan, sobre copias de las versiones en su cuenta
    // (sin el PVP que había curado admin).
    const tracked = (
      await db
        .prepare(
          `SELECT t.user_id, m.user_id AS model_owner, m.id AS model_id, m.slug, m.reference_price, t.target_price
           FROM tracked_models t JOIN car_models m ON m.id = t.car_model_id ORDER BY t.id`,
        )
        .all<Record<string, unknown>>()
    ).results;
    expect(tracked).toMatchObject([
      { user_id: "admin", model_owner: "admin", model_id: 1, reference_price: 30000, target_price: 19000 },
      { user_id: "guest", model_owner: "guest", slug: "audi-a3-base", reference_price: null, target_price: 18000 },
      { user_id: "guest", model_owner: "guest", slug: "audi-a3-sport", reference_price: null, target_price: null },
    ]);
    expect(await owners(db, "car_models")).toEqual(expect.arrayContaining(["admin", "guest"]));
    expect(await count("SELECT COUNT(*) AS n FROM car_models WHERE user_id = 'admin'")).toBe(2);

    // Las claves únicas ya son por cuenta: la misma URL entra en otra cuenta,
    // y no dos veces en la misma.
    const guestModel = tracked[1].model_id as number;
    await db.batch([
      db.prepare("INSERT INTO dealers (id, user_id, slug, name) VALUES (2, 'guest', 'motor', 'Motor')"),
      db
        .prepare(
          `INSERT INTO offers (user_id, url, dealer_id, car_model_id, title, price)
           VALUES ('guest', 'https://dealer.example/1', 2, ?1, 'A3 Base', 19000)`,
        )
        .bind(guestModel),
    ]);
    await expect(
      db
        .prepare(
          `INSERT INTO offers (user_id, url, dealer_id, car_model_id, title, price)
           VALUES ('admin', 'https://dealer.example/1', 1, 1, 'A3 Base', 19000)`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/);

    // Y los disparadores están puestos.
    const triggers = await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'");
    expect(triggers).toBe(8);
    await expect(
      db.prepare("INSERT INTO offer_favorites (user_id, offer_id) VALUES ('guest', 1)").run(),
    ).rejects.toThrow(/propia cuenta/);
  });
});
