import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { scoreTone } from "../lib/format";

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const tone = scoreTone(value);
  return (
    // El `title` se queda para el puntero, pero la unidad va también en texto:
    // en un móvil no hay dónde consultar un `title`, y dentro de la fila —que es
    // un botón nombrado por su contenido— un número suelto no dice de qué es.
    <span className={`score ${tone}`} title={`Puntuación ${value}/100`}>
      <span className="score-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      {Math.round(value)}
      <span className="sr-only"> de puntuación sobre 100</span>
    </span>
  );
}

export function Banner({
  kind = "info",
  children,
}: {
  kind?: "info" | "error" | "warn";
  children: ReactNode;
}) {
  // Un aviso que solo se dibuja no existe para quien no mira: el error de login
  // era un bloque rojo y silencio absoluto. `alert` interrumpe —que es lo que
  // toca cuando algo ha fallado—; lo informativo se anuncia sin cortar.
  return (
    <div className={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div className="tiny">{hint}</div> : null}
    </div>
  );
}

export function Loading({ label = "Cargando…" }: { label?: string }) {
  // «Cargando…» dibujado y no anunciado deja la pantalla en un silencio que no se
  // distingue de una app colgada. El giro es decorativo y se oculta.
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

/** Interruptor de ámbito: un botón con estado, no una casilla nativa. */
export function Toggle({
  on,
  onChange,
  title,
  children,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="btn toggle"
      aria-pressed={on}
      title={title}
      onClick={() => onChange(!on)}
    >
      {children}
    </button>
  );
}

/**
 * Panel anclado al botón que lo abre.
 *
 * No es un modal y no debe serlo: un filtro se ajusta mirando la tabla que hay
 * debajo, así que esto no atrapa el foco ni tapa la pantalla. El botón enseña el
 * estado actual del filtro, de modo que plegado sigue diciendo lo que hay puesto.
 */
export function Popover({
  label,
  active = false,
  disabled = false,
  title,
  children,
}: {
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: Event) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Cerrar con Escape devuelve el foco al botón: si no, se queda en un nodo
      // que acaba de desaparecer y el tabulador vuelve al principio de la página.
      trigger.current?.focus();
    }

    // `pointerdown` y no `mousedown`: iOS solo sintetiza eventos de ratón sobre
    // elementos que ya son «clicables» —enlaces, botones, cualquier cosa con
    // `onclick`—, y `document` no lo es. Con `mousedown`, tocar fuera del panel
    // en un iPhone no lo cerraba y se quedaba tapando la tabla.
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="popover-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={`btn popover-trigger${active ? " on" : ""}`}
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span className="popover-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && !disabled ? <div className="popover">{children}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Avisos con vuelta atrás
 *
 * Son el reemplazo de `confirm()`, no un adorno encima. Un `confirm()` cobra un
 * diálogo modal por fila —y el ratón hasta el botón, y la vista entera
 * bloqueada— para cubrir el caso raro de haber pulsado mal; esto invierte el
 * trato: la acción ocurre ya y la vuelta atrás queda a mano unos segundos, que
 * es lo mismo que ofrecía el «Cancelar» pero cobrándoselo solo a quien falla.
 *
 * Solo vale porque las acciones que lo usan son reversibles de verdad. Para algo
 * que no lo sea, esto no sirve y hace falta preguntar antes.
 * -------------------------------------------------------------------------- */

let nextToastId = 0;

const TOAST_TTL = 7000;
/** Tres a la vez y se cae el más viejo: apilar diez avisa de lo que ya no importa. */
const TOAST_MAX = 3;

export interface ToastSpec {
  message: ReactNode;
  /** Sin esto el aviso es solo un acuse de recibo, que casi nunca hace falta. */
  undo?: () => void | Promise<void>;
  undoLabel?: string;
  ttl?: number;
}

export interface ToastItem extends ToastSpec {
  id: number;
}

export interface Toasts {
  items: ToastItem[];
  push: (spec: ToastSpec) => void;
  dismiss: (id: number) => void;
}

export function useToasts(): Toasts {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (spec: ToastSpec) => {
      const id = ++nextToastId;
      setItems((previous) => [...previous, { ...spec, id }].slice(-TOAST_MAX));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), spec.ttl ?? TOAST_TTL),
      );
    },
    [dismiss],
  );

  // Salir de la página con avisos en vuelo no debe dejar temporizadores sueltos
  // llamando a `setItems` sobre un componente que ya no está.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return { items, push, dismiss };
}

