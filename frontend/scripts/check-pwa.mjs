#!/usr/bin/env node
/**
 * check-pwa — auditoría estática de la capa PWA / iOS del frontend.
 *
 * Es el suelo determinista de las validaciones: lo que aquí falla, falla igual
 * en el móvil de cualquiera. Los agentes validadores del workflow `pwa-ios`
 * ejecutan este script antes de opinar, para que el debate empiece donde
 * terminan los hechos.
 *
 *   node scripts/check-pwa.mjs           # informe legible, sale 1 si hay errores
 *   node scripts/check-pwa.mjs --strict  # los avisos también hacen fallar
 *   node scripts/check-pwa.mjs --json    # salida para consumir desde un agente
 *
 * Sin dependencias: tiene que poder correr en el contenedor de build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const PUBLIC = join(ROOT, "public");
const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has("--strict");
const JSON_OUT = ARGS.has("--json");

const checks = [];
/** @param {"error"|"warn"} level */
const check = (level, id, title, ok, detail = "") =>
  checks.push({ id, level, title, ok: Boolean(ok), detail: String(detail) });
const pass = (id, title, detail) => check("error", id, title, true, detail);

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const rel = (path) => path.replace(`${ROOT}/`, "");

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/* ---------------------------------------------------------------- index.html */

const htmlPath = join(ROOT, "index.html");
const html = read(htmlPath);
check("error", "html.exists", "index.html existe", html !== null, htmlPath);

