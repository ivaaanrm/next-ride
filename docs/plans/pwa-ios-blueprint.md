# Blueprint: next-ride en un iPhone

Especificación cerrada para convertir el frontend de escritorio en una PWA
instalable y utilizable con una mano en un iPhone. Viewport de referencia:
**390 × 844**, instalada en la pantalla de inicio, sin barra de direcciones.

Este documento no propone: decide. Donde los tres carriles de investigación
—auditoría, patrones y plataforma— discrepaban, la resolución está escrita, con
su motivo, en «[Lo que se ha revocado](#lo-que-se-ha-revocado)». Los valores son
finales: quien implemente no tiene que elegir nada de lo que hay aquí.

La regla que gobierna todo lo demás: **se extiende el lenguaje existente, no se
sustituye.** Fondo casi blanco, filetes de un píxel, un solo azul de acento,
escala de 4 pt, tokens nombrados por relación. Lo que cambia es la densidad y el
tamaño de los objetivos, no el registro.

---

## 1. El punto de partida, en una línea

`npm run check:pwa` → 10 errores, 8 avisos. `npm run check:budgets` → 189,3 KB de
JS inicial contra 140. La barra lateral hace `display: none` por debajo de 860 px
sin sustituto, así que cinco de las seis rutas y el botón de cerrar sesión son
inalcanzables en un móvil instalado. La tabla de ofertas mide 1.214 px en un
carril de 348 y el precio empieza en x≈620. Eso es lo que hay que cerrar.

---

## 2. Tokens

### 2.1 Retoques a la paleta existente

Cuatro valores se corrigen porque no llegan a AA. Son cambios de un escalón, no
un repintado: el registro visual no se mueve, y el escritorio mejora con ellos.

| Token | Antes | Ahora | Medido |
|---|---|---|---|
| `--text-secondary` | `#666663` | `#5c5b58` | 6,79:1 sobre `--surface`, 6,56:1 sobre `--bg`, 6,17:1 sobre `--surface-sunken` |
| `--text-tertiary` | `#999895` (**2,88:1 — fallaba**) | `#6f6e69` | 5,11:1 surface · 4,94:1 bg · 4,65:1 sunken · 4,77:1 hover |
| `--positive` | `#17803d` (4,48:1 sobre su soft) | `#116b34` | 5,92:1 sobre `--positive-soft`, 6,61:1 sobre `--surface` |
| `--warm` | `#a86612` (4,17:1 sobre su soft) | `#8f5410` | 5,55:1 sobre `--warm-soft`, 6,10:1 sobre `--surface` |

`--text-secondary` se profundiza aunque ya pasaba: con el terciario en 5,11:1 la
rampa de tres grises se quedaba en dos. Ahora es 17,3 / 6,8 / 5,1, que sí se lee
como tres niveles.

### 2.2 Tokens nuevos

```css
:root {
  /* Color ------------------------------------------------------------------ */
  /* El borde que **delimita un control** (campo, botón, pomo), separado del
     filete decorativo. WCAG 1.4.11 pide 3:1 para el límite de un componente;
     --border y --border-strong siguen siendo filetes de separación y no lo
     necesitan. Con esto el sistema deja de mentir sobre qué borde es qué. */
  --border-control: #8f8e89;      /* 3,28:1 sobre --surface */
  /* Texto sobre un relleno de color sólido: acento, warm, negative, positive. */
  --on-solid: #ffffff;            /* 5,28:1 sobre --accent, 6,10 warm, 6,57 negative */
  --backdrop: rgba(27, 27, 24, 0.24);

  /* Áreas seguras. Se nombran una vez y las usa todo lo que toca un borde de
     pantalla; nadie vuelve a escribir env() suelto. */
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-right: env(safe-area-inset-right, 0px);

  /* Geometría táctil ------------------------------------------------------- */
  --tap-target: 44px;             /* suelo HIG. Es área de impacto, no tinta. */
  --control-height-touch: 44px;   /* .btn/.input/.select por debajo de 860px */
  --row-height-touch: 76px;       /* la fila de oferta de tres líneas */
  --topbar-height-touch: 44px;
  --tabbar-height: 56px;
  --rail-height: 56px;            /* riel de chips de filtro */
  --sheet-max-height: 92dvh;

  /* Tipografía de la capa móvil. No se tokeniza la hoja entera: se nombran los
     cinco tamaños que usan las superficies nuevas. */
  --font-body: 13px;              /* 15px por debajo de 860px */
  --font-field: 16px;             /* umbral de zoom de Safari. No se baja nunca. */
  --font-amount: 18px;            /* el precio en la fila de oferta */
  --font-meta: 12px;
  --font-micro: 11px;

  /* Movimiento ------------------------------------------------------------- */
  --motion-fast: 80ms;            /* el que ya usan los :hover */
  --motion: 140ms;                /* salida de fila, toast, plegado lateral */
  --motion-sheet: 240ms;          /* entrada y salida de una hoja */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);

  /* Apilado. Los números existentes eran 5 (topbar), 2 (thead), 20 (backdrop),
     21 (drawer), 30 (toasts). La barra de pestañas entra entre la topbar y el
     backdrop: por encima de la página, por debajo de cualquier hoja. */
  --z-tabbar: 15;
}
```

Los seis colores literales que quedaban fuera del bloque de tokens pasan a
token: `.brand-mark`/`.nav-badge` usan `var(--on-solid)`, `.btn-primary` usa
`var(--on-solid)`, `.drawer-backdrop` usa `var(--backdrop)`.

### 2.3 Modo oscuro

Se especifica entero. Un iPhone se mira de noche y el propio `PRODUCT.md` dice
que el contexto de uso es nocturno; dejarlo para después significa una app que
quema en la cama. Sin conmutador: se sigue a `prefers-color-scheme`, que es lo
que el sistema ya sabe.

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121211;
    --surface: #1a1a19;
    --surface-hover: #232322;
    --surface-sunken: #0e0e0d;
    --border: #2b2b29;
    --border-strong: #3a3a37;
    --border-control: #6e6e69;      /* 3,40:1 sobre --surface */

    --text: #f2f1ee;                /* 15,42:1 surface · 16,60:1 bg */
    --text-secondary: #a5a49e;      /* 6,97:1 surface · 6,30:1 hover */
    --text-tertiary: #8e8d87;       /* 5,23 surface · 5,63 bg · 4,73 hover · 5,80 sunken */

    --accent: #7fa9ff;              /* 7,48:1 sobre --surface */
    --accent-hover: #9cbcff;
    --accent-soft: #1b2740;         /* acento sobre él: 6,39:1 */

    --positive: #55c98a;            /* 8,38 surface · 7,35 sobre su soft */
    --positive-soft: #122a1d;
    --warm: #e0a355;                /* 7,91 surface · 7,22 sobre su soft */
    --warm-soft: #2c2011;
    --negative: #ff7a6e;            /* 6,85 surface · 6,53 sobre su soft */
    --negative-soft: #331613;
    --neutral-soft: #262625;

    --on-solid: #121211;            /* 8,05 sobre acento, 8,51 warm, 7,37 negative */
    --backdrop: rgba(0, 0, 0, 0.55);
    --shadow: 0 2px 4px rgba(0, 0, 0, 0.5), 0 12px 24px rgba(0, 0, 0, 0.4);

    /* Puente para las clases de shadcn/ui que usan los gráficos. Va aquí y no en
       tailwind.css porque styles.css se importa después y sin capa: gana. */
    --color-border: #2b2b29;
    --color-background: #1a1a19;
    --color-foreground: #f2f1ee;
    --color-muted: #0e0e0d;
    --color-muted-foreground: #a5a49e;
    /* chart-1 sigue al acento; los otros dos se quedan porque ya separan y
       contrastan sobre el fondo oscuro: 5,86:1 el naranja, 5,95:1 el verde. */
    --color-chart-1: #7fa9ff;
  }
}
```

Todos los pares de arriba están medidos con la fórmula de luminancia relativa de
WCAG 2.1, no estimados. Ninguno baja de 4,5:1 para texto ni de 3:1 para límites
de componente. `--border` y `--border-strong` siguen siendo filetes decorativos
en ambos modos (1,2–1,5:1) y eso es deliberado: separan bloques, no delimitan
controles.

---

## 3. Tipografía y densidad en el móvil

Todo lo de esta sección va dentro de `@media (max-width: 860px)`, que es el
mismo umbral con el que ya desaparece la barra lateral. Un solo punto de corte
en toda la app.

| Qué | Escritorio | Móvil |
|---|---|---|
| `body` | 13 px | **15 px** |
| `input`, `select`, `textarea` (selector de elemento) | hereda | **16 px, declarado** |
| `.btn`, `.input`, `.select` alto | 28 px | **44 px** |
| `.btn-sm` alto | 24 px | **44 px** (el rótulo baja a 13 px) |
| `.icon-btn`, `.star` | 24 / 20 px | **44 × 44 px de área**, tinta igual |
| Fila de la lista | 36 px | **76 px** (tres líneas) |
| `.topbar` | 48 px fijos | **44 px mínimo + `--safe-top`**, con envoltura |

La regla del elemento —no de la clase— es obligatoria:

```css
@media (max-width: 860px) {
  input, select, textarea { font-size: var(--font-field); }  /* 16px */
}
```

`check:pwa` parsea reglas con selector de elemento; sin esta regla el aviso
`css.input-font-size.explicit` sigue en pie y, sobre todo, Safari hace zoom al
enfocar cualquier campo.

**Excepciones al suelo de 44 pt: solo los enlaces en línea dentro de un párrafo**
(el enlace de un aviso, el «Ver el estado en Ajustes» dentro de una frase). En
ningún otro sitio. La tinta puede seguir midiendo 20 px —la estrella no engorda—;
lo que mide 44 es la caja que recibe el toque.

---

## 4. Navegación

La barra lateral no sobrevive. Por debajo de 860 px la sustituye una **barra de
pestañas inferior de cuatro destinos**, fija, presente en las seis rutas.

```
┌──────────────────────────────────────────┐
│  ◱ Ofertas   ◫ Analítica   ◈ Modelos   ⋯ Más │  56px + --safe-bottom
└──────────────────────────────────────────┘
```

- **Ofertas** `/offers` — la ruta por defecto y la pregunta con la que se entra.
- **Analítica** `/analytics`
- **Modelos** `/models`
- **Más** `/more` — ruta nueva, propiedad de la fundación.

Los iconos son los que ya usa `NAV` en `Layout.tsx` (`◱ ◫ ◈`), más `⋯` para Más.
Rótulo de 11 px debajo del icono, siempre visible: cuatro glifos geométricos sin
palabra no se distinguen. Ítem de 64 px de ancho mínimo y 48 px de alto útil
dentro de una barra de 56, más `--safe-bottom`. Activo en `--accent` con
`font-weight: 500` y `aria-current="page"`; inactivo en `--text-secondary`.

**Qué hay dentro de «Más»** (una lista de filas de 44 pt, en este orden):

1. *Espacio de trabajo*: Dealers.
2. *Sistema*: Avisos (con el contador que hoy vive en la campana; el número va
   en texto, no en un punto de 8 px), Ajustes, API keys.
3. *Aplicación*: «Recargar la app» (`location.reload()`), «Instalar en la
   pantalla de inicio» (hoja con las instrucciones de iOS), la versión, y
   «Actualizar a la versión nueva» cuando hay un worker esperando.
4. *Sesión*: el email y «Cerrar sesión», en `--negative`.

El contador de avisos se dibuja además como insignia sobre el icono de Más y
entra en el nombre accesible de la pestaña («Más: 1 aviso»).

**Dónde vive «atrás», «recargar» y «estás aquí»** —las tres cosas que en
standalone no tiene el navegador:

- **Atrás**: no hay botón global. Cada superficie que tapa la pantalla lleva su
  propio cierre visible de 44 pt en la cabecera, a la izquierda. El detalle de
  una oferta es además una entrada de historial (`?offer=<id>`), así que el
  gesto de borde del sistema —cuando iOS lo entrega— cierra la hoja en vez de
  cambiar de ruta. Ninguna decisión depende de que ese gesto exista.
- **Recargar**: «Actualizar» sigue en la cabecera de cada página (subido a
  44 pt) para recargar *los datos*; «Recargar la app» está en Más para recargar
  *el documento*, que es lo que en un navegador haría el botón de refresco.
- **Estás aquí**: la pestaña activa y el `<h1>` de la barra superior. Dos
  señales, ninguna dependiente de color solo.

El escritorio no cambia: por encima de 860 px la barra lateral sigue igual, con
su plegado, su ⌘B y su preferencia recordada. La barra de pestañas es
`display: none` ahí. El plegado sigue siendo un idioma de puntero y no se porta.

---

## 5. Superficies

**Una sola regla, y no hay que adivinar:**

> **Ruta** si tiene URL propia y cabecera propia.
> **Hoja inferior** (`.sheet`) si es un control del que se vuelve en segundos:
> filtros, orden, un menú.
> **Hoja completa** (`Drawer` en móvil) si es contenido que se lee: el detalle
> de una oferta, el panel de avisos, la configuración de captación.
> En el escritorio nada de esto cambia: el panel lateral sigue siendo panel
> lateral y los popovers siguen anclados a su botón.

### 5.1 Hoja inferior (`.sheet`)

- Ancho completo; alto según contenido hasta `--sheet-max-height` (92 dvh).
- Esquinas superiores `--radius-lg`; asa decorativa de 36 × 4 px, `aria-hidden`.
- Cabecera de 48 px: **[Cancelar]** a la izquierda (44 pt), título centrado,
  acción secundaria a la derecha.
- Pie **en el flujo de la hoja, nunca `position: fixed`**: con el teclado
  abierto un pie fijo se despega. Lleva `padding-bottom: var(--safe-bottom)`.
- Cierre: el botón de la cabecera, toque en el backdrop, `Escape`. El arrastre
  hacia abajo es opcional y no es la única salida en ningún caso.
- Entrada: `translateY(100%) → 0` en `--motion-sheet` con `--ease-sheet`; el
  backdrop funde en `--motion`.

### 5.2 Hoja completa (el `Drawer` de hoy, por debajo de 860 px)

- `position: fixed; inset: 0; height: 100dvh; width: 100%; border-radius: 0`.
- **El portal se mantiene.** El comentario de `ui.tsx:405-417` explica por qué
  existe y sigue siendo cierto: sin él, el panel se dibuja debajo de la barra
  superior. Quien lo toque, que lo lea antes.
- Cabecera de una sola línea de 48 px + `--safe-top`: **[Cerrar]** (44 pt,
  izquierda) · título recortado a una línea · acciones. Hoy esa cabecera mide
  229 px con un título de cinco líneas, el 27 % de la pantalla; el título
  completo baja al primer bloque del cuerpo, que es donde se lee.
- `role="dialog"` + `aria-modal="true"`, foco al botón de cerrar al abrir, foco
  devuelto al abridor al cerrar, `Escape` cierra.
- Bloqueo del scroll de fondo mientras está abierta (`overflow: hidden` en
  `documentElement`) y `overscroll-behavior: contain` en el cuerpo.

### 5.3 Áreas seguras, elemento por elemento

Ningún `env()` suelto: todo pasa por los cuatro tokens.

| Elemento | Qué consume | Cómo |
|---|---|---|
| `.topbar` | arriba | `padding-top: var(--safe-top)`; `min-height: calc(var(--topbar-height-touch) + var(--safe-top))` |
| `.tabbar` | abajo | `padding-bottom: var(--safe-bottom)`; `height: calc(var(--tabbar-height) + var(--safe-bottom))` |
| `.toasts` | abajo | `bottom: calc(var(--tabbar-height) + var(--safe-bottom) + var(--space-sm))` |
| `.sheet` (pie) | abajo | `padding-bottom: var(--safe-bottom)` |
| `.drawer` (cabecera) | arriba | `padding-top: var(--safe-top)` |
| `.drawer` (pie de acciones) | abajo | `padding-bottom: var(--safe-bottom)` |
| `.content` | laterales | `padding-inline: max(var(--space-md), var(--safe-left))` / `--safe-right` |
| `.auth-shell` (login) | los cuatro | `min-height: 100dvh` + padding con los cuatro tokens |

Las cinco alturas de `100vh` pasan a `100dvh`: `.app` (min-height), `.sidebar`,
`.main:has(> .view > .content-fill)`, `.drawer` y el login. **El mecanismo del
`:has()` de la línea 399 se conserva** —está razonado en su comentario y es lo
que fija el marco de la tabla—; lo único que cambia es la unidad.

---

## 6. La pantalla de ofertas

Es la ruta por defecto y el 90 % de la app. Su versión móvil se decide entera
aquí.

### 6.1 El pliegue

```
 0   ┌─────────────────────────┐
 59  │ ░░ área segura superior  │
     ├─────────────────────────┤
