import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { ApiKeysPage } from "./pages/ApiKeys";
import { DealersPage } from "./pages/Dealers";
import { LoginPage } from "./pages/Login";
import { ModelsPage } from "./pages/Models";
import { OffersPage } from "./pages/Offers";
import { SettingsPage } from "./pages/Settings";

// Analítica aparte: se lleva Recharts, que pesa más que el resto de la app
// junta. Quien entra a mirar la tabla de ofertas —que es casi siempre— no
// debería descargar una librería de gráficos para verla.
const AnalyticsPage = lazy(() =>
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
      </Route>
      <Route path="*" element={<Navigate to="/offers" replace />} />
    </Routes>
  );
}
