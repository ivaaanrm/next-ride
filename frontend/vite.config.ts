import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";

import pkg from "./package.json";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    // La versión se enseña en «Más»: instalada, la app no tiene barra de
    // direcciones desde la que averiguar qué está corriendo. Sale del
    // package.json para no tener el número escrito en dos sitios.
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    },
    // Tailwind está solo por el componente `chart` de shadcn/ui, y sin su
    // `preflight`: ver la cabecera de `src/tailwind.css`.
    plugins: [react(), tailwindcss()],
    resolve: {
      // El alias `@` lo dan por hecho los componentes que instala shadcn.
      alias: { "@": path.resolve(__dirname, "src") },
    },
    server: {
      // 5173 salvo que el entorno pida otro: así conviven dos servidores de
      // desarrollo sin editar el fichero.
      port: Number(process.env.PORT) || 5173,
      // En desarrollo (`pnpm dev`) se proxea al backend para evitar CORS.
      proxy: {
        "/api": {
          target: env.VITE_API_TARGET ?? "http://localhost:8000",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      /* Sin `manualChunks` para recharts, y esto es una decisión medida, no un
       * olvido: el blueprint lo pedía y al implementarlo resultó ser peor.
       *
       * Un módulo asignado a un chunk manual deja de poder eliminarse, así que
       * las referencias muertas a recharts que hoy se sacuden solas se
       * materializan en una arista real desde el chunk de entrada. Medido, con
       * el import de `components/charts` ya fuera de Offers (que es lo que hará
       * el paquete de la pantalla de ofertas):
       *
       *   sin manualChunks → entrada 80,0 KB · Analytics diferido 125,9 KB
       *   con manualChunks → entrada 190,3 KB, porque `charts` (154 KB) entra
       *                      como `modulepreload` del arranque
       *
       * Es decir, aislar la librería la devuelve al arranque: exactamente lo
       * contrario de lo que se buscaba. Queda pendiente que el chunk diferido
       * baje de 125,9 a los 120 KB del presupuesto, y eso se hace importando
       * menos recharts, no repartiéndolo. */
    },
  };
});
