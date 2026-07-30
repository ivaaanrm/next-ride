import {
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
    <span className={`score ${tone}`} title={`Puntuación ${value}/100`}>
      <span className="score-bar">
        <span style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      {Math.round(value)}
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
  return <div className={`banner ${kind}`}>{children}</div>;
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
  return (
    <div className="loading">
      <span className="spinner" /> {label}
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

    function onPointerDown(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Cerrar con Escape devuelve el foco al botón: si no, se queda en un nodo
      // que acaba de desaparecer y el tabulador vuelve al principio de la página.
      trigger.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
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
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  /** Para paneles con contenido a dos columnas. */
  wide?: boolean;
}) {
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className={`drawer${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <header className="drawer-header">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle ? <div className="tiny muted">{subtitle}</div> : null}
          </div>
          <div className="spacer" />
          {actions}
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}
