import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
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
      // En desarrollo (`npm run dev`) se proxea al backend para evitar CORS.
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
    },
  };
});
