import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  // Con alias: este módulo también escucha teclas en `window`, y ahí el evento
  // es el `KeyboardEvent` del DOM. Importarlo sin alias taparía el global y
  // rompería esos dos manejadores sin decir por qué.
  type KeyboardEvent as ReactKeyboardEvent,
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

export function Score({
  value,
  bar = true,
}: {
  value: number | null | undefined;
  /** El carril de proporción. Se apaga donde no cabe informando: en la fila de
   *  oferta del móvil son 34 × 4 px entre un chip y un precio de 18, y ahí se
   *  lee como un guion suelto en vez de como una escala. */
  bar?: boolean;
}) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const tone = scoreTone(value);
  return (
    // El `title` se queda para el puntero, pero la unidad va también en texto:
    // en un móvil no hay dónde consultar un `title`, y dentro de la fila —que es
    // un botón nombrado por su contenido— un número suelto no dice de qué es.
    <span
      className={`score ${tone}${bar ? "" : " score-bare"}`}
      title={`Puntuación ${value}/100`}
    >
      {bar ? (
        <span className="score-bar" aria-hidden="true">
          <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
        </span>
      ) : null}
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

/** Las cinco notas posibles, de peor a mejor. */
const STARS = [1, 2, 3, 4, 5] as const;

/**
 * Selector de 1 a 5 estrellas para una nota que se pone a mano.
 *
 * Es un `radiogroup` y no cinco interruptores sueltos porque eso es lo que es:
 * una nota de cinco, mutuamente excluyentes. De ahí sale el contrato de teclado
 * que el lector de pantalla ya anuncia —una sola parada de tabulador para el
 * grupo, flechas para moverse dentro— y que aquí se implementa entero, con
 * `tabIndex` itinerante y foco que sigue a la selección; un grupo que anuncia
 * flechas y no las tiene es peor que uno que no las anuncia.
 *
 * **Sin nota no es un uno.** Es el estado inicial de todas las ofertas y
 * significa que nadie ha mirado el coche, así que hay que poder volver a él:
 * pulsar la estrella que ya está puesta la quita, `Retroceso` también, y con
 * nota puesta aparece al lado una cruz que la borra, porque «vuelve a pulsar
 * para quitarlo» no lo descubre nadie.
 *
 * Cada estrella se llama «N de 5» y no «estrella N»: lo que se elige es la nota
 * entera, y cinco botones llamados «estrella» obligan a contar para saber cuál
 * está puesta.
 */
export function StarRating({
  value: raw,
  label,
  disabled = false,
  onChange,
}: {
  value: number | null | undefined;
  /** Nombre del grupo para el lector de pantalla: «Equipamiento», «Estado…». */
  label: string;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  // «Sin nota» tiene dos formas de llegar y las dos significan lo mismo: `null`
  // cuando el servidor manda la nota vacía, y `undefined` cuando manda una
  // oferta que todavía no tiene el campo —una respuesta cacheada de antes, o un
  // backend por detrás del frontend en mitad de un despliegue—. Sin unificarlas
  // aquí, `undefined !== null` sacaba el botón de «quitar la nota» encima de
  // cinco estrellas vacías, ofreciendo borrar lo que no había.
  const value = raw ?? null;
  const group = useRef<HTMLDivElement>(null);
  /** La estrella a la que hay que devolver el foco cuando termine el guardado. */
  const pending = useRef<number | null>(null);

  function focusStar(star: number) {
    group.current?.querySelectorAll("button")[star - 1]?.focus();
  }

  /** Cambia la nota y lleva el foco a donde ha quedado. */
  function select(next: number | null) {
    // Sin nota el foco va a la primera estrella: la nota se ha ido, pero el
    // grupo sigue ahí y el foco tiene que quedarse dentro.
    const target = next ?? 1;
    pending.current = target;
    onChange(next);
    // El botón que tenía el foco se queda con `tabIndex={-1}` tras el cambio,
    // pero el foco no se mueve solo: sin esto, las flechas cambiarían la nota
    // dejando el foco tres estrellas atrás.
    focusStar(target);
  }

  // Guardar deshabilita las cinco estrellas, y el navegador no deja el foco en
  // un control deshabilitado: lo suelta al `<body>`. Sin esto, pulsar una flecha
  // cambiaba la nota y dejaba a quien navega con teclado en la nada, teniendo
  // que tabular desde el principio del documento para volver.
  useEffect(() => {
    if (!disabled && pending.current !== null) {
      focusStar(pending.current);
      pending.current = null;
    }
  }, [disabled]);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (disabled) return;
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (step) {
      event.preventDefault();
      select(clamp((value ?? 0) + step, 1, 5));
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      select(null);
    }
  }

  return (
    <div className="star-rating">
      <div
        ref={group}
        className="star-rating-stars"
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {STARS.map((star) => {
          const filled = value !== null && star <= value;
          return (
            <button
              key={star}
              type="button"
              role="radio"
              className={`star${filled ? " on" : ""}`}
              disabled={disabled}
              aria-checked={value === star}
              // Sin nota la parada del tabulador es la primera estrella: un
              // grupo sin nada elegido tiene que poder recibir el foco igual.
              tabIndex={star === (value ?? 1) ? 0 : -1}
              aria-label={`${star} de 5`}
              onClick={() => select(star === value ? null : star)}
            >
              {filled ? "★" : "☆"}
            </button>
          );
        })}
      </div>
      {value !== null ? (
        <button
          type="button"
          className="icon-btn star-rating-clear"
          disabled={disabled}
          // El icono no se explica solo: el nombre lleva el estado al que
          // devuelve —«sin nota»— y no el gesto, que es lo que hay que poder
          // elegir. Sin el `title`, un puntero solo ve una cruz.
          title="Quitar la nota"
          aria-label="Sin nota"
          // Por `select` y no por `onChange` a secas: este botón desaparece al
          // quitar la nota, así que el foco tiene que ir a algún sitio y ese
          // sitio son las estrellas que deja detrás.
          onClick={() => select(null)}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6" />
          </svg>
        </button>
      ) : (
        // El hueco del botón se queda reservado y vacío: sin nota no hay nada
        // que quitar, pero si el sitio no estuviera, poner la primera estrella
        // correría las cinco a la izquierda.
        <span className="star-rating-clear-slot" aria-hidden="true" />
      )}
    </div>
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
 * Píldora de acciones
 *
 * Lo que se hace con lo que se está leyendo, flotando al pie del panel en vez de
 * clavado en su cabecera.
 *
 * La cabecera era el peor sitio posible para estas acciones, y por dos motivos
 * que apuntan a lo mismo: se deciden **al final** —después del veredicto, de la
 * ficha y muchas veces del propio anuncio—, y en la mano el final está a varias
 * pantallas de scroll de la cabecera y fuera del alcance del pulgar. Además,
 * tres rótulos escritos ahí arriba dejaban al titular del coche unos cien
 * píxeles. Flotando abajo, las acciones están donde acaba la lectura y donde ya
 * está el dedo, y el titular recupera la cabecera entera.
 *
 * `position: sticky` dentro del cuerpo que hace scroll, y no `fixed`: es el
 * mismo primitivo que ya usa el pie de la configuración de captación, y al vivir
 * dentro del panel hereda su escalón de apilado. Un segundo panel abierto encima
 * —el editor sobre la ficha— la tapa como tapa a todo lo demás; con `fixed`
 * habría que perseguirle el `z-index` a mano y acabaría flotando sobre un
 * formulario al que no pertenece.
 * -------------------------------------------------------------------------- */
export function ActionPill({
  label,
  children,
}: {
  /** Qué se puede hacer aquí, para quien no ve la píldora. Es un grupo y no una
   *  barra de herramientas: los botones no se recorren con las flechas. */
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="action-pill" role="group" aria-label={label}>
      {children}
    </div>
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
