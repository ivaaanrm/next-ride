/* ------------------------------------------------------------------------- *
 * Service worker de next-ride.
 *
 * JavaScript plano, servido tal cual desde `public/`: sin bundling, sin
 * `vite-plugin-pwa`, sin dependencia nueva y sin tocar el lockfile que usa
 * `pnpm install --frozen-lockfile`. Lo que da esto es que la app **arranca sin
 * red** —el shell, la
 * navegación y el estado «Sin conexión»— en vez de la página de error de
 * Safari. Datos frescos no da ninguno, y en un producto cuyo valor son los
 * precios de hoy eso es lo correcto.
 *
 * Qué se cachea, y nada más que esto:
 *
 *   /assets/*-[hash].js|css   cache-first          nr-assets-v1
 *   /manifest.json, /icons/*  cache-first, precargados en `install`
 *   navegaciones              network-first con index.html de respaldo
 *   todo lo demás             pasa de largo, sin tocar la caché
 *
 * Lo que **nunca** se cachea, y es una regla y no un olvido:
 *
 *   · Cualquier cosa bajo /api/. Por la URL no se puede distinguir el catálogo
 *     compartido de lo que está acotado al JWT de quien pregunta, ninguna
 *     respuesta trae Cache-Control ni Vary, y GET /api-keys devuelve el
 *     inventario de secretos. Una caché por identidad, borrada en cada logout y
 *     en cada 401, es la forma correcta de hacerlo y es un paquete entero de
 *     trabajo; hasta que exista, la política es cero.
 *   · Orígenes cruzados (las fotos de los dealers). Son respuestas opacas: no
 *     se puede saber si fueron bien, no hay tope de número y en iOS la cuota se
 *     paga cara. El respaldo de imagen rota ya existe en la app.
 *   · Nada se encola para reintentar sin red: ninguna mutación lleva clave de
 *     idempotencia, así que sin conexión la app es de solo lectura y una acción
 *     falla a la vista, en el acto, en vez de fingir que ha funcionado.
 *
 * Actualización: `skipWaiting()` **solo** cuando la página lo pide con
 * `{type: "skip-waiting"}`. Automático, cambiaría los assets con hash bajo una
 * SPA ya cargada y el siguiente `import()` diferido daría 404.
 * ------------------------------------------------------------------------- */

const VERSION = "v1";
const SHELL_CACHE = `nr-shell-${VERSION}`;
const ASSET_CACHE = `nr-assets-${VERSION}`;
const OWN_CACHES = [SHELL_CACHE, ASSET_CACHE];

/** El mínimo para pintar la app sin red. Nada de rutas: la SPA las resuelve. */
const SHELL_URLS = [
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.v1.png",
  "/icons/icon-512.v1.png",
  "/icons/maskable-512.v1.png",
  "/icons/apple-touch-icon-180.v1.png",
];

/**
 * Prefijos que el worker no toca jamás. Los tres primeros los proxea nginx al
 * backend y ninguno es ruta de la SPA; `/api/v1/openapi.json` cae dentro de
 * `/api/` y se nombra aparte solo para que quede escrito.
 */
const NEVER_CACHE = ["/api/", "/api/v1/openapi.json", "/docs", "/health"];

const isNeverCached = (pathname) =>
  NEVER_CACHE.some((prefix) => pathname === prefix || pathname.startsWith(prefix));

/** Assets con hash en el nombre: inmutables por construcción. */
const isHashedAsset = (pathname) =>
  pathname.startsWith("/assets/") && (pathname.endsWith(".js") || pathname.endsWith(".css"));

const isShellAsset = (pathname) =>
  pathname === "/manifest.json" || pathname.startsWith("/icons/");

self.addEventListener("install", (event) => {
  // Sin `skipWaiting()`: el relevo lo decide la página.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("nr-") && !OWN_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      // Toma el control de las pestañas ya abiertas: sin esto, la primera visita
      // se queda sin worker hasta la siguiente recarga y no arrancaría sin red.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  // La única puerta a `skipWaiting`. La página la abre desde «Más» o desde el
  // aviso de versión nueva, y recarga en `controllerchange`.
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Primero de todo, antes de mirar ninguna caché: el backend y los orígenes
  // cruzados salen por donde han entrado.
  if (isNeverCached(url.pathname)) return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (isShellAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }

  // Lo que no esté en la lista no se cachea: la petición sigue su camino.
});

/**
 * Navegación: siempre se intenta la red, porque el `index.html` nombra los
 * assets con hash y servirlo rancio apunta a ficheros que ya no existen. Sin
 * red, el shell cacheado; la app arranca y enseña su estado «Sin conexión».
 */
async function networkFirstDocument(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // `cache: "no-cache"` fuerza la revalidación con el servidor en vez de
    // aceptar lo que haya en la caché HTTP del navegador. No es redundante con
    // el `Cache-Control: no-cache` de nginx: una entrada guardada *antes* de
    // que existiera esa cabecera conserva su frescura heurística, y sin esto el
    // worker la leería, la volvería a guardar y el documento viejo se quedaría
    // dando vueltas indefinidamente. Se ha visto pasar.
    const response = await fetch(request, { cache: "no-cache" });
    // Se guarda bajo una clave canónica: cualquier ruta de la SPA devuelve el
    // mismo documento, y guardarlas todas llenaría la caché de duplicados.
    //
    // Pero **solo si lo que ha vuelto es el shell**. Una navegación de primer
    // nivel a cualquier recurso del propio origen que no sea HTML —abrir
    // `/manifest.json` desde un enlace profundo, por ejemplo— también es
    // `mode: "navigate"`, también devuelve 200, y sin esta guarda se guardaba
    // bajo `/index.html`: a partir de ahí el arranque sin red servía ese JSON
    // como si fuera la app. En standalone eso no tiene salida, porque no hay
    // barra de direcciones ni botón de recarga con los que escapar.
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && !response.redirected && type.includes("text/html")) {
      await cache.put("/index.html", response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match("/index.html");
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // `basic` deja fuera lo opaco y lo redirigido: solo entra lo que se puede leer.
  if (response.ok && response.type === "basic") await cache.put(request, response.clone());
  return response;
}
