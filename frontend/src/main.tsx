import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { AuthProvider } from "./lib/auth";
// Antes que `styles.css`: las utilidades de Tailwind solo las usan los gráficos,
// y así el CSS propio de la app sigue teniendo la última palabra.
import "./tailwind.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("No se encontró #root");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
