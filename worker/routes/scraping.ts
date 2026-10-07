/**
 * Configuración operativa que consume el skill de captación.
 *
 * Las fuentes (portales) son de la plataforma: las ve cualquiera y solo las
 * edita un superusuario, porque sus `notes` y su `config` son instrucciones que
 * sigue el scraper de cada cuenta. Los targets —qué se busca en cada fuente—
 * son de cada cuenta, y el scraper recibe solo los de la cuenta de su clave.
 */
import { and, asc, eq, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { router } from "../app";
import { SCRAPE_ACCESS, scrapeSources, scrapeTargets, type ScrapeSource } from "../db/schema";
import { inList, runBatch, type Db } from "../lib/db";
import { conflict, notFound, parseBody, parseId, parseQuery, qBool, unprocessable } from "../lib/http";
import { owned, ownedRow } from "../lib/tenant";
import { requireIngest, requireSuperuser, requireUser } from "../middleware";
import { int, nullable } from "../schemas/common";
import {
  canonicalMakeModelKey,
  defaultSearchParams,
  renderSearchUrl,
} from "../services/scraping-config";
import { scrapeSourceRead, scrapeTargetRead } from "../services/serialize";

const ScrapeSourceCreate = z.object({
  key: z.string().min(1).max(80).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(160),
  base_url: z.string().min(1).max(500),
  search_url_template: nullable(z.string().max(1000)),
  listing_url: nullable(z.string().max(1000)),
  access: z.enum(SCRAPE_ACCESS),
  notes: nullable(z.string()),
  config: z.record(z.string(), z.unknown()).default({}),
});

const ScrapeSourceUpdate = z
  .object({
    name: z.string().min(1).max(160),
    base_url: z.string().min(1).max(500),
    search_url_template: z.string().max(1000).nullable(),
    listing_url: z.string().max(1000).nullable(),
    access: z.enum(SCRAPE_ACCESS),
    notes: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
    is_active: z.boolean(),
  })
  .partial();

const collapse = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");

const ScrapeTargetsReplace = z
  .object({
    max_per_target: int(z.number().min(1).max(100)).default(15),
    targets: z
      .array(
        z.object({
          source_id: int(z.number().gt(0)),
          make: z.string().min(1).max(80).transform(collapse),
          model: z.string().min(1).max(120).transform(collapse),
        }),
      )
      .default([]),
  })
  .refine(
    (value) => {
      const identities = value.targets.map(
        (t) => `${t.source_id}|${t.make.toLowerCase()}|${t.model.toLowerCase()}`,
      );
      return identities.length === new Set(identities).size;
    },
    { message: "No repitas una combinación de modelo y fuente" },
  );

const ScrapeTargetPatch = z
  .object({
    search_url: z.string().max(1000).nullable(),
    search_params: z.record(z.string(), z.unknown()),
    max_results: int(z.number().min(1).max(100)),
    is_active: z.boolean(),
  })
  .partial();

export const scrapingRoutes = router();

scrapingRoutes.get("/sources", requireUser, async (c) => {
  const { include_inactive } = parseQuery(c, z.object({ include_inactive: qBool }));
  const rows = await c.var.db
    .select()
    .from(scrapeSources)
    .where(include_inactive ? undefined : eq(scrapeSources.is_active, true))
    .orderBy(asc(scrapeSources.name));
  return c.json(rows.map(scrapeSourceRead));
});

scrapingRoutes.post("/sources", requireSuperuser, async (c) => {
  const payload = await parseBody(c, ScrapeSourceCreate);
  const [existing] = await c.var.db
    .select({ id: scrapeSources.id })
    .from(scrapeSources)
    .where(eq(scrapeSources.key, payload.key));
  if (existing) throw conflict("Ya existe una fuente con esa clave");
  const [source] = await c.var.db.insert(scrapeSources).values(payload).returning();
  return c.json(scrapeSourceRead(source), 201);
});

scrapingRoutes.patch("/sources/:id", requireSuperuser, async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, ScrapeSourceUpdate);
  const db = c.var.db;
  const [source] = Object.keys(payload).length
    ? await db.update(scrapeSources).set(payload).where(eq(scrapeSources.id, id)).returning()
    : await db.select().from(scrapeSources).where(eq(scrapeSources.id, id));
  if (!source) throw notFound("Fuente de rastreo no encontrada");
  return c.json(scrapeSourceRead(source));
});

/** Los targets de la cuenta `tenantId`, con su fuente; `where` solo estrecha. */
async function targetsWithSource(db: Db, tenantId: string, where?: SQL) {
  return db
    .select({ target: scrapeTargets, source: scrapeSources })
    .from(scrapeTargets)
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeTargets.source_id))
    .where(and(owned(scrapeTargets, tenantId), where))
    .orderBy(asc(scrapeTargets.make), asc(scrapeTargets.model), asc(scrapeTargets.source_id));
}

scrapingRoutes.get("/targets", requireUser, async (c) => {
  const { include_inactive } = parseQuery(c, z.object({ include_inactive: qBool }));
  const rows = await targetsWithSource(
    c.var.db,
    c.var.tenantId,
    include_inactive ? undefined : eq(scrapeTargets.is_active, true),
  );
  return c.json(rows.map((row) => scrapeTargetRead(row.target, row.source)));
});

