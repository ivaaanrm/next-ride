import { Suspense, lazy, type ComponentType } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { ApiKeysPage } from "./pages/ApiKeys";
import { DealersPage } from "./pages/Dealers";
import { LoginPage } from "./pages/Login";
import { ModelsPage } from "./pages/Models";
import { MorePage } from "./pages/More";
import { OffersPage } from "./pages/Offers";
import { SettingsPage } from "./pages/Settings";

/**
 * `lazy()` con una recarga de gracia.
 *
 * Un despliegue nuevo borra los chunks con hash del anterior, así que la
 * pestaña que lleva abierta desde antes pide un fichero que ya no existe y el
 * `import()` da 404: la ruta se queda en blanco para siempre. Recargar una vez
 * —y solo una, con la marca en `sessionStorage` para no entrar en bucle si el
 * fallo es otro— trae el `index.html` nuevo con los nombres nuevos.
 */
function lazyWithRetry<T extends ComponentType<Record<string, unknown>>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    const KEY = "nr.chunk_reloaded";
    try {
      const module = await load();
      sessionStorage.removeItem(KEY);
      return module;
    } catch (error) {
      if (sessionStorage.getItem(KEY)) throw error;
      sessionStorage.setItem(KEY, "1");
      window.location.reload();
      // La recarga no es inmediata: se devuelve una promesa que nunca resuelve
      // para que React no pinte un error justo antes de que la página se vaya.
      return new Promise<{ default: T }>(() => {});
    }
  });
}

// Analítica aparte: se lleva Recharts, que pesa más que el resto de la app
// junta. Quien entra a mirar la tabla de ofertas —que es casi siempre— no
// debería descargar una librería de gráficos para verla.
const AnalyticsPage = lazyWithRetry(() =>
  import("./pages/Analytics").then((module) => ({ default: module.AnalyticsPage })),
);

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-shell">
        <Loading label="Restaurando sesión…" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/offers" element={<OffersPage />} />
        <Route
          path="/analytics"
          element={
            <Suspense fallback={<Loading label="Cargando la analítica…" />}>
              <AnalyticsPage />
            </Suspense>
          }
        />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/dealers" element={<DealersPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* La cola de la navegación, que en un móvil no cabe en la barra de
            pestañas. En escritorio la ruta existe igual, pero la barra lateral
            llega a todo y nadie tiene por qué pasar por aquí. */}
        <Route path="/more" element={<MorePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/offers" replace />} />
    </Routes>
  );
}
