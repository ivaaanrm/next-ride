import type { ReactNode } from "react";

import { OFFER_STATUS } from "../lib/format";
import type { Offer, OfferStatus } from "../types";

/**
 * Las salidas de una oferta y la vuelta, en un solo control.
 *
 * Son **dos** salidas y no una porque no son grados de lo mismo: «descartada» la
 * firma quien mira —no me interesa, y el scraper la respeta aunque el anuncio
 * siga vivo— y «no disponible» la firma el anuncio —ya no está, y el scraper
 * puede revivirla si vuelve a encontrarlo—. Elegir entre las dos es justo el
 * trabajo que se está haciendo al recorrer la lista, así que las dos están a un
 * clic: esconder una detrás de un menú la cobraría a dos y la haría desaparecer.
 *
 * Cada fila enseña los dos estados que **no** son el suyo, así que desde
 * cualquiera de las tres vistas se llega a las otras dos sin abrir nada.
 *
 * No hay confirmación. La hace innecesaria el aviso de deshacer que sale abajo:
 * los tres movimientos son reversibles y ninguno borra nada.
 */
export function OfferActions({
  offer,
  busy = false,
  variant = "row",
  onMove,
}: {
  offer: Offer;
  busy?: boolean;
  /** `row` son dos iconos que aparecen al pasar por encima; `wide`, dos botones
   *  con su nombre escrito, para la cabecera del panel de detalle, donde hay
   *  sitio y donde quien acaba de leer la ficha no viene de recorrer la tabla. */
  variant?: "row" | "wide";
  onMove: (offer: Offer, target: OfferStatus) => void;
}) {
  const targets = TARGETS[offer.status];

  if (variant === "wide") {
    return (
      <>
        {targets.map((target) => (
          <button
            key={target}
            type="button"
            className={`btn btn-sm${target === "dismissed" ? " btn-danger" : ""}`}
            disabled={busy}
            title={OFFER_STATUS[target].hint}
            onClick={() => onMove(offer, target)}
          >
            <StatusIcon target={target} />
            {OFFER_STATUS[target].verb}
          </button>
        ))}
      </>
    );
  }

  return (
    <div className="row-actions">
      {targets.map((target) => (
        <button
          key={target}
          type="button"
          className={`icon-btn${target === "dismissed" ? " danger" : ""}`}
          disabled={busy}
          // El `title` lleva la consecuencia entera y no solo el verbo: es lo
          // único que separa «descartar» de «no disponible» antes de pulsar, y
          // dos iconos sin explicación serían dos formas de tirar una fila.
          title={`${OFFER_STATUS[target].verb} — ${OFFER_STATUS[target].hint}`}
          aria-label={OFFER_STATUS[target].verb}
          onClick={(event) => {
            // La fila entera abre el detalle: sus controles no deben propagar.
            event.stopPropagation();
            onMove(offer, target);
          }}
        >
          <StatusIcon target={target} />
        </button>
      ))}
    </div>
  );
}

/** Los dos estados a los que puede ir una oferta, que son los que no es. */
const TARGETS: Record<OfferStatus, OfferStatus[]> = {
  active: ["dismissed", "expired"],
  dismissed: ["active", "expired"],
  expired: ["active", "dismissed"],
};

/* -------------------------------------------------------------------------- *
 * Iconos
 *
 * Dibujados y no glifos de texto: los caracteres que valdrían —⊘, 🗑— o salen a
 * color desde la fuente de emoji del sistema o dependen de una fuente de
 * respaldo, y un recuadro vacío en un botón que retira una fila es el peor sitio
 * posible para arriesgarse.
 *
 * Las siluetas son deliberadamente de familias distintas —caja, círculo,
 * flecha—, no tres variaciones del mismo trazo: a 14 px lo que se distingue es
 * la forma general, y dos iconos parecidos en botones contiguos que hacen cosas
 * distintas son peor que ninguno.
 * -------------------------------------------------------------------------- */

function StatusIcon({ target }: { target: OfferStatus }) {
  if (target === "active") return <RestoreIcon />;
  if (target === "dismissed") return <ArchiveIcon />;
  return <UnavailableIcon />;
}

/** Caja de archivo: sale de mi lista, pero no se destruye. */
function ArchiveIcon() {
  return (
    <Glyph>
      <rect x="2.3" y="3" width="11.4" height="2.9" rx="0.8" />
      <path d="M3.5 5.9v5.9a1.2 1.2 0 0 0 1.2 1.2h6.6a1.2 1.2 0 0 0 1.2-1.2V5.9" />
      <path d="M6.5 8.4h3" />
    </Glyph>
  );
}

/** Círculo tachado: la señal de «esto ya no está», sobre el anuncio y no sobre mí. */
function UnavailableIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M4.2 11.8 11.8 4.2" />
    </Glyph>
  );
}

/** Flecha que da la vuelta: el mismo gesto que el «Deshacer» de los avisos. */
function RestoreIcon() {
  return (
    <Glyph>
      <path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.9L2 5.4" />
      <path d="M2 2v3.4h3.4" />
    </Glyph>
  );
}

/** El marco común: mismo lienzo, mismo grosor y mismo remate en los tres. */
function Glyph({ children }: { children: ReactNode }) {
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
      {children}
    </svg>
  );
}
