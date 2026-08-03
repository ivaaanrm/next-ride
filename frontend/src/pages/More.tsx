import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "../components/Layout";
import { noticeCountLabel, useNotices } from "../components/Notifications";
import { Sheet, useAppUpdate } from "../components/ui";
import { useAuth } from "../lib/auth";

/**
 * «Más»: la cola de la navegación.
 *
 * Cuatro pestañas son las que caben abajo con un objetivo táctil honesto, y la
 * app tiene siete rutas más los avisos y la sesión. Todo lo que no entra en la
 * barra vive aquí, en filas de 44 pt agrupadas por para qué se entra: el
 * espacio de trabajo, el sistema, la aplicación y la sesión.
 *
 * También es donde viven las dos cosas que en modo instalado no tiene nadie
 * porque no hay navegador: recargar el documento y saber qué versión se está
 * usando.
 */
export function MorePage() {
  const { user, logout } = useAuth();
  const { count, open: openNotices, isOpen: noticesOpen } = useNotices();
  const update = useAppUpdate();
  const [install, setInstall] = useState(false);

  // Ya instalada no hay nada que instalar. `display-mode: standalone` es lo que
  // contesta iOS desde la pantalla de inicio; en Safari corriente no casa.
  const standalone =
    typeof window !== "undefined" &&
    window.matchMedia?.("(display-mode: standalone)").matches === true;

  const version = import.meta.env.VITE_APP_VERSION ?? "—";

  return (
    <>
      <PageHeader title="Más" />

      <div className="content">
        <div className="more">
          <MoreSection title="Espacio de trabajo">
            <MoreLink to="/dealers" label="Dealers" />
          </MoreSection>

          <MoreSection title="Sistema">
            <MoreButton
              label="Avisos"
              value={count ? noticeCountLabel(count) : "Nada que resolver"}
              onClick={openNotices}
              haspopup
              expanded={noticesOpen}
            />
            <MoreLink to="/settings" label="Ajustes" />
            <MoreLink to="/api-keys" label="API keys" />
          </MoreSection>

          <MoreSection title="Aplicación">
            {/* Lo que en un navegador haría el botón de refresco. Instalada, la
                app no tiene ninguno: sin esta fila, un documento en mal estado
                solo se arregla matando la app. */}
            <MoreButton
              label="Recargar la app"
              value="Vuelve a cargar el documento"
              onClick={() => window.location.reload()}
            />
            {update.available ? (
              <MoreButton
                label="Actualizar a la versión nueva"
                value="Hay una versión esperando"
                tone="accent"
                onClick={update.apply}
              />
            ) : null}
            {standalone ? null : (
              <MoreButton
                label="Instalar en la pantalla de inicio"
                value="Cómo se hace en iPhone"
                onClick={() => setInstall(true)}
                haspopup
                expanded={install}
              />
            )}
            <div className="more-row static">
              <span className="more-label">Versión</span>
              <span className="more-value mono">{version}</span>
            </div>
          </MoreSection>

          <MoreSection title="Sesión">
            <div className="more-row static">
              <span className="more-label">Cuenta</span>
              <span className="more-value">{user?.email}</span>
            </div>
            <button type="button" className="more-row danger" onClick={logout}>
              <span className="more-label">Cerrar sesión</span>
            </button>
          </MoreSection>
        </div>
      </div>

      {install ? <InstallSheet onClose={() => setInstall(false)} /> : null}
    </>
  );
}

function MoreSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="more-section">
      <h2 className="more-section-title">{title}</h2>
      <div className="more-rows">{children}</div>
    </section>
  );
}

function MoreLink({ to, label, value }: { to: string; label: string; value?: string }) {
  return (
    <Link className="more-row" to={to}>
      <span className="more-label">{label}</span>
      {value ? <span className="more-value">{value}</span> : null}
      <span className="more-chevron" aria-hidden="true">
        ›
      </span>
    </Link>
  );
}

function MoreButton({
  label,
  value,
  onClick,
  tone,
  haspopup = false,
  expanded,
}: {
  label: string;
  value?: string;
  onClick: () => void;
  tone?: "accent";
  haspopup?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={`more-row${tone ? ` ${tone}` : ""}`}
      onClick={onClick}
      aria-haspopup={haspopup ? "dialog" : undefined}
      aria-expanded={haspopup ? expanded : undefined}
    >
      <span className="more-label">{label}</span>
      {value ? <span className="more-value">{value}</span> : null}
      <span className="more-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/**
 * Instrucciones, no botón.
 *
 * En iOS no existe `beforeinstallprompt` ni forma programática de instalar: la
 * única ruta es Compartir → Añadir a pantalla de inicio. Un botón que dijera
 * «Instalar» y no instalara nada sería peor que no ofrecer nada.
 */
function InstallSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Instalar en la pantalla de inicio" closeLabel="Cerrar" onClose={onClose}>
      <ol className="install-steps">
        <li>
          En Safari, toca el botón <strong>Compartir</strong> (el cuadrado con la flecha
          hacia arriba, en la barra de abajo).
        </li>
        <li>
          Baja por la lista y elige <strong>Añadir a pantalla de inicio</strong>.
        </li>
        <li>
          Toca <strong>Añadir</strong>. El icono queda junto a las demás apps y se abre sin
          barra de direcciones.
        </li>
      </ol>
      <p className="install-warning">
        La app instalada tiene su propio almacenamiento, así que la primera vez tendrás que
        volver a entrar.
      </p>
      <p className="install-note">
        Solo funciona desde Safari: Chrome y Firefox en iPhone no pueden añadir a la
        pantalla de inicio.
      </p>
    </Sheet>
  );
}