let manifestHref = null;
if (html) {
  const viewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.exec(html)?.[0] ?? "";
  const content = /content=["']([^"']*)["']/i.exec(viewport)?.[1] ?? "";

  check(
    "error",
    "html.viewport.device-width",
    "viewport declara width=device-width",
    /width=device-width/i.test(content),
    content || "no hay <meta name=viewport>",
  );
  check(
    "error",
    "html.viewport.fit-cover",
    "viewport declara viewport-fit=cover",
    /viewport-fit=\s*cover/i.test(content),
    "sin él, env(safe-area-inset-*) siempre vale 0 y el contenido se mete bajo la isla dinámica",
  );
  check(
    "error",
    "html.viewport.zoom-allowed",
    "el zoom no está bloqueado",
    !/user-scalable\s*=\s*(no|0)/i.test(content) && !/maximum-scale\s*=\s*1(\.0)?\b/i.test(content),
    "user-scalable=no / maximum-scale=1 rompen WCAG 1.4.4",
  );

  const link = (rel) => new RegExp(`<link[^>]+rel=["']${rel}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
  const meta = (name) =>
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
  const attr = (tag, name) =>
    new RegExp(`${name}=["']([^"']*)["']`, "i").exec(tag)?.[1] ?? "";

  const manifestTag = link("manifest");
  manifestHref = attr(manifestTag, "href") || null;
  check("error", "html.manifest", "index.html enlaza el manifest", Boolean(manifestHref), manifestTag);

  const appleIcon = link("apple-touch-icon");
  check(
    "error",
    "html.apple-touch-icon",
    "hay apple-touch-icon",
    Boolean(appleIcon),
    "iOS lo usa como icono de la pantalla de inicio; sin él coge una captura de la página",
  );

  check("error", "html.theme-color", "hay <meta theme-color>", Boolean(meta("theme-color")));
  check(
    "error",
    "html.web-app-capable",
    "modo standalone declarado en el <head>",
    Boolean(meta("mobile-web-app-capable")) || Boolean(meta("apple-mobile-web-app-capable")),
  );
  check(
    "warn",
    "html.status-bar-style",
    "apple-mobile-web-app-status-bar-style definido",
    Boolean(meta("apple-mobile-web-app-status-bar-style")),
    "decide si el contenido pasa por debajo de la barra de estado",
  );
  check(
    "warn",
    "html.app-title",
    "apple-mobile-web-app-title definido",
    Boolean(meta("apple-mobile-web-app-title")),
    "es la etiqueta bajo el icono en la pantalla de inicio",
  );
  check(
    "warn",
    "html.format-detection",
    "format-detection: telephone=no",
    /telephone\s*=\s*no/i.test(meta("format-detection")),
    "iOS convierte precios, años y kilómetros en enlaces telefónicos si no",
  );
}

/* ------------------------------------------------------------------ manifest */

const manifestCandidates = [
  manifestHref ? join(PUBLIC, manifestHref.replace(/^\//, "")) : null,
  manifestHref ? join(ROOT, manifestHref.replace(/^\//, "")) : null,
  join(PUBLIC, "manifest.webmanifest"),
  join(PUBLIC, "manifest.json"),
].filter(Boolean);

const manifestPath = manifestCandidates.find((path) => existsSync(path)) ?? null;
check(
  "error",
  "manifest.exists",
  "el fichero de manifest existe en disco",
  Boolean(manifestPath),
  manifestPath ? rel(manifestPath) : `buscado en: ${manifestCandidates.map(rel).join(", ")}`,
);

if (manifestPath) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    check("error", "manifest.json", "el manifest es JSON válido", false, String(error.message));
  }

  if (manifest) {
    pass("manifest.json", "el manifest es JSON válido", rel(manifestPath));

    for (const field of ["name", "short_name", "start_url", "scope", "display", "background_color", "theme_color"]) {
      check("error", `manifest.${field}`, `manifest.${field} presente`, Boolean(manifest[field]));
    }
    check(
      "error",
      "manifest.display",
      "display es instalable (standalone / fullscreen / minimal-ui)",
      ["standalone", "fullscreen", "minimal-ui"].includes(manifest.display),
      `display=${manifest.display}`,
    );
    check("warn", "manifest.id", "manifest.id presente", Boolean(manifest.id), "cambiarlo más tarde instala una app distinta");
    check(
      "warn",
      "manifest.short_name.length",
      "short_name cabe bajo el icono (≤12 caracteres)",
      !manifest.short_name || manifest.short_name.length <= 12,
      `short_name="${manifest.short_name}" (${manifest.short_name?.length ?? 0})`,
    );
    check(
      "warn",
      "manifest.start_url.scope",
      "start_url cae dentro de scope",
      !manifest.start_url || !manifest.scope || String(manifest.start_url).startsWith(String(manifest.scope)),
      `start_url=${manifest.start_url} scope=${manifest.scope}`,
    );

    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const sizes = icons.flatMap((icon) => String(icon.sizes ?? "").split(/\s+/));
    check("error", "manifest.icons.192", "hay icono 192x192", sizes.includes("192x192"));
    check("error", "manifest.icons.512", "hay icono 512x512", sizes.includes("512x512"));
    check(
      "error",
      "manifest.icons.maskable",
      "hay al menos un icono maskable",
      icons.some((icon) => String(icon.purpose ?? "").includes("maskable")),
    );

    const missing = icons
      .map((icon) => String(icon.src ?? "").replace(/^\//, ""))
      .filter((src) => src && !existsSync(join(PUBLIC, src)) && !existsSync(join(ROOT, src)));
    check(
      "error",
      "manifest.icons.files",
      "todos los iconos declarados existen en disco",
      missing.length === 0,
      missing.length ? `faltan: ${missing.join(", ")}` : `${icons.length} iconos verificados`,
    );
  }
}

/* ------------------------------------------------------------ service worker */

const srcFiles = walk(SRC, [".ts", ".tsx", ".js", ".jsx"]);
const srcBlob = srcFiles.map((file) => read(file) ?? "").join("\n");
const pkg = JSON.parse(read(join(ROOT, "package.json")) ?? "{}");
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const viteConfig = read(join(ROOT, "vite.config.ts")) ?? read(join(ROOT, "vite.config.js")) ?? "";

const registers = /serviceWorker\s*\.\s*register|registerSW|virtual:pwa-register/.test(srcBlob);
const swFile = ["public/sw.js", "public/service-worker.js", "src/sw.ts", "src/sw.js"].find((path) =>
  existsSync(join(ROOT, path)),
);
const pwaPlugin = Boolean(deps["vite-plugin-pwa"]) && /VitePWA/.test(viteConfig);

check(
  "error",
  "sw.registered",
  "la app registra un service worker",
  registers || pwaPlugin,
  "sin registro no hay instalación offline ni control de actualizaciones",
);
check(
  "error",
  "sw.source",
  "existe la fuente del service worker",
  Boolean(swFile) || pwaPlugin,
  swFile ? swFile : pwaPlugin ? "generado por vite-plugin-pwa" : "no encontrado",
);
if (registers && !pwaPlugin) {
  check(
    "warn",
    "sw.prod-only",
    "el registro está limitado a producción",
    /import\.meta\.env\.PROD|NODE_ENV\s*===?\s*["']production["']/.test(srcBlob),
    "registrar el worker en dev sirve caché rancia mientras se desarrolla",
  );
}

/* --------------------------------------------------- nginx: caché del worker */

const nginx = read(join(ROOT, "nginx.conf"));
if (nginx && (swFile || pwaPlugin)) {
  const immutableJs = /\\\.\([^)]*\bjs\b[^)]*\)/.test(nginx) && /immutable/.test(nginx);
  const swExempt = /location\s*=\s*\/(sw|service-worker)\.js/.test(nginx);
  check(
    "error",
    "nginx.sw-cache",
    "el service worker está exento de la caché inmutable",
    !immutableJs || swExempt,
    "la regla de assets `immutable` casa con /sw.js: los usuarios se quedan clavados en la versión vieja para siempre",
  );
  check(
    "warn",
    "nginx.manifest-type",
    "el manifest se sirve con su content-type",
    /webmanifest/.test(nginx) || !manifestPath || manifestPath.endsWith(".json"),
    "añade `types { application/manifest+json webmanifest; }` o sírvelo como .json",
  );
}

/* ----------------------------------------------------------------- CSS / iOS */

const cssFiles = walk(SRC, [".css"]);
const css = cssFiles.map((file) => read(file) ?? "").join("\n");

check(
  "error",
  "css.safe-area",
  "el CSS usa env(safe-area-inset-*)",
  /env\(\s*safe-area-inset/.test(css),
  "en standalone el contenido se mete bajo la isla dinámica y el indicador de inicio",
);

const vh = (css.match(/\b100vh\b/g) ?? []).length;
check(
  "error",
  "css.no-100vh",
  "no quedan alturas basadas en 100vh sin alternativa dinámica",
  vh === 0 || /\b100dvh\b|-webkit-fill-available/.test(css),
  vh === 0 ? "sin usos" : `${vh} usos de 100vh; en iOS 100vh es más alto que el área visible`,
);

check("warn", "css.tap-highlight", "-webkit-tap-highlight-color definido", /-webkit-tap-highlight-color/.test(css));
check("warn", "css.touch-action", "touch-action declarado en elementos interactivos", /touch-action\s*:/.test(css));
check("warn", "css.overscroll", "overscroll-behavior declarado", /overscroll-behavior/.test(css));
check(
  "warn",
  "css.tap-target",
  "hay un token o regla de objetivo táctil de 44pt",
  /--tap-target|min-height:\s*44px|min-block-size:\s*44px|min-height:\s*2\.75rem/.test(css),
  "Apple HIG: 44x44pt mínimo por objetivo táctil",
);
check("warn", "css.dark-mode", "hay soporte de prefers-color-scheme", /prefers-color-scheme/.test(css));

/* ------------------------------------- tamaño de fuente en campos de entrada */

/** Recorre bloques `selector { declaraciones }` saltándose las at-rules. */
function eachRule(source, visit) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  let buffer = "";
  for (const ch of clean) {
    if (ch === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (ch === "}") {
      const selector = stack.pop() ?? "";
      if (selector && !selector.startsWith("@")) visit(selector, buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
}

const FIELD = /(^|[\s,>+~(])(input|textarea|select)\b/i;
const offenders = [];
let fieldFontRules = 0;
let fieldInherits = false;

for (const file of cssFiles) {
  eachRule(read(file) ?? "", (selector, decls) => {
    if (!FIELD.test(selector)) return;
    if (/font\s*:\s*inherit/.test(decls) || /font-family\s*:\s*inherit/.test(decls)) fieldInherits = true;
    const match = /font-size\s*:\s*([0-9.]+)(px|rem|em)/i.exec(decls);
    if (!match) return;
    fieldFontRules += 1;
    const px = match[2].toLowerCase() === "px" ? Number(match[1]) : Number(match[1]) * 16;
    if (px < 16) offenders.push(`${rel(file)} → ${selector.trim().slice(0, 60)} (${match[1]}${match[2]})`);
  });
}

check(
  "error",
  "css.input-font-size",
  "ningún campo de entrada baja de 16px",
  offenders.length === 0,
  offenders.length ? offenders.join(" | ") : "Safari hace zoom a la página al enfocar un campo <16px",
);
check(
  "warn",
  "css.input-font-size.explicit",
  "los campos declaran su tamaño de fuente explícitamente",
  fieldFontRules > 0 && !(fieldInherits && fieldFontRules === 0),
  "los controles de formulario no heredan font-size: sin regla explícita quedan en ~13px y Safari hace zoom",
);

/* --------------------------------------- el worker no guarda nada con sesión */

/* La propiedad que sostiene toda la capa offline es que ninguna respuesta con
   datos de usuario llega a una caché: el `fetch` del worker es una lista blanca
   y `/api/` sale antes de que se abra nada. Eso es correcto hoy y no hay purga en
   el cierre de sesión, porque no hace falta. El riesgo es el día que alguien
   añada una caché por usuario: no habría nada que llamar desde el logout y el
   fallo sería mudo. Así que la forma se congela aquí.

   Se comprueba a qué función pertenece cada `cache.put`: si aparece uno fuera de
   los dos ayudantes revisados, la puerta se cierra y alguien tiene que mirarlo. */
const CACHE_PUT_ALLOWED = ["networkFirstDocument", "cacheFirst"];
const swSource = swFile ? read(join(ROOT, swFile)) : null;

if (swSource) {
  const fns = [...swSource.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
  }));
  const enclosing = (at) => {
    let found = "(nivel superior)";
    for (const fn of fns) if (fn.at < at) found = fn.name;
    return found;
  };

  const putSites = [...swSource.matchAll(/cache\.put\s*\(/g)].map((m) => enclosing(m.index ?? 0));
  const strays = putSites.filter((name) => !CACHE_PUT_ALLOWED.includes(name));

  check(
    "error",
    "sw.cache-put-allowlist",
    "solo los ayudantes revisados escriben en caché",
    strays.length === 0,
    strays.length
      ? `cache.put fuera de la lista blanca, en: ${[...new Set(strays)].join(", ")}`
      : `${putSites.length} llamadas, todas en ${CACHE_PUT_ALLOWED.join(" / ")}`,
  );

  check(
    "error",
    "sw.api-never-cached",
    "el worker excluye /api/ antes de tocar ninguna caché",
    /["'`]\/api\//.test(swSource),
    "sin esa exclusión una respuesta autenticada puede sobrevivir al cierre de sesión",
  );

  /* El shell se guarda bajo una clave canónica, así que cualquier navegación de
     primer nivel que devuelva 200 puede ocupar su sitio. Solo debe hacerlo si lo
     que ha vuelto es HTML: guardar un JSON ahí deja la app sin arranque offline y
     en standalone sin forma de escapar. */
  check(
    "error",
    "sw.shell-html-guard",
    "el shell solo se guarda si la respuesta es HTML",
    /content-type/i.test(swSource) && /text\/html/.test(swSource),
    "falta la guarda de tipo antes de `cache.put(\"/index.html\", …)`",
  );
}