103  │ Ofertas        Actualizar│  barra superior, 44
     ├─────────────────────────┤
159  │ [Filtros 2][Valor ↓][…] │  riel de chips, 56
     ├─────────────────────────┤
187  │ 261 ofertas · mediana …  │  línea de contexto, 28
     ├─────────────────────────┤
     │ Audi A3 Sportback…      │
     │ 24.590 €  −8,2%  72  ①  │  fila de 76
     │ 2019 · 103.473 km · …   │
     │ ─────────────────────── │  × 7,4
754  ├─────────────────────────┤
     │ ◱   ◫   ◈   ⋯          │  pestañas, 56
844  └── ░░ indicador de inicio ┘
```

Siete filas completas y parte de la octava. Hoy caben siete filas de 36 px en un
carril de 284 px **sin el precio dentro**: se mantiene la densidad y se gana la
cifra por la que existe el producto.

### 6.2 La fila de oferta

Tres líneas con gramática fija, para que el ojo aprenda una posición por dato.
Una `<ul>` de `<li>`, no una tabla con `display: block`: la tabla sigue
existiendo tal cual por encima de 860 px, y una tabla desmontada con CSS pierde
su semántica sin avisar.

```
┌──────────────────────────────────────────────┬─────┐
│ Audi A3  Sportback Advanced 30 TFSI          │     │
│ 24.590 €   −8,2 %   72   ①                   │  ★  │
│ 2019 · 103.473 km · 14.800 km/año · Diésel · Barcelona │
└──────────────────────────────────────────────┴─────┘
   columna de contenido (abre el detalle)        44px
