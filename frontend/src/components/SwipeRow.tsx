import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fila que se desliza a la izquierda para enseñar sus acciones.
 *
 * **Es scroll nativo, no un arrastre en JavaScript**: un contenedor con
 * `scroll-snap-type: x mandatory` y dos puntos de anclaje —el contenido y el
 * bloque de botones—. Lo que se gana con eso no es código más corto, es
 * comportamiento que no se puede imitar: el bloqueo de eje (empezar a bajar la
 * lista y que el gesto no se convierta a mitad en un deslizamiento lateral), la
 * inercia, el rebote y la velocidad de escape los pone iOS, medidos contra el
 * resto del sistema. Un `pointermove` que traduce dedos a `translateX` acierta el
 * primer 80 % y falla justo en el gesto rápido, que es el que se hace cuando ya
 * se conoce la lista.
 *
 * **Solo hacia la izquierda.** Un gesto que empieza en el borde izquierdo es el
 * gesto de «atrás» del sistema en las configuraciones que lo honran, y desde una
 * app instalada no se puede desactivar: competir con él sería perder.
 *
 * **Sin confirmación por deslizamiento completo.** Las dos acciones afirman
 * cosas distintas —«descartada» la firma quien mira, «no disponible» la firma el
 * anuncio— y un rebase de inercia no puede archivar una oferta en el estado
 * equivocado. Se desliza para ver y se toca para confirmar.
 *
 * Los botones son `<button>` de verdad y están siempre en el árbol, sin
 * `opacity: 0` ni `:hover` de por medio: VoiceOver y el tabulador llegan a ellos
 * sin hacer ningún gesto.
 */
export function SwipeRow({
  actions,
  children,
  peek = false,
  onPeekEnd,
  onOpen,
  label,
}: {
  /** Los botones que quedan a la vista al deslizar. */
  actions: ReactNode;
  children: ReactNode;
  /** Enseña el gesto abriendo la fila 56 px y devolviéndola. Solo la primera
   *  fila, y solo la primera vez que se dibuja la lista. */
  peek?: boolean;
  onPeekEnd?: () => void;
  /** Se avisa la primera vez que esta fila se abre: es lo que descarta la pista
   *  escrita para quien no quiere movimiento. */
  onOpen?: () => void;
  /** Nombre del grupo de acciones, para quien navega a ciegas. */
  label: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const announced = useRef(false);

  useEffect(() => {
    if (!peek) return;
    const el = rail.current;
    if (!el) return;

    // El anclaje se suelta durante la demostración: con `mandatory` puesto, un
    // desplazamiento a 56 px —que no es ninguno de los dos anclajes— lo corrige
    // el navegador en el acto y la pista no se llega a ver.
    el.dataset.peek = "1";
    el.scrollTo({ left: PEEK_PX, behavior: "smooth" });

    const back = setTimeout(() => {
      el.scrollTo({ left: 0, behavior: "smooth" });
      // Se devuelve el anclaje cuando la vuelta ya ha terminado, no al lanzarla.
      setTimeout(() => {
        delete el.dataset.peek;
      }, 400);
      onPeekEnd?.();
    }, PEEK_MS);

    return () => clearTimeout(back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek]);

  return (
    <div
      ref={rail}
      className="swipe"
      onScroll={(event) => {
        if (announced.current) return;
        if (event.currentTarget.scrollLeft > OPEN_PX) {
          announced.current = true;
          onOpen?.();
        }
      }}
    >
      <div
        className="swipe-pane"
        onClickCapture={(event) => {
          // Con la fila abierta, el primer toque sobre el contenido la cierra.
          // Sin esto, tocar «para cerrar» abriría el detalle de la oferta que se
          // estaba a punto de descartar, que es el peor destino posible.
          const el = rail.current;
          if (el && el.scrollLeft > OPEN_PX) {
            event.preventDefault();
            event.stopPropagation();
            el.scrollTo({ left: 0, behavior: scrollBehavior() });
          }
        }}
      >
        {children}
      </div>
      <div className="swipe-actions" role="group" aria-label={label}>
        {actions}
      </div>
    </div>
  );
}

/** Lo que se abre la fila al enseñar el gesto: se ve el borde de los botones,
 *  no el botón entero, que sería enseñar la acción en vez del gesto. */
const PEEK_PX = 56;
const PEEK_MS = 600;
/** Por encima de esto la fila cuenta como abierta. Ocho píxeles absorben el
 *  temblor de un dedo apoyado sin llegar a arrastrar. */
const OPEN_PX = 8;

/* -------------------------------------------------------------------------- *
 * Descubrimiento
 * -------------------------------------------------------------------------- */

const HINT_KEY = "nr.swipe_hint_seen";

export interface SwipeHint {
  /** La primera fila hace la demostración. */
  peek: boolean;
  /** Alternativa escrita para quien ha pedido menos movimiento. */
  line: boolean;
  seen: () => void;
}

/**
 * Un gesto que no se anuncia no existe.
 *
 * La primera vez que la lista se dibuja, la primera fila se abre 56 px y vuelve.
 * Con `prefers-reduced-motion` no hay animación —una fila que se mueve sola es
 * exactamente lo que esa preferencia pide evitar—: en su lugar sale una línea
 * bajo el riel, y se descarta con el primer deslizamiento, que es la señal de
 * que ya no hace falta.
 */
export function useSwipeHint(ready: boolean): SwipeHint {
  const reduced = usePrefersReducedMotion();
  const [pending, setPending] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === null;
    } catch {
      return false;
    }
  });

  const seen = () => {
    setPending(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* sin almacenamiento la pista se repetirá, que es el fallo benigno */
    }
  };

  return {
    peek: pending && ready && !reduced,
    line: pending && ready && reduced,
    seen,
  };
}

/* -------------------------------------------------------------------------- *
 * Consultas de medios
 *
 * En React y no en CSS porque lo que cambia entre el móvil y el escritorio en
 * esta pantalla no es el aspecto de un componente: es **qué componente**. Una
 * tabla de catorce columnas escondida con `display: none` sigue montando 261
 * filas y sus catorce celdas, y sigue estando en el árbol de accesibilidad de
 * una pantalla de 390 px.
 * -------------------------------------------------------------------------- */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** El mismo umbral con el que desaparece la barra lateral: un solo punto de
 *  corte en toda la app. */
export const TOUCH_QUERY = "(max-width: 860px)";

export const useTouchLayout = () => useMediaQuery(TOUCH_QUERY);

export const usePrefersReducedMotion = () =>
  useMediaQuery("(prefers-reduced-motion: reduce)");

/**
 * `smooth`, salvo que se haya pedido menos movimiento.
 *
 * El bloque de `prefers-reduced-motion` de la hoja no llega hasta aquí:
 * `scrollTo` no pasa por CSS. Se consulta en el momento de la llamada y no con
 * un hook porque quien lo necesita son manejadores sueltos, no renders.
 */
export function scrollBehavior(): ScrollBehavior {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}
