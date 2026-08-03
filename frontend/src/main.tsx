import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { registerServiceWorker } from "./components/ui";
import { AuthProvider } from "./lib/auth";
// Antes que `styles.css`: las utilidades de Tailwind solo las usan los gráficos,
// y así el CSS propio de la app sigue teniendo la última palabra.
import "./tailwind.css";
import "./styles.css";

// Solo en producción: en `npm run dev` un worker sirviendo caché rancia es una
// tarde perdida buscando por qué un cambio no aparece.
if (import.meta.env.PROD) registerServiceWorker();

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró #root");

createRoot(container).render(
  <StrictMode>
    {/* Por fuera del router y del proveedor de sesión a propósito: si lo que
        falla es uno de ellos, la red tiene que seguir estando debajo. */}
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