/**
 * La pila de avisos, en un portal como el panel lateral y por el mismo motivo:
 * tiene que dibujarse por encima de él, y desde dentro del panel también se
 * descarta.
 *
 * `aria-live="polite"` y no `assertive`: la acción ya ha ocurrido, así que se
 * anuncia sin interrumpir. El foco tampoco se mueve —quien está recorriendo la
 * tabla sigue en su fila—, y por eso «Deshacer» es un botón de verdad: se
 * alcanza con el tabulador cuando hace falta, en vez de solo con el ratón.
 */
export function ToastStack({ items, dismiss }: Toasts) {
  // El contenedor se monta siempre, aunque esté vacío. Crear la región viva **a
  // la vez** que su contenido es el patrón que VoiceOver se salta: no había
  // nada que observar cuando apareció el texto. Vacío no ocupa ni intercepta
  // —`pointer-events: none` en la caja, `auto` en cada aviso—, así que el único
  // cambio es que la región ya existe cuando llega el mensaje.
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <div className="toast" key={toast.id}>
          <span className="toast-text">{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                // Se cierra antes de correr: si la vuelta atrás falla, el error
                // sale por su sitio y no bajo un aviso que dice lo contrario.
                dismiss(toast.id);
                void toast.undo?.();
              }}
            >
              {toast.undoLabel ?? "Deshacer"}
            </button>
          ) : null}
          <button
            type="button"
            className="toast-close"
            aria-label="Cerrar el aviso"
            onClick={() => dismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

type Thumb = "lo" | "hi";

/**
 * Deslizador de rango con dos pomos.
 *
 * El puntero lo lleva este componente sobre el carril y los dos
 * `input[type=range]` viven fuera de la vista (`.sr-only`), solo para teclado y
 * lectores de pantalla. Es al revés de lo habitual, y a propósito: la técnica
 * corriente —superponer dos ranges nativos y dejar pasar el puntero solo por los
 * pomos— depende de `pointer-events` sobre `::-moz-range-thumb`, que Firefox no
 * aplica, así que allí el pomo de encima taparía al de debajo en todo el carril.
 *
 * De paso sale mejor interacción: el carril entero agarra, se pulsa donde sea y
 * se mueve el pomo más cercano, en vez de tener que acertar en un círculo de 14 px.
 */
export function RangeSlider({
  min,
  max,
  step,
  value,
  onChange,
  format,
  labelMin = "Mínimo",
  labelMax = "Máximo",
}: {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  /** Cómo se anuncia el valor a un lector de pantalla («12.000 €», no «12000»). */
  format: (value: number) => string;
  labelMin?: string;
  labelMax?: string;
}) {
  const [dragging, setDragging] = useState<Thumb | null>(null);
  const rail = useRef<HTMLDivElement>(null);

  const span = max - min || 1;
  // Se acota aquí y no en quien llama: al cambiar de modelo el dominio se
  // encoge y los valores puestos pueden quedarse fuera. Un pomo dibujado fuera
  // del carril es peor que un pomo pegado al extremo.
  const lo = clamp(value[0], min, max);
  const hi = clamp(value[1], min, max);
  const pct = (target: number) => `${((clamp(target, min, max) - min) / span) * 100}%`;

  /** Valor del carril bajo el puntero, ya redondeado al paso. */
  function valueAt(clientX: number): number {
    const box = rail.current?.getBoundingClientRect();
    if (!box?.width) return lo;
    const fraction = clamp((clientX - box.left) / box.width, 0, 1);
    return clamp(Math.round((min + fraction * span) / step) * step, min, max);
  }

  /** Mueve un pomo sin dejar que cruce al otro. */
  function move(thumb: Thumb, target: number) {
    if (thumb === "lo") onChange([Math.min(target, hi - step), hi]);
    else onChange([lo, Math.max(target, lo + step)]);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const target = valueAt(event.clientX);
    // Los `<=`/`>=` resuelven el caso de los dos pomos juntos en un extremo:
    // ahí solo uno de los dos puede moverse, y es el que hay que agarrar.
    const thumb: Thumb =
      target <= lo ? "lo" : target >= hi ? "hi" : target - lo <= hi - target ? "lo" : "hi";
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(thumb);
    move(thumb, target);
  }

  return (
    <div
      className="range"
      data-dragging={dragging ?? undefined}
      style={{ "--lo": pct(lo), "--hi": pct(hi) } as CSSProperties}
    >
      <input
        className="range-key lo sr-only"
        type="range"
        min={min}
        max={max}
        step={step}
        value={lo}
        aria-label={labelMin}
        aria-valuetext={format(lo)}
        onChange={(event) => move("lo", Number(event.target.value))}
      />
      <input
        className="range-key hi sr-only"
        type="range"
        min={min}
        max={max}
        step={step}
        value={hi}
        aria-label={labelMax}
        aria-valuetext={format(hi)}
        onChange={(event) => move("hi", Number(event.target.value))}
      />
      <div
        ref={rail}
        className="range-rail"
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (dragging) move(dragging, valueAt(event.clientX));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        <span className="range-fill" />
        <span className="range-thumb lo" />
        <span className="range-thumb hi" />
      </div>
    </div>
  );
}

/**
 * Panel lateral, montado en `document.body` mediante un portal.
 *
 * El portal no es opcional: el panel tapa la pantalla entera, así que su
 * `z-index` tiene que valer contra la barra superior y la cabecera fija de la
 * tabla, y eso solo pasa si comparte contexto de apilado con ellas. Renderizado
 * en su sitio del árbol, quien lo abre decide si se ve: desde la tabla colaba
 * por casualidad —`.main` no crea contexto—, pero desde la barra lateral, que
 * es `position: sticky` y por tanto sí lo crea, el panel quedaba encerrado en
 * un contexto de `z-index: auto` y se dibujaba **por debajo** de la barra
 * superior y de la cabecera de la tabla. Con el portal, el panel se comporta
 * igual desde donde sea que se abra.
 */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  actions,
  wide = false,
  over = false,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /** Para paneles con contenido a dos columnas. */
  wide?: boolean;
  /** Un panel que se abre **desde** otro (el editor desde la ficha).
   *
   * Sin esto, el velo del segundo se dibuja por debajo del primero —los dos
   * viven en el mismo escalón, 20/21— y el panel de detrás se quedaba a plena
   * luz, sin atenuar y con sus controles pidiendo un clic que ya no le toca. */
  over?: boolean;
}) {
  const close = useModalSurface(onClose);

  return createPortal(
    <>
      <div className={`drawer-backdrop${over ? " over" : ""}`} onClick={onClose} />
      <aside
        className={`drawer${wide ? " wide" : ""}${over ? " over" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* El cierre va primero en el árbol y en el orden de tabulación: es la
            salida, y por debajo de 860px también es lo primero de la cabecera.
            En escritorio `order` lo devuelve a su sitio de siempre, a la
            derecha, sin mover el resto. */}
        <header className="drawer-header">
          <button
            ref={close}
            className="btn btn-ghost btn-sm drawer-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            ✕
          </button>
          <div className="drawer-heading">
            <h2>{title}</h2>
            {subtitle ? <div className="drawer-subtitle tiny muted">{subtitle}</div> : null}
          </div>
          <div className="spacer" />
          {/* Envueltas y no sueltas en la cabecera: en un móvil los botones
              bajan a su propia línea, a mitades, y el titular recupera el ancho
              entero. Sueltos, cada uno envolvía por su cuenta y el título se
              quedaba en una columna de 100 px partida en seis renglones. */}
          {actions ? <div className="drawer-actions">{actions}</div> : null}
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- *
 * Hoja inferior
 *
 * El control del que se vuelve en segundos: filtros, orden, un menú. Ancho
 * completo, alto según contenido hasta `--sheet-max-height`, y **el pie va en el
 * flujo de la hoja, nunca fijo**: con el teclado abierto, en iOS el viewport de
 * maquetación no encoge y un pie `position: fixed` se despega de la hoja y se
 * queda flotando sobre el teclado.
 *
 * Tres salidas, y ninguna es un gesto: el botón de la cabecera, el toque en el
 * velo y `Escape`. El arrastre hacia abajo se puede añadir encima, pero no
 * puede ser la única.
 * -------------------------------------------------------------------------- */
export function Sheet({
  title,
  onClose,
  closeLabel = "Cancelar",
  action,
  footer,
  children,
  over = false,
}: {
  title: string;
  onClose: () => void;
  /** «Cancelar» por defecto; «Cerrar» cuando la hoja no aplica nada. */
  closeLabel?: string;
  /** Acción secundaria a la derecha de la cabecera («Limpiar»). */
  action?: ReactNode;
  /** Pie en flujo: la acción principal de la hoja. */
  footer?: ReactNode;
  children: ReactNode;
  /** La hoja se abre **sobre** una ficha ya abierta: sube un escalón para que su
   *  velo tape la ficha en vez de quedarse debajo. Mismo motivo que en `Drawer`. */
  over?: boolean;
}) {
  const close = useModalSurface(onClose);

  return createPortal(
    <>
      <div className={`sheet-backdrop${over ? " over" : ""}`} onClick={onClose} />
      <div
        className={`sheet${over ? " over" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <span className="sheet-grip" aria-hidden="true" />
        <header className="sheet-header">
          <button ref={close} type="button" className="sheet-close" onClick={onClose}>
            {closeLabel}
          </button>
          <h2 className="sheet-title">{title}</h2>
          <div className="sheet-action">{action}</div>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-footer">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}

/**
 * Lo que comparten el panel y la hoja: `Escape` cierra, el fondo no hace
 * scroll mientras están abiertos, el foco entra al botón de cierre y vuelve a
 * quien abrió al cerrarse.
 *
 * El foco de vuelta importa más en un móvil de lo que parece: sin él, cerrar
 * una hoja deja el foco en `body` y el siguiente barrido de VoiceOver empieza
 * otra vez por la cabecera de la página.
 */
function useModalSurface(onClose: () => void) {
  const close = useRef<HTMLButtonElement>(null);
  // `onClose` casi siempre llega como flecha en línea, así que cambia de
  // identidad en cada render de quien abre. Si fuera dependencia del efecto,
  // cada render desmontaría y remontaría el cerrojo de scroll y devolvería el
  // foco al botón de cerrar: escribir en un campo de dentro sería imposible.
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    // El cerrojo de scroll es solo de la capa táctil, donde la superficie tapa
    // la pantalla entera y el fondo que se mueve detrás es puro ruido. En
    // escritorio el panel ocupa media ventana y la página sigue detrás como
    // siempre: bloquearla ahí cambiaría el escritorio y, con barras de scroll
    // clásicas, desplazaría la página al abrir.
    const touch = window.matchMedia("(max-width: 860px)").matches;
    if (touch) root.style.overflow = "hidden";
    close.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") latest.current();
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (touch) root.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, []);

  return close;
}

/**
 * Sin conexión.
 *
 * Es un estado aparte del error por una razón que hoy es un fallo bloqueante:
 * una red caída y una sesión caducada renderizan la misma pantalla de login, y
 * quien lo sufre no sabe cuál de las dos le ha pasado ni si reintentar sirve de
 * algo. Aquí se dice las dos cosas: que es la red, y que la sesión sigue en pie.
 */
export function OfflineNotice({
  onRetry,
  retrying = false,
  detail,
}: {
  onRetry: () => void;
  retrying?: boolean;
  /** Qué se estaba pidiendo, cuando ayuda a situarlo. */
  detail?: ReactNode;
}) {
  return (
    <div className="offline-notice" role="status">
      <div className="offline-title">Sin conexión</div>
      <p className="offline-body">
        {detail ?? "No se ha podido contactar con el servidor. La sesión sigue abierta."}
      </p>
      <button type="button" className="btn" onClick={onRetry} disabled={retrying}>
        {retrying ? <span className="spinner" /> : null}
        Reintentar
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Service worker: registro y relevo de versión
 *
 * El registro vive aquí y no en un módulo suyo porque la actualización tiene
 * dos mitades que no pueden separarse: el `register()` del arranque y el
 * «Actualizar a la versión nueva» que se ofrece en «Más». Las dos hablan del
 * mismo worker en espera.
 *
 * El relevo nunca es automático: `sw.js` solo llama a `skipWaiting()` cuando
 * recibe el mensaje, y el mensaje solo sale de un toque. Cambiar los assets con
 * hash bajo una SPA ya cargada rompe el siguiente `import()` diferido.
 * -------------------------------------------------------------------------- */

let waitingWorker: ServiceWorker | null = null;
const updateListeners = new Set<() => void>();

function announceUpdate(worker: ServiceWorker | null) {
  waitingWorker = worker;
  updateListeners.forEach((listener) => listener());
}

function watchRegistration(registration: ServiceWorkerRegistration) {
  // `controller` es lo que distingue una actualización de la primera
  // instalación: sin página controlada, «instalado» solo significa que la app
  // acaba de ganar caché, y anunciar una versión nueva ahí sería mentira.
  if (registration.waiting && navigator.serviceWorker.controller) {
    announceUpdate(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        announceUpdate(registration.waiting ?? installing);
      }
    });
  });
}

/** Se llama una vez, desde `main.tsx`, y solo en producción. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(watchRegistration)
      // Un registro que falla —contexto no seguro, worker con un error de
      // sintaxis, permisos del navegador— no puede tumbar la app: se anota y se
      // sigue. Sin worker, next-ride es exactamente lo que era antes.
      .catch((error) => console.warn("No se pudo registrar el service worker:", error));
  });
}

export function useAppUpdate(): { available: boolean; apply: () => void } {
  const [available, setAvailable] = useState(() => waitingWorker !== null);

  useEffect(() => {
    const listener = () => setAvailable(waitingWorker !== null);
    updateListeners.add(listener);
    listener();
    return () => {
      updateListeners.delete(listener);
    };
  }, []);

  const apply = useCallback(() => {
    const worker = waitingWorker;
    if (!worker) return;
    // Se recarga cuando el worker nuevo toma el control, no al enviar el
    // mensaje: recargar antes volvería a servir el documento del worker viejo y
    // el relevo se quedaría a medias.
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true },
    );
    worker.postMessage({ type: "skip-waiting" });
  }, []);

  return { available, apply };
}