/* ------------------------------------------------ clases usadas y sin estilo */

/* Un componente puede montarse, compilar y pasar el typecheck estando entero sin
   estilos: la pantalla sale desnuda y nada falla. Ya ocurrió —la lista de ofertas
   del móvil se entregó con 54 clases sin una sola regla— porque quien escribió los
   componentes no era dueño de `styles.css`. Esto lo convierte en un error de puerta.

   Tailwind solo lo usan los componentes de shadcn bajo `src/components/ui`: sus
   utilidades no viven en el CSS propio y darían falsos positivos, así que quedan
   fuera del barrido. */
const ownComponents = walk(SRC, [".tsx"]).filter((file) => !file.includes("/components/ui/"));
const orphans = [];

for (const file of ownComponents) {
  const source = read(file) ?? "";
  const used = new Set();
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]*)`\})/g)) {
    // Las interpolaciones se caen: lo que aportan es condicional y se comprueba
    // por su rama literal, no por el `${…}`.
    const raw = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const name of raw.split(/\s+/)) if (name && /^[a-z][a-z0-9-]*$/.test(name)) used.add(name);
  }
  const missing = [...used].filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
  if (missing.length) orphans.push(`${rel(file)} → ${missing.join(" ")}`);
}

check(
  "error",
  "css.orphan-classes",
  "toda clase que usa un componente tiene reglas",
  orphans.length === 0,
  orphans.length ? orphans.join(" | ") : `${ownComponents.length} componentes verificados`,
);

/* ------------------------------------------- tablas: prohibido el scroll lateral */

/* Regla de producto: en el móvil una tabla no se lee arrastrándola de lado. O cabe
   en una columna, o es una lista. Una tabla desmontada con `display: block` tampoco
   vale —pierde la semántica sin avisar—, así que lo que se exige es marcado distinto
   detrás del gate táctil, como hace `Offers.tsx`. */
// Sin los comentarios de bloque: este repositorio explica sus decisiones por
// escrito, y un `<table>` citado en una explicación no es una tabla.
const code = (file) => (read(file) ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
const tableFiles = ownComponents.filter((file) => /<table\b/.test(code(file)));
const ungatedTables = tableFiles.filter((file) => !/useTouchLayout|useMediaQuery/.test(code(file)));

check(
  "error",
  "layout.no-mobile-table",
  "ninguna tabla llega al móvil como tabla con scroll horizontal",
  ungatedTables.length === 0,
  ungatedTables.length
    ? `sin alternativa táctil: ${ungatedTables.map(rel).join(", ")}`
    : `${tableFiles.length} pantallas con tabla, todas con lista táctil`,
);

/* ------------------------------------------------------------------- informe */

const failures = checks.filter((c) => !c.ok);
const errors = failures.filter((c) => c.level === "error");
const warnings = failures.filter((c) => c.level === "warn");
const failed = errors.length > 0 || (STRICT && warnings.length > 0);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { ok: !failed, total: checks.length, errors: errors.length, warnings: warnings.length, checks },
      null,
      2,
    ),
  );
} else {
  const line = (c) => `  ${c.ok ? "✓" : c.level === "error" ? "✗" : "!"} ${c.title}${c.detail ? `\n      ${c.detail}` : ""}`;
  console.log("\nPWA / iOS — auditoría estática\n" + "─".repeat(60));
  for (const c of checks) if (!c.ok) console.log(line(c));
  console.log("─".repeat(60));
  console.log(
    `  ${checks.length - failures.length}/${checks.length} comprobaciones pasan · ` +
      `${errors.length} errores · ${warnings.length} avisos`,
  );
  if (failed) console.log("\n  Los errores bloquean la puerta de validación PWA.\n");
  else console.log("\n  Sin errores bloqueantes.\n");
}

process.exit(failed ? 1 : 0);
