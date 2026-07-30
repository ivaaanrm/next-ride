import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { OverviewStats } from "../types";
import { Banner, Chip, Drawer, Empty, Loading } from "./ui";

/** Los tonos son los de `Chip`: el aviso y su etiqueta no pueden ir a dos colores. */
type NoticeTone = "warm" | "negative" | "neutral";

interface Notice {
  id: string;
  tone: NoticeTone;
  /** Qué clase de aviso es. Va en la etiqueta, así que se lee antes que el título. */
  kind: string;
  title: string;
  /** La consecuencia: qué deja de funcionar mientras el aviso siga en pie. */
  summary: string;
  /** Cómo se arregla, con el detalle técnico. */
  detail: ReactNode;
  action?: { label: string; to: string };
}

/**
 * Los avisos no se almacenan: se derivan del estado que devuelve el backend.
 *
 * Por eso no hay «marcar como leído». Lo que hay aquí no son eventos que
 * pasaron y se archivan, son condiciones que siguen siendo verdad: se van
 * cuando se arregla la causa. Dejar marcar como leído un aviso que va a volver
 * en la siguiente carga es peor que no dejarlo, así que el panel ofrece
 * «Comprobar» en su lugar.
 *
 * Añadir un aviso es añadir una rama aquí; el contador de la barra y el panel
 * salen los dos de esta lista.
 */
function noticesFrom(stats: OverviewStats | null): Notice[] {
  if (!stats) return [];
  const notices: Notice[] = [];

  if (!stats.ai_enabled) {
    notices.push({
      id: "ai-disabled",
      tone: "warm",
      kind: "Configuración",
      title: "El ranking con IA está desactivado",
      summary:
        "Las ofertas se ordenan solo con la puntuación heurística de valor: la columna «IA» sale vacía y ordenar por «Puntuación IA» no cambia nada.",
      detail: (
        <>
          Define <code>ANTHROPIC_API_KEY</code> en el entorno del backend y reinícialo para
          activarlo.
        </>
      ),
      action: { label: "Ver el estado en Ajustes", to: "/settings" },
    });
  }

  return notices;
}

/**
 * Campana de la barra lateral.
 *
 * Vive en el `Layout` y no en una página porque los avisos son del sistema, no
 * de lo que se esté mirando: antes esto era un `Banner` colgado de la tabla de
 * ofertas, que empujaba la tabla hacia abajo en cada carga y no se veía desde
 * ningún otro sitio.
 */
export function NotificationsNav({ collapsed }: { collapsed: boolean }) {
  const stats = useAsync<OverviewStats>(() => api.get("/stats/overview"), []);
  const [open, setOpen] = useState(false);

  const notices = noticesFrom(stats.data);
  const count = notices.length;

  // El contador va en el nombre accesible: el `span` es decorativo y con la
  // barra plegada no queda etiqueta visible que lo acompañe.
  const label = count
    ? `Notificaciones: ${count} ${count === 1 ? "aviso" : "avisos"}`
    : "Notificaciones";

  return (
    <>
      <button
        type="button"
        className={`nav-item nav-button${open ? " active" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? label : undefined}
        onClick={() => setOpen(true)}
      >
        <span className="nav-icon">
          <BellIcon />
        </span>
        <span className="nav-label">Notificaciones</span>
        {count ? (
          <span className={`nav-badge ${worstTone(notices)}`} aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <NotificationsDrawer
          notices={notices}
          loading={stats.loading}
          error={stats.error}
          onRecheck={stats.reload}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** El contador lo pinta el aviso más grave: con dos, el color no puede promediar. */
function worstTone(notices: Notice[]): NoticeTone {
  if (notices.some((notice) => notice.tone === "negative")) return "negative";
  if (notices.some((notice) => notice.tone === "warm")) return "warm";
  return "neutral";
}

/**
 * Campana dibujada, y no un glifo como el resto de los iconos de la barra.
 *
 * No hay ningún carácter de campana que se pueda dar por soportado: los de la
 * zona de emoji salen a color y rompen la barra, y los monocromos dependen de
 * la fuente de respaldo del sistema. Un recuadro vacío justo al lado del
 * contador es el peor sitio posible para arriesgarse.
 */
function BellIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6.5a4 4 0 0 1 8 0c0 2.2.5 3.4 1.2 4.2.3.4 0 .9-.5.9H3.3c-.5 0-.8-.5-.5-.9C3.5 9.9 4 8.7 4 6.5Z" />
      <path d="M6.4 13.4a1.8 1.8 0 0 0 3.2 0" />
    </svg>
  );
}

/**
 * Los avisos, en el mismo panel lateral que el detalle de una oferta.
 *
 * Cada uno se lee de arriba abajo en el orden de la pregunta: qué clase de
 * aviso es, qué pasa, qué se pierde mientras pase, cómo se arregla y adónde ir
 * a arreglarlo.
 */
function NotificationsDrawer({
  notices,
  loading,
  error,
  onRecheck,
  onClose,
}: {
  notices: Notice[];
  loading: boolean;
  error: string | null;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const subtitle = loading
    ? "Comprobando el estado del sistema…"
    : error
      ? "No se pudo comprobar el estado del sistema"
      : notices.length === 0
        ? "Nada que resolver"
        : `${notices.length} ${notices.length === 1 ? "aviso" : "avisos"} sin resolver`;

  return (
    <Drawer
      title="Notificaciones"
      subtitle={subtitle}
      onClose={onClose}
      actions={
        <button className="btn btn-sm" onClick={onRecheck} disabled={loading}>
          Comprobar
        </button>
      }
    >
      {loading ? (
        <Loading label="Comprobando el estado del sistema…" />
      ) : error ? (
        <Banner kind="error">{error}</Banner>
      ) : notices.length === 0 ? (
        <Empty
          title="Todo en orden"
          hint="Aquí aparecen los avisos del sistema: configuración incompleta, servicios apagados y lo demás que limite lo que la app puede hacer."
        />
      ) : (
        <div className="notice-list">
          {notices.map((notice) => (
            <article key={notice.id} className={`notice ${notice.tone}`}>
              <header className="notice-head">
                <Chip tone={notice.tone}>{notice.kind}</Chip>
                <h3 className="notice-title">{notice.title}</h3>
              </header>

              <p className="notice-summary">{notice.summary}</p>
              <p className="notice-detail">{notice.detail}</p>

              {notice.action ? (
                // Cierra al navegar: el panel tapa media pantalla y el destino
                // del enlace es justo lo que hay que mirar al llegar.
                <Link className="notice-action" to={notice.action.to} onClick={onClose}>
                  {notice.action.label} →
                </Link>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </Drawer>
  );
}