```

- **Línea 1 — identidad.** `{make} {model}` a 15 px/500; `{trim}` a 13 px en
  `--text-secondary`, recortado con elipsis. Sin `title`.
- **Línea 2 — el juicio.** `{price}` a `--font-amount` (18 px)/600 con
  `font-variant-numeric: tabular-nums`, anclado a una x fija para que el barrido
  vertical lea como columna. Al lado, el `Chip` de «vs mediana» tal cual, la
  puntuación de valor (`Score`, compacto) y la insignia de puesto de IA **solo
  si `offer.ai` no es nulo**.
- **Línea 3 — la evidencia.** `{year} · {km} · {km/año} · {combustible} · {ubicación}`
  a 12 px `--text-tertiary`, una línea, elipsis. **El combustible va con su
  palabra entera** («Diésel»), no con la inicial: la letra funcionaba porque el
  `title` la explicaba, y en táctil no hay `title`.
- **La estrella** ocupa su propia columna de 44 px a todo el alto de la fila,
  con `stopPropagation`. Es el único control que compite con el toque de la fila
  y por eso se separa físicamente.
- Alto mínimo `--row-height-touch`, filete inferior de 1 px, `:active` con
  `--surface-hover` (feedback antes de que conteste la red).

La mediana contra la que se mide «vs mediana» —hoy en un `<th>` que desaparece—
va a la línea de contexto: «261 ofertas · mediana en pantalla 21.900 €».

### 6.3 Lo que se cae de la primera pantalla

Las cinco cifras agregadas (`Precio medio`, `Descuento medio`, `Km medios`,
`Km / año`, `Modelos`) y el bloque «Mejor chollo» **desaparecen de la lista** y
se dibujan dentro de la hoja de filtros, en un bloque «Resumen» encima del
contador. No se pierden: el comentario de `styles.css:871-878` dice que
describen la tabla de debajo, y en la hoja de filtros describen exactamente el
conjunto que se está acotando. En un móvil, en la lista, la reemplazaban.

### 6.4 Filtrar

**Riel de chips** (56 px, pegajoso bajo la barra superior, scroll horizontal,
`overscroll-behavior-x: contain`, sin barra de scroll visible):

```
[ Filtros ② ] [ Valor ↓ ] [ Audi A3 ✕ ] [ 12.000–30.000 € ✕ ] [ Descartadas ✕ ] … [ Limpiar ]
```

Un chip por filtro **aplicado**, con su valor y una ✕ que quita solo ese.
«Limpiar» al final del riel y no al principio: es lo destructivo y no debe ser
lo primero bajo el pulgar que arrastra. Chips de 44 px de alto, 13 px de texto,
borde `--border-control`, y `--accent-soft` + `--accent` cuando están activos
—el mismo acento que ya marca `.select.on`, `.toggle` encendido y
`.popover-trigger.on`.

**Hoja de filtros** (inferior, 92 dvh), abierta por el chip «Filtros»:

1. Cabecera: **[Cancelar]** · «Filtros» · **[Limpiar]**.
2. Bloque «Resumen»: las cinco cifras + «Mejor chollo».
3. Búsqueda (`type="search"`, `inputMode="search"`, `enterKeyHint="search"`).
4. Modelo: **lista buscable, no `<select>` nativo**. iOS dibuja un `<select>`
   como rueda y el catálogo se fragmenta por acabado (un Audi A3 son veintitrés
   filas). Campo de texto + lista de opciones de 44 pt con
   `{display_name} ({active_offers})`.
5. Dealer, Estado del vehículo, Estado en la plataforma: `<select>` nativo. Son
   8, 4 y 3 opciones; la rueda es correcta ahí.
6. Precio y Año: el `RangeSlider` que ya existe, a ancho completo. El carril
   entero agarra y ya lleva `touch-action: none` con su motivo escrito: no se
   toca. El único cambio es que la franja de agarre sube de 19 px a 44.
7. Seguidos y Favoritos: los dos `Toggle`, a 44 pt.
8. Pie en flujo: **«Ver 217 ofertas»** en `--accent`, a ancho completo, 48 px.

Dentro de la hoja **la lista no se recarga**. Solo el contador, contra
`/offers/stats`, que ya acepta el mismo objeto de filtros y ya devuelve `count`.
Aplicar cierra la hoja y dispara la recarga. Filtrar en vivo con una hoja abierta
es la forma documentada de echar al usuario de la hoja, y aquí cada arrastre del
deslizador pediría 50 filas.

**Hoja de orden**, abierta por el chip que muestra el orden actual: lista de
selección única con los cinco `SORT_COLUMNS`, cada uno con su `what` en palabras
(«precio», «puesto que le da la IA»). Debajo de los dos con tope, el texto de
`CAP_HINT` **visible**: «Ordenar por puntuación evalúa hasta 500 ofertas
coincidentes; para catálogos más grandes, filtra por modelo o dealer». Hoy ese
aviso vive en un `title` y es lo único que hace fiable el orden por puntuación.
El orden no entra en la hoja de filtros: `clearFilters()` deliberadamente no lo
toca, y esconderlo tras un «Aplicar» cobra cuatro toques por un reordenado.

### 6.5 Triaje: descartar y no disponible

Deslizar la fila **hacia la izquierda** revela dos botones a todo el alto, con su
nombre escrito: **Descartar** y **No disponible** (88 px cada uno). Un segundo
toque, deliberado, confirma. **No hay confirmación por deslizamiento completo**:
las dos acciones afirman cosas distintas —una la firma quien mira, la otra el
anuncio— y un rebase de inercia no puede archivar una oferta en el estado
equivocado.

Implementación: un contenedor con `scroll-snap-type: x mandatory` y dos puntos de
anclaje. Es scroll nativo, así que el bloqueo de eje y la inercia los pone iOS y
no hay que arrastrar con JavaScript. Los botones son `<button>` de verdad, así
que VoiceOver los alcanza sin gesto ninguno. `overscroll-behavior-x: contain`
para que el rebote no encadene al documento.

Solo hacia la izquierda: un gesto que empieza en el borde izquierdo es el gesto
de «atrás» del sistema en las configuraciones que lo honran, y desde una app
instalada no se puede desactivar.

**Descubrimiento**: la primera vez que la lista se dibuja sin que exista
`localStorage["nr.swipe_hint_seen"]`, la primera fila se abre 56 px y vuelve en
600 ms, y se marca la bandera. Con `prefers-reduced-motion` no hay animación: en
su lugar sale una línea bajo el riel, «Desliza una fila a la izquierda para
descartarla o marcarla no disponible», que se descarta al primer deslizamiento.

El camino optimista con deshacer no se toca —está razonado en `ui.tsx:166-177` y
es justo lo que hace segura la gestión—; lo único que cambia es dónde cae el
aviso: `--tabbar-height` + `--safe-bottom` por encima del borde, con «Deshacer»
a 44 pt y permiso para ocupar dos líneas.

### 6.6 Lo que sobrevive a un arranque en frío

El estado de la vista pasa a la URL:

```
/offers?q=a3&model=41&price_min=12000&price_max=30000&year_min=2018
       &status=active&tracked=1&sort=value_score&offer=8412
