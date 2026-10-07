import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

import pkg from "./package.json";

export default defineConfig({
  // La versión se enseña en «Más»: instalada, la app no tiene barra de
  // direcciones desde la que averiguar qué está corriendo. Sale del
  // package.json para no tener el número escrito en dos sitios.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  // `cloudflare()` levanta el Worker de `wrangler.jsonc` dentro de workerd, con
  // D1, R2 y el Workflow locales: `pnpm dev` sirve la SPA y la API en el mismo
  // origen, igual que en producción. Ya no hay proxy que configurar.
  //
  // Tailwind está solo por el componente `chart` de shadcn/ui, y sin su
  // `preflight`: ver la cabecera de `src/tailwind.css`.
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    // El alias `@` lo dan por hecho los componentes que instala shadcn.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    // 5173 salvo que el entorno pida otro: así conviven dos servidores de
    // desarrollo sin editar el fichero.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    sourcemap: false,
    /* Sin `manualChunks` para recharts, y es una decisión medida, no un olvido:
     * un módulo asignado a un chunk manual deja de poder eliminarse, y las
     * referencias muertas a recharts que hoy se sacuden solas acababan como
     * `modulepreload` del arranque (entrada de 80 KB a 190 KB). El chunk de
     * Analítica se adelgaza importando menos recharts, no repartiéndolo. */
  },
});
