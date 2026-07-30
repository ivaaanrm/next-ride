import { Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { DealersPage } from "./pages/Dealers";
import { LoginPage } from "./pages/Login";
import { ModelsPage } from "./pages/Models";
import { OffersPage } from "./pages/Offers";
import { SettingsPage } from "./pages/Settings";

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
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/dealers" element={<DealersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/offers" replace />} />
    </Routes>
  );
}