```

Once `useState` de filtro, el orden, la vista de estado y la oferta abierta se
leen y se escriben con `useSearchParams`. El debounce escribe con
`replace: true` para no apilar cincuenta entradas de historial al teclear; abrir
una oferta **empuja** entrada, cerrarla es un `navigate(-1)`.

La posición de scroll y el número de tramos cargados van a `sessionStorage`,
indexados por la query string. La URL es la capa durable; `sessionStorage` es
una comodidad para el cambio de app. **Nada de filtros en `localStorage`**: un
estado que revive al matar la app le quita al usuario su único gesto de
recuperación, y la pregunta de este producto es «¿ha bajado algo interesante
hoy?», no «¿qué filtré el jueves?».

Esto es lo que hace que valga la pena el viaje al anuncio del dealer, que es el
momento en que iOS congela y a menudo mata el contexto.

### 6.7 Salir al anuncio del dealer

Tocar una fila **nunca** sale de la app: abre el detalle, que ya está ordenado
para responder «¿merece la pena abrir esto?» antes de comprometer nada. Salir es
una acción explícita y única en el pie de la hoja de detalle:

- **«Abrir el anuncio ↗ coches.net»** — con el host a la vista,
  `target="_blank" rel="noopener"`, que es la variante que da la superlativa
  in-app con su botón «Done» en vez de destruir el contexto de la PWA.
- **«Copiar enlace»** como secundaria, para quien quiera abrirlo en Safari de
  verdad.
- La foto del anuncio **deja de ser un enlace**: hoy toda la tarjeta de vista
  previa es un `<a>` y el viaje de ida se dispara con un toque mal puesto.

No se pone `-webkit-touch-callout: none` en estos enlaces: la pulsación larga y
su «Abrir en Safari» son la única ruta fiable al navegador real.

Los enlaces externos de Modelos, Dealers y API keys se quedan como están: son
correctos, y con la barra de pestañas siempre presente el regreso no deja a nadie
tirado.

---

## 7. Estados compartidos

Cuatro, especificados una vez, en `ui.tsx`, y usados por todos los paquetes.

| Estado | Componente | Forma en móvil | Copy |
|---|---|---|---|
| Vacío | `Empty` (existe) | 48 px de aire, título 15 px, pista 13 px | La de cada vista, sin cambios |
| Cargando | `Loading` (existe) | fila centrada de 44 px de alto con el spinner | «Cargando…» |
| Error | `Banner kind="error"` (existe) | ancho completo, 13 px, ≥44 pt si lleva acción | El mensaje del servidor |
| **Sin conexión** | `OfflineNotice` (**nuevo**) | bloque centrado con título, cuerpo y un botón de 44 pt | «Sin conexión» / «No se ha podido contactar con el servidor. La sesión sigue abierta.» / **[Reintentar]** |

`OfflineNotice` es distinto del error por una razón que hoy es un fallo
bloqueante: una red caída y una sesión caducada renderizan la misma pantalla de
login, y el usuario no sabe cuál de las dos le ha pasado ni si reintentar sirve
de algo.

**Retroalimentación al toque.** Con el `:hover` fuera de juego, todo estado
pulsado se escribe a mano: `-webkit-tap-highlight-color: transparent` global y
`:active` explícito en `.offer-row`, `.btn`, `.icon-btn`, `.star`, `.chip`,
`.tabbar-item` y las filas de las hojas. La fila que abre el detalle además se
queda en su estado pulsado hasta que la hoja aparece: hoy un toque que dispara
una petición de historial de precios se lee como ignorado.

---

## 8. La capa PWA

### 8.1 `index.html`

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />
<meta name="theme-color" content="#fbfbfb" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="next-ride" />
<meta name="format-detection" content="telephone=no" />
<link rel="manifest" href="/manifest.json" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.v1.png" />
```