/** Reemplaza atómicamente la selección activa de la cuenta, conservando los mappings aprendidos. */
scrapingRoutes.put("/targets", requireUser, async (c) => {
  const payload = await parseBody(c, ScrapeTargetsReplace);
  const db = c.var.db;
  const tenantId = c.var.tenantId;

  const sourceIds = [...new Set(payload.targets.map((item) => item.source_id))];
  const sources = new Map<number, ScrapeSource>(
    (
      await db
        .select()
        .from(scrapeSources)
        .where(and(inList(scrapeSources.id, sourceIds), eq(scrapeSources.is_active, true)))
    ).map((source) => [source.id, source]),
  );
  const missing = sourceIds.filter((id) => !sources.has(id)).sort((a, b) => a - b);
  if (missing.length) {
    throw unprocessable(`Fuentes inexistentes o inactivas: ${missing.join(", ")}`);
  }

  const existing = await targetsWithSource(db, tenantId);
  const byIdentity = new Map(
    existing.map((row) => [`${row.target.source_id}|${row.target.make_model_key}`, row]),
  );
  const selected = new Set<string>();
  const now = new Date().toISOString();
  const statements: BatchItem<"sqlite">[] = [];

  for (const item of payload.targets) {
    const key = canonicalMakeModelKey(item.make, item.model);
    const identity = `${item.source_id}|${key}`;
    selected.add(identity);
    const source = sources.get(item.source_id)!;
    const current = byIdentity.get(identity)?.target;
    const defaults = defaultSearchParams(source, item.make, item.model);
    if (!current) {
      statements.push(
        db.insert(scrapeTargets).values({
          user_id: tenantId,
          source_id: item.source_id,
          make_model_key: key,
          make: item.make,
          model: item.model,
          max_results: payload.max_per_target,
          search_params: defaults,
          is_active: true,
        }),
      );
    } else {
      statements.push(
        db
          .update(scrapeTargets)
          .set({
            make: item.make,
            model: item.model,
            max_results: payload.max_per_target,
            is_active: true,
            search_params: { ...defaults, ...current.search_params },
            updated_at: now,
          })
          .where(eq(scrapeTargets.id, current.id)),
      );
    }
  }

  // La selección describe únicamente fuentes activas. Apagar por omisión los
  // targets de una fuente inactiva borraría lo que tenía configurado, y
  // reactivarla la dejaría vacía; mientras esté inactiva no se rastrea nada suyo.
  const deactivate = existing
    .filter(
      (row) =>
        row.source.is_active &&
        row.target.is_active &&
        !selected.has(`${row.target.source_id}|${row.target.make_model_key}`),
    )
    .map((row) => row.target.id);
  if (deactivate.length) {
    statements.push(
      db
        .update(scrapeTargets)
        .set({ is_active: false, updated_at: now })
        .where(inList(scrapeTargets.id, deactivate)),
    );
  }
  await runBatch(db, statements);

  const rows = await targetsWithSource(db, tenantId, eq(scrapeTargets.is_active, true));
  const byKey = new Map(rows.map((row) => [`${row.target.source_id}|${row.target.make_model_key}`, row]));
  return c.json(
    payload.targets.flatMap((item) => {
      const row = byKey.get(`${item.source_id}|${canonicalMakeModelKey(item.make, item.model)}`);
      return row ? [scrapeTargetRead(row.target, row.source)] : [];
    }),
  );
});

/** El skill persiste aquí una URL o unos IDs descubiertos en el navegador. */
scrapingRoutes.patch("/targets/:id", requireIngest, async (c) => {
  const id = parseId(c, "id");
  const payload = await parseBody(c, ScrapeTargetPatch);
  const db = c.var.db;
  const tenantId = c.var.tenantId;
  if (Object.keys(payload).length) {
    await db.update(scrapeTargets).set(payload).where(ownedRow(scrapeTargets, tenantId, id));
  }
  const [row] = await targetsWithSource(db, tenantId, eq(scrapeTargets.id, id));
  if (!row) throw notFound("Target de rastreo no encontrado");
  return c.json(scrapeTargetRead(row.target, row.source));
});

/** Configuración completa que el skill pide antes de abrir ningún dealer: la de su cuenta. */
scrapingRoutes.get("/config", requireIngest, async (c) => {
  const rows = await c.var.db
    .select({ target: scrapeTargets, source: scrapeSources })
    .from(scrapeTargets)
    .innerJoin(scrapeSources, eq(scrapeSources.id, scrapeTargets.source_id))
    .where(
      and(
        owned(scrapeTargets, c.var.tenantId),
        eq(scrapeTargets.is_active, true),
        eq(scrapeSources.is_active, true),
      ),
    )
    .orderBy(asc(scrapeTargets.make), asc(scrapeTargets.model), asc(scrapeSources.name));

  return c.json({
    max_per_target: rows.length ? Math.max(...rows.map((row) => row.target.max_results)) : 15,
    targets: rows.map(({ target, source }) => ({
      id: target.id,
      make_model_key: target.make_model_key,
      make: target.make,
      model: target.model,
      label: `${target.make} ${target.model}`,
      max_results: target.max_results,
      search_url: renderSearchUrl(source.search_url_template, target.search_params, target.search_url),
      search_params: target.search_params,
      source: scrapeSourceRead(source),
    })),
  });
});
