#!/usr/bin/env node
/**
 * check-budgets — presupuesto de bytes del arranque, medido sobre `dist/`.
 *
 * Mide lo que un iPhone descarga y ejecuta *antes* de ver la primera pantalla:
 * el módulo de entrada, sus imports estáticos precargados y su hoja de estilos.
 * Todo comprimido con gzip, que es como viaja (nginx tiene `gzip on`).
 *
 *   npm run build && node scripts/check-budgets.mjs
 *   node scripts/check-budgets.mjs --json
 *
 * Los límites viven en `perf-budgets.json`. Subir un límite para que pase la
 * puerta es una regresión, no un arreglo: el fichero guarda la línea base para
 * que ese movimiento quede a la vista en el diff.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const JSON_OUT = process.argv.includes("--json");

const DEFAULTS = {
  initialJsGzipKb: 140,
  initialCssGzipKb: 24,
  initialTotalGzipKb: 160,
  largestAsyncChunkGzipKb: 120,
  totalPrecacheGzipKb: 1200,
};

function fail(message) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

if (!existsSync(DIST)) fail("no existe dist/. Ejecuta `npm run build` antes de medir.");

const budgetsPath = join(ROOT, "perf-budgets.json");
const config = existsSync(budgetsPath) ? JSON.parse(readFileSync(budgetsPath, "utf8")) : {};
const budgets = { ...DEFAULTS, ...(config.budgets ?? {}) };
const baseline = config.baseline ?? null;

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
const gzipOf = (path) => gzipSync(readFileSync(path), { level: 9 }).length;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------- carga inicial, según index.html */

const indexPath = join(DIST, "index.html");
if (!existsSync(indexPath)) fail("dist/index.html no existe: el build no ha terminado bien.");
const html = readFileSync(indexPath, "utf8");

const initial = { js: [], css: [] };
for (const tag of html.match(/<(script|link)\b[^>]*>/gi) ?? []) {
  const url = /(?:src|href)=["']([^"']+)["']/i.exec(tag)?.[1];
  if (!url || url.startsWith("data:") || url.startsWith("http")) continue;
  const relAttr = (/rel=["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
  const isScript = tag.toLowerCase().startsWith("<script");
  // modulepreload = imports estáticos del entry: se descargan en el arranque
  // aunque no aparezcan como <script>.
  if (isScript || relAttr === "modulepreload") initial.js.push(url);
  else if (relAttr === "stylesheet") initial.css.push(url);
}

const resolveAsset = (url) => join(DIST, url.replace(/^\//, ""));
const measure = (urls) =>
  urls
    .map((url) => ({ url, path: resolveAsset(url) }))
    .filter((asset) => existsSync(asset.path))
    .map((asset) => ({ url: asset.url, gzip: gzipOf(asset.path) }));

const initialJs = measure(initial.js);
const initialCss = measure(initial.css);
const sum = (assets) => assets.reduce((total, asset) => total + asset.gzip, 0);

const initialJsBytes = sum(initialJs);
const initialCssBytes = sum(initialCss);
const initialBytes = initialJsBytes + initialCssBytes;

/* ------------------------------------------------ resto de assets emitidos */

const initialPaths = new Set([...initialJs, ...initialCss].map((asset) => resolveAsset(asset.url)));
const allAssets = walk(DIST).map((path) => ({
  path,
  name: relative(DIST, path),
  gzip: gzipOf(path),
}));

const asyncChunks = allAssets
  .filter((asset) => asset.name.endsWith(".js") && !initialPaths.has(asset.path))
  .sort((a, b) => b.gzip - a.gzip);

const precacheBytes = allAssets.reduce((total, asset) => total + asset.gzip, 0);
const largestAsync = asyncChunks[0] ?? null;

/* ------------------------------------------------------------------ veredicto */

const results = [
  { id: "initialJsGzipKb", label: "JS inicial (entry + modulepreload)", actual: kb(initialJsBytes), budget: budgets.initialJsGzipKb },
  { id: "initialCssGzipKb", label: "CSS inicial", actual: kb(initialCssBytes), budget: budgets.initialCssGzipKb },
  { id: "initialTotalGzipKb", label: "Total de arranque", actual: kb(initialBytes), budget: budgets.initialTotalGzipKb },
  {
    id: "largestAsyncChunkGzipKb",
    label: `Mayor chunk diferido${largestAsync ? ` (${largestAsync.name})` : ""}`,
    actual: largestAsync ? kb(largestAsync.gzip) : 0,
    budget: budgets.largestAsyncChunkGzipKb,
  },
  { id: "totalPrecacheGzipKb", label: "Total de dist/ (coste de precaché)", actual: kb(precacheBytes), budget: budgets.totalPrecacheGzipKb },
].map((row) => ({
  ...row,
  over: row.actual > row.budget,
  // Avisa antes de romper: a partir del 90% queda poco margen.
  near: !(row.actual > row.budget) && row.actual > row.budget * 0.9,
  delta: Math.round((row.actual - row.budget) * 10) / 10,
}));

const breaches = results.filter((row) => row.over);
const ok = breaches.length === 0;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok,
        results,
        baseline,
        initial: { js: initialJs.map((a) => ({ ...a, gzipKb: kb(a.gzip) })), css: initialCss.map((a) => ({ ...a, gzipKb: kb(a.gzip) })) },
        asyncChunks: asyncChunks.slice(0, 10).map((a) => ({ name: a.name, gzipKb: kb(a.gzip) })),
      },
      null,
      2,
    ),
  );
} else {
  console.log("\nPresupuesto de arranque (gzip)\n" + "─".repeat(72));
  for (const row of results) {
    const mark = row.over ? "✗" : row.near ? "!" : "✓";
    const note = row.over ? `  +${row.delta} KB por encima` : row.near ? "  cerca del límite" : "";
    console.log(`  ${mark} ${row.label.padEnd(44)} ${String(row.actual).padStart(7)} / ${row.budget} KB${note}`);
  }
  if (baseline) {
    console.log("─".repeat(72));
    console.log(`  línea base registrada: ${JSON.stringify(baseline)}`);
  }
  console.log("─".repeat(72));
  if (asyncChunks.length) {
    console.log("  Chunks diferidos más pesados:");
    for (const chunk of asyncChunks.slice(0, 5)) console.log(`    · ${chunk.name.padEnd(48)} ${kb(chunk.gzip)} KB`);
  }
  console.log(
    ok
      ? "\n  Dentro de presupuesto.\n"
      : `\n  ${breaches.length} límite(s) superado(s): la puerta de rendimiento bloquea.\n`,
  );
}

process.exit(ok ? 0 : 1);