`viewport-fit=cover` es la precondición de todo lo demás: sin él cada
`env(safe-area-inset-*)` vale 0 y el CSS de áreas seguras es inerte.
`user-scalable=no` y `maximum-scale=1` **no** se ponen: rompen WCAG 1.4.4 y
`check:pwa` los bloquea. `format-detection: telephone=no` es obligatorio aquí
porque `formatNumber` produce «103.473» y «24.590», que es exactamente lo que el
detector de datos de iOS convierte en enlaces `tel:`.

### 8.2 `public/manifest.json`

```json
{
  "id": "/",
  "name": "next-ride",
  "short_name": "next-ride",
  "description": "Ofertas de coches de varios dealers, comparadas.",
  "start_url": "/offers",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "lang": "es",
  "dir": "ltr",
  "background_color": "#fbfbfb",
  "theme_color": "#fbfbfb",
  "icons": [
    { "src": "/icons/icon-192.v1.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.v1.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.v1.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`.json` y no `.webmanifest`: `nginx:1.27-alpine` no tiene el tipo MIME de
`webmanifest` en `mime.types` y lo serviría como `application/octet-stream`.
Con `.json` el problema no existe.

### 8.3 Iconos

Cuatro PNG, comprometidos al repositorio ya rasterizados. **Nada de generarlos en
el build de Docker**: el contenedor solo tiene las dependencias de `npm ci`.

- Fuente: `public/icons/source/icon.svg` (512 × 512, fondo `--accent` a sangre,
  monograma «NR» en blanco) y `source/maskable.svg` (el mismo dentro del 80 %
  central, que es la zona segura del recorte).
- Rasterizado, con lo que ya trae macOS y sin instalar nada:

```bash
sips -s format png public/icons/source/icon.svg     --out public/icons/icon-512.v1.png
sips -Z 192 public/icons/icon-512.v1.png            --out public/icons/icon-192.v1.png
sips -Z 180 public/icons/icon-512.v1.png            --out public/icons/apple-touch-icon-180.v1.png
sips -s format png public/icons/source/maskable.svg --out public/icons/maskable-512.v1.png
```

- **Sin transparencia y sin esquinas redondeadas dibujadas**: iOS aplica la
  máscara. Un PNG con alfa se compone contra negro.
- `.v1` en el nombre es obligatorio: todo lo de `public/` se sirve `immutable`
  30 días, así que cambiar un icono en su sitio es invisible durante un mes para
  quien ya lo tiene instalado. Se cambia el icono cambiando el número.
- **Sin matriz de `apple-touch-startup-image`.** Una docena de PNG retina no cabe
  con holgura en el presupuesto de precaché y no compensa: el arranque enseña el
  `background_color`, y se dice aquí para que nadie lo tome por un olvido.

### 8.4 El service worker

`public/sw.js`, JavaScript plano, sin bundling. Sin `vite-plugin-pwa`: no añade
dependencia, no toca el lockfile que usa `npm ci`, y no obliga a un
`tsconfig.worker.json` para que `tsc -b` no se coma los globales de worker.

**Registro** en `main.tsx`, envuelto en `import.meta.env.PROD` para no servir
caché rancia mientras se desarrolla.

**Qué cachea** (lista de permitidos; lo que no esté, no se cachea):

| Recurso | Política | Caché |
|---|---|---|
| `/assets/*-[hash].js|css` | cache-first | `nr-assets-v1` |
| `/manifest.json`, `/icons/*` | cache-first, precargados en `install` | `nr-shell-v1` |
| Navegaciones (`mode === "navigate"`) | network-first, `index.html` cacheado como respaldo | `nr-shell-v1` |
| **Todo lo demás** | **pasa de largo, sin tocar la caché** | — |

**Qué no cachea nunca, y por qué es una regla y no un olvido:**

- **Cualquier cosa bajo `/api/`.** No se puede distinguir por la URL lo que es
  catálogo compartido de lo que está acotado al JWT de un usuario —`user:
  CurrentUser` contra `_: CurrentUser` es una diferencia que solo existe en el
  backend—, ninguna respuesta trae `Cache-Control` ni `Vary`, y `GET /api-keys`
  devuelve el inventario de secretos. Una caché por usuario con invalidación en
  `tokens.clear()` y en cada 401 es la forma correcta de hacerlo y es un paquete
  entero de trabajo; hasta que exista, la política es cero. La primera línea del
  `fetch` handler es un `return` para `/api/`, `/docs`, `/health` y
  `/api/v1/openapi.json`, que además son proxy y no rutas del SPA.
- **Imágenes de dealers y cualquier origen cruzado.** Son respuestas opacas: sin
  tope de número y caras en cuota en iOS. El respaldo ya existe y funciona
  (`imageFailed` en `Offers.tsx:1309-1329`).
- **Nada se encola para reintentar sin red.** Ninguna mutación lleva clave de
  idempotencia, así que sin conexión la app es de solo lectura y una acción sin
  red falla a la vista, en el acto, en vez de fingir que ha funcionado.

Lo que da esto: la app instalada **arranca sin red** —el shell, la navegación y
el estado «Sin conexión» con su botón de reintentar— en lugar de la página de
error de Safari. Datos frescos no da ninguno, y en un producto cuyo valor son
los precios de hoy eso es lo correcto.

**Actualización.** `skipWaiting()` **solo** al recibir `{type: "skip-waiting"}`
desde la página. Un `skipWaiting` automático cambia los assets con hash bajo una
SPA ya cargada y el siguiente `import()` dinámico de `Analytics` da 404. La
página detecta el worker en espera y lo anuncia en «Más» y en un aviso
(«Hay una versión nueva · Actualizar»); al tocarlo, se envía el mensaje y se
recarga en `controllerchange`. Además, los `lazy()` de `App.tsx` se envuelven en
un reintento que recarga la página una sola vez si el `import()` falla, que es lo
que pasa cuando un despliegue borra el chunk de debajo.

### 8.5 Servidor y contenedor

```nginx
# El worker no puede quedarse congelado: la regla de assets casa con /sw.js.
location = /sw.js        { add_header Cache-Control "no-cache"; try_files $uri =404; }
# El shell nombra los assets con hash: si se congela, la app apunta a ficheros
# que ya no existen.
location = /index.html   { add_header Cache-Control "no-cache"; }
# ^~ para que la regex de assets no le gane a los prefijos del backend.
location ^~ /api/        { … }
location ^~ /docs        { … }
```

Y en `frontend/Dockerfile`, junto a `COPY src ./src`:

```dockerfile
COPY public ./public
```

Sin esa línea, el manifest, los iconos y el worker existen en el repositorio,
pasan `check:pwa` —que audita el repositorio— y **no están en la imagen**. Es el
cambio de mayor valor por carácter de todo el blueprint.

Queda dicho, porque no lo arregla ningún paquete: **producción sirve HTTP plano**
(`listen 80`, publicado como `8080:80`, sin TLS en ningún sitio del repositorio)
y un service worker exige contexto seguro. Probar en un iPhone real por LAN sobre
http no ejecuta nada de esta capa. Hace falta un origen https —túnel o proxy
terminador— antes de dar por buena la validación en dispositivo.

### 8.6 Instalar

En iOS no hay `beforeinstallprompt` ni instalación programática: la única ruta es
Compartir → Añadir a pantalla de inicio. Por eso «Instalar en la pantalla de
inicio» es una **hoja con instrucciones**, nunca un botón que instala, y en ella
va la advertencia que evita el primer susto: *«La app instalada tiene su propio
almacenamiento, así que la primera vez tendrás que volver a entrar.»* La hoja no
se ofrece si `matchMedia("(display-mode: standalone)")` ya casa.

---

## 9. Presupuestos

`recharts + d3` son 116,67 KB gzip de los 189,3 del arranque, y están en el chunk
de entrada porque `Offers.tsx:10-15` importa `../components/charts`, lo que anula
el `lazy()` de Analytics.

**La decisión: el radar sale de la ruta de ofertas y no vuelve.** En su lugar, la
lectura que el propio código ya reconoce como su equivalente accesible —
`charts.tsx:140-147`: «lo que el radar codifica en posición, aquí es texto»:

- La frase de `RadarReading` («destaca en precio · flojea en kilómetros»),
- debajo, cinco filas `etiqueta / barra 0-100 con marca en el 50 / valor crudo`,
  reutilizando la gramática de `.score-bar` que ya usa `ScoreBreakdown`,
- y el historial de precios como un `<svg>` en línea de ~30 líneas con el primer
  y el último precio rotulados, conservando debajo el `<ol class="price-track">`
  como lectura exacta.

`lib/radar.ts` es aritmética pura sin recharts y ya devuelve esos radios y esos
valores crudos: es un cambio de renderizado, no de datos. Y arregla un fallo de
interacción además de uno de tamaño, porque las cifras del radar hoy solo
existen en un tooltip que un dedo no puede invocar.

Con eso el arranque baja a ~94 KB de JS contra un presupuesto de 140. El chunk
diferido de recharts queda en 116,7 contra un tope de 120, así que
`vite.config.ts` fija `manualChunks` separando `recharts`/`d3` en su propio chunk
para que ese margen de 3,3 KB no dependa de qué más arrastre la página de
Analítica.

**Subir un número de `perf-budgets.json` para que la puerta pase es una regresión
disfrazada, y el propio fichero lo dice.**

---

## 10. Lo que se cae, y por qué

Perder función en silencio es el fallo que este trabajo existe para impedir. Esto
es lo que desaparece de una pantalla móvil, con su destino:

| Se cae de | Qué | A dónde va |
|---|---|---|
| Lista de ofertas | Las cinco cifras agregadas y «Mejor chollo» | Bloque «Resumen» de la hoja de filtros |
| Lista de ofertas | Columnas Ubicación, Km/año, Versión completa, Combustible como letra | Líneas 1 y 3 de la fila (versión recortada, combustible con su palabra) y la hoja de detalle |
| Lista de ofertas | Cabeceras que ordenan (`SortTh`) | Hoja de orden, con el aviso del tope ya visible |
| Lista de ofertas | Scroll horizontal como modo de lectura | Eliminado. La fila cabe en 390 pt |
| Detalle de oferta | El polígono del radar | Frase + cinco barras + valor crudo (§9) |
| Detalle de oferta | Enlace en toda la foto del anuncio | Un solo botón «Abrir el anuncio ↗ host» en el pie |
| Barra lateral | Plegado ⌘B y etiquetas por `title` | No se porta: es un idioma de puntero de punta a punta |
| Analítica | Nada. Los siete gráficos siguen | Una columna, valores también en texto (§11, P3) |

Y lo que **no** se toca, porque ya está bien y romperlo sería el peor resultado
de este trabajo: el troceado del scroll con su contador de época y su cerrojo de
petición en vuelo (`Offers.tsx:345-405`), el movimiento optimista con deshacer
(`ui.tsx:166-177`), el `RangeSlider` con `setPointerCapture` y su
`touch-action: none` razonado, el bloque de `prefers-reduced-motion` con su
partición deliberada, el portal del `Drawer` y su razón de existir, el
single-flight del refresh en `api.ts:88-115`, y los nombres accesibles que ya
llevan la estrella, el combustible y las acciones.

---

## 11. Plan de trabajo

Cuatro paquetes. Uno de fundación, que se implementa solo y primero porque posee
todas las superficies compartidas, y tres de función con ficheros disjuntos. Si
solo llegan la fundación y el primero, la app ya se usa con una mano.

Un detalle de orden que hay que saber: `npm run validate:mobile` encadena build +
`check:pwa` + `check:budgets`, y **`check:budgets` no se pone en verde hasta P1**,
porque quien saca recharts del arranque es `Offers.tsx`, que es suyo. La puerta
de la fundación es `npm run build && npm run check:pwa --strict`.

### F · `pwa-shell-foundation` — la base *(foundation)*

Manifest, iconos, worker, metadatos de iOS, áreas seguras, tokens, tipografía
táctil, barra de pestañas, ruta «Más», primitivos de superficie, y las
correcciones de servidor y contenedor.

**Ficheros**: `frontend/index.html` · `frontend/public/manifest.json` ·
`frontend/public/sw.js` · `frontend/public/icons/{icon-192.v1.png,
icon-512.v1.png, maskable-512.v1.png, apple-touch-icon-180.v1.png,
source/icon.svg, source/maskable.svg}` · `frontend/src/main.tsx` ·
`frontend/src/App.tsx` · `frontend/src/components/Layout.tsx` ·
`frontend/src/components/TabBar.tsx` *(nuevo)* · `frontend/src/pages/More.tsx`
*(nuevo)* · `frontend/src/components/ui.tsx` ·
`frontend/src/components/Notifications.tsx` · `frontend/src/styles.css` ·
`frontend/src/tailwind.css` · `frontend/vite.config.ts` ·
`frontend/nginx.conf` · `frontend/Dockerfile` · `frontend/package.json`

En `ui.tsx`: se añade `Sheet` (§5.1) y `OfflineNotice` (§7); el `Drawer` gana su
forma de hoja completa, `aria-modal`, foco, `Escape` y bloqueo de scroll; el
`Popover` cambia `mousedown` por `pointerdown` —iOS no sintetiza eventos de ratón
sobre contenedores corrientes, así que hoy el panel de precio puede quedarse
abierto tapando la tabla—; `.toasts` se levanta por encima de la barra de
pestañas y del área segura.

**Aceptación**

1. `cd frontend && npm run build` termina con éxito y
   `node scripts/check-pwa.mjs --strict` sale con código 0 (0 errores y 0 avisos).
2. `grep -c "100vh" frontend/src/styles.css` devuelve `0`.
3. `grep -q "COPY public ./public" frontend/Dockerfile`, y `nginx.conf` contiene
   `location = /sw.js`, `location = /index.html`, `^~ /api/` y `^~ /docs`.
4. Con Docker disponible: `docker build -t nr-fe ./frontend && docker run --rm
   --entrypoint sh nr-fe -c "ls /usr/share/nginx/html/manifest.json
   /usr/share/nginx/html/sw.js /usr/share/nginx/html/icons"` sale 0.
5. A 390 × 844, en las siete rutas (`/offers`, `/analytics`, `/models`,
   `/dealers`, `/api-keys`, `/settings`, `/more`):
   `document.documentElement.scrollWidth === document.documentElement.clientWidth`.
6. A 390 × 844 la barra de pestañas es visible en las siete rutas y cada uno de
   sus cuatro ítems mide ≥ 44 × 44 según `getBoundingClientRect()`.
7. Desde `/offers` y solo con toques se llega a Dealers, Ajustes, API keys, el
   panel de avisos y «Cerrar sesión».
8. A 1440 × 900 la barra lateral se dibuja, la de pestañas no, y `/offers` sigue
   mostrando `table.records` con sus 14 columnas.
9. Con `prefers-color-scheme: dark` emulado,
   `getComputedStyle(document.body).backgroundColor === "rgb(18, 18, 17)"`.
10. A 390 × 844, `getComputedStyle(document.querySelector("input")).fontSize`
    devuelve `"16px"` en el formulario de login.

### P1 · `offers-phone-screen` — la pantalla

La fila de tres líneas, el riel de chips, las hojas de filtros y de orden, el
gesto de triaje, el estado en la URL, la salida al anuncio y el radar como
lectura.

**Ficheros**: `frontend/src/pages/Offers.tsx` ·
`frontend/src/components/OfferActions.tsx` ·
`frontend/src/components/OfferRow.tsx` *(nuevo)* ·
`frontend/src/components/OfferFilters.tsx` *(nuevo)* ·
`frontend/src/components/SwipeRow.tsx` *(nuevo)* ·
`frontend/src/components/OfferProfile.tsx` *(nuevo)* ·
`frontend/src/lib/offerParams.ts` *(nuevo)*

`OfferProfile` implementa la lectura del perfil a partir de `lib/radar.ts` sin
importar `components/charts`: esa duplicación de ~20 líneas de prosa respecto a
`RadarReading` es deliberada, porque importar `charts.tsx` devolvería recharts al
chunk de entrada y volvería a romper el presupuesto.

**Aceptación**

1. `cd frontend && npm run check:budgets` sale 0, y
   `grep -c "components/charts" frontend/src/pages/Offers.tsx` devuelve `0`.
2. A 390 × 844 en `/offers`: el contenedor de la lista cumple
   `scrollWidth === clientWidth` (no hay scroll horizontal) y se ven ≥ 7 filas
   completas en la primera pantalla.
3. Toda fila mide ≥ 76 px de alto; el precio formateado está en su `textContent`;
   el control de favorito mide ≥ 44 × 44.
4. Sin puntero: deslizar una fila a la izquierda deja a la vista dos botones,
   «Descartar» y «No disponible», cada uno ≥ 44 pt y con
   `getComputedStyle(...).opacity === "1"`. No existe ningún `opacity: 0` que
   dependa de `:hover` en la lista.
5. El botón «Deshacer» del aviso mide ≥ 44 × 44 y su borde inferior queda por
   encima de `window.innerHeight − 56 − safe-area-inset-bottom`.
6. El chip «Filtros» abre una hoja cuyo botón principal dice «Ver N ofertas»,
   donde N coincide con el `count` que devuelve `/offers/stats` para los filtros
   pendientes; aplicar cierra la hoja y la lista pasa a tener esos filtros.
7. Tras fijar modelo, banda de precio y orden, y abrir una oferta,
   `location.search` contiene `model`, `price_min`, `price_max`, `sort` y
   `offer`; recargar la página restaura la misma lista y la misma hoja abierta.
8. Con la hoja de detalle abierta, `history.back()` la cierra y deja la lista con
   su filtro y su posición.
9. La hoja de orden contiene el texto de `CAP_HINT` como texto visible, y la
   tercera línea de la fila contiene la etiqueta completa del combustible
   («Diésel», no «D»).
10. En la hoja de detalle, la foto del anuncio no es un `<a>`, y existe un único
    botón de salida cuyo rótulo incluye el host del anuncio.
11. A 1440 × 900 `/offers` sigue renderizando la tabla de 14 columnas, con sus
    cabeceras que ordenan y sus acciones al pasar por encima.

### P2 · `network-session-states` — sesión y red

Que una red caída no borre la sesión, y que se vea la diferencia.

**Ficheros**: `frontend/src/lib/api.ts` · `frontend/src/lib/auth.tsx` ·
`frontend/src/lib/hooks.ts` · `frontend/src/pages/Login.tsx`

**Aceptación**

1. `grep -c "catch(() => tokens.clear())" frontend/src/lib/auth.tsx` devuelve `0`.
2. Con la red cortada y tokens válidos en `localStorage`, una carga en frío deja
   `nr.access_token` y `nr.refresh_token` **intactos** y muestra «Sin conexión»
   con un botón «Reintentar»; no se muestra el campo de contraseña.
3. Con un 401 real de `/auth/me` (refresh caducado), los dos tokens se borran y
   aparece el formulario de login.
4. Un fallo de transporte nunca deja llegar «Load failed» a un `Banner`: el texto
   visible es «No hay conexión con el servidor». Toda cadena de error visible
   está en español.
5. Cada petición lleva `AbortController` con corte a 15 s; una petición colgada
   termina en el estado «Sin conexión» y no en un spinner indefinido.
6. Los campos del login declaran `enterKeyHint` y, donde aplica, `inputMode`; a
   390 px todos computan `font-size: 16px`.

### P3 · `analytics-phone` — la analítica

Siete gráficos que se leen con el dedo.

**Ficheros**: `frontend/src/pages/Analytics.tsx` ·
`frontend/src/components/charts.tsx` · `frontend/src/components/ui/chart.tsx`

Los anchos de eje fijos (`width={208}` sobre un gráfico de 316 px, `width={128}`
en el de cajas) pasan a ser proporcionales al contenedor. `interval={0}` se
queda: un gráfico cuyo eje **es** el nombre del dealer no puede saltarse
etiquetas. La mezcla de combustibles pasa a categorías en el eje Y por debajo de
860 px, que es lo que impide el amasijo «HíbHídoenchufabunknown».

**Aceptación**

1. A 390 × 844, `/analytics` dibuja un gráfico por fila y en el de stock por
   dealer el eje de categorías ocupa ≤ 35 % del ancho de la tarjeta.
2. Cada tarjeta de gráfico tiene un desplegable «Ver los datos» con una tabla que
   contiene las mismas series y valores que el gráfico: ningún valor es
   accesible solo por `:hover`.
3. Las etiquetas del eje de categorías no se solapan: los rectángulos de dos
   etiquetas contiguas no se intersecan a 390 px.
4. `npm run check:budgets` sigue en 0 y el mayor chunk diferido queda ≤ 120 KB
   gzip; `dist/index.html` no precarga el chunk de Analytics.
5. A 1440 × 900 `/analytics` conserva su rejilla de dos columnas y sus tooltips.

---

## 12. Lo que se ha revocado

Donde los carriles discrepaban, esto es lo que gana y por qué.

1. **El anti-patrón «no dejes un scroll anidado como dueño del scroll en el
   móvil» (carril 2) queda revocado.** El troceado por scroll —contador de época,
   cerrojo de petición en vuelo, offset derivado de `rows.length`— está atado al
   contenedor `.table-wrap`, y cambiar el dueño del scroll significa reescribir
   la única capa que el propio auditor declara que no hay que tocar. Se conserva
   el carril interior con `100dvh`. La compensación por perder el «tocar la barra
   de estado para subir»: tocar la pestaña activa cuando ya se está en su ruta
   sube la lista al principio, que es la convención de iOS de todos modos.
2. **La tabla de cacheabilidad por ruta del carril 3 no se implementa en la v1:
   el worker no cachea ninguna respuesta de `/api/`.** Distinguir catálogo
   compartido de datos acotados al usuario no se puede hacer por la forma de la
   URL, ninguna respuesta trae `Vary`, y `/api-keys` devuelve secretos. Una
   caché por identidad, borrada en `tokens.clear()` y en cada 401, es la forma
   correcta y es un paquete entero; media implementación es una fuga. La tabla
   del carril 3 se conserva arriba como **lista de prohibiciones**.
3. **`vite-plugin-pwa` queda descartado en favor de un `public/sw.js` escrito a
   mano.** Evita una dependencia, evita regenerar el lockfile que `npm ci`
   exige, y evita un `tsconfig.worker.json`. El coste —no hay manifiesto de
   precaché con los nombres con hash— se paga con caché en tiempo de ejecución,
   que para assets `immutable` es equivalente.
4. **El combustible deja de ser una inicial en el móvil.** El comentario de
   `styles.css:1273-1278` justifica la letra por ancho de columna en un portátil
   y delega el significado en el `title`. En un móvil no hay columna que estrechar
   ni `title` que consultar: gana la palabra.
5. **Las razones escritas en `styles.css` que argumentan sobre un portátil de
   1.512 px se revocan explícitamente, no en silencio**: la fila de filtros de
   28 px de una sola línea (`:633-645`), el recorte de versión a 224 px
   (`:1105-1118`) y el orden llevado a las cabeceras de la tabla (`:1139-1146`).
   Los tres siguen siendo correctos por encima de 860 px y siguen vigentes ahí.
6. **La hoja no se apoya en el arrastre hacia abajo ni en el gesto de borde.** Los
   informes sobre si el gesto de «atrás» funciona en modo standalone se
   contradicen entre sí; ninguna salida de este diseño depende de él, y toda
   superficie que tapa la pantalla lleva su cierre visible de 44 pt.
7. **`--text-tertiary`, `--text-secondary`, `--positive` y `--warm` se retocan
   aunque el encargo diga «no rediseñar».** Los cuatro pares fallan AA hoy
   (2,88:1 el peor). Corregir un contraste no es rediseñar, y el escritorio
   también gana.

---

## 13. Cómo se comprueba todo esto

```bash
cd frontend
npm run build          # tsc -b + vite build
npm run check:pwa      # 23 comprobaciones estáticas; --strict incluye avisos
npm run check:budgets  # gzip del arranque contra perf-budgets.json
npm run validate:mobile
```

Lo que estos comandos **no** pueden ver, y que por tanto se declara como no
verificado hasta que alguien lo mire en un iPhone real sobre https: el render en
dispositivo, el comportamiento instalado (contenedor de almacenamiento propio,
congelación al pasar a segundo plano, vuelta desde el navegador in-app), el
gesto de borde en standalone y el ciclo de actualización del worker.
