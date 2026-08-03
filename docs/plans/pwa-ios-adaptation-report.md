# Informe: adaptación del frontend a PWA de iPhone

## Veredicto

**Lista para revisarse en un dispositivo. No lista para producción.** Falta una
cosa y es de infraestructura: `nginx.conf` sirve por HTTP plano, y sin un origen
HTTPS `navigator.serviceWorker.register` se rechaza en cualquier iPhone que no
sea `localhost`. Sin worker no hay instalación, ni arranque sin red, ni nada de
lo que sostiene esta capa. Todo lo verificado abajo se midió sobre `localhost`,
que es la excepción de contexto seguro.

Lo segundo, y no es un defecto sino un límite honesto de cómo se ha hecho esto:
**nadie ha visto las pantallas autenticadas con datos reales.** Ni un agente ni
una persona. Hacía falta una contraseña y no se ha usado ninguna.

---

## Qué cambió

De una SPA de escritorio —barra lateral, tabla de catorce columnas, fuente de
13 px— a una PWA instalable pensada para 390 pt.

| | |
|---|---|
| Capa PWA | `index.html` con metadatos de iOS y `viewport-fit=cover`, `public/manifest.json`, cuatro iconos, `public/sw.js` con lista blanca, registro solo en producción |
| Navegación | Barra de pestañas inferior + ruta «Más». La barra lateral hacía `display: none` por debajo de 860 px **sin sustituto**: la app era innavegable en un móvil |
| Sistema de diseño | Tokens táctiles, tipografía de móvil, objetivo de 44 pt, áreas seguras, modo oscuro completo, primitivo `.record-*` de lista |
| Pantallas | Ofertas, Modelos, Dealers, API keys, Analítica y la matriz de captación, todas con lista táctil |
| Servidor | `sw.js` exento de la caché inmutable; una sola cabecera `Cache-Control` en los assets |

### Tablas: ninguna llega al móvil como tabla

Requisito explícito del propietario del producto: en el móvil, o una columna, o
una lista. Nunca una tabla que se arrastra de lado.

| Pantalla | Antes | En táctil |
|---|---|---|
| Ofertas | tabla de 14 columnas | `<ul class="offer-list">` |
| Modelos | tabla de 11 columnas | `<ul class="record-list">`; la fila abre el panel del grupo |
| Dealers | tabla de 8 columnas | `<ul class="record-list">` |
| API keys | tabla de 6 columnas | `<ul class="record-list">` |
| Analítica | matriz métricas × binomios | un bloque por binomio |
| Captación | matriz modelos × fuentes | una tarjeta por modelo, fuentes como interruptores |

En los seis casos es marcado distinto detrás de `useTouchLayout()`, no una tabla
desmontada con `display: block` —eso le quita la semántica al lector de pantalla
sin avisar—. El umbral de 860 px es una constante única que comparten la hoja de
estilos y el hook. El escritorio no cambia.

---

## Bloqueantes que quedan

1. **HTTPS.** Descrito arriba. Es la única razón por la que esto no puede ir a
   producción hoy. Ya estaba anotado en el blueprint §8.5; se repite aquí porque
   la pregunta de la puerta era «¿es esto de verdad una PWA instalable en iOS?»
   y hoy, tal y como se despliega, no lo es.
2. **La barra de pestañas pierde su cuarto destino con el zoom de página al 200 %.**
   Medido: 4 × 64 px = 256 px de mínimo contra 195 px de ancho de maquetación; el
   cuarto elemento se dibuja fuera de pantalla y no se puede desplazar hasta él.
   Ese cuarto elemento es «Más», que es donde viven Dealers, Ajustes, API keys y
   **Cerrar sesión**. En el suelo de 320 px de la regla 1.4.10 todo entra, así que
   no es un fallo de Reflow, pero deja a quien amplía sin la mitad de la app.
3. **Nadie ha visto las pantallas autenticadas.** No es un defecto conocido: es
   la ausencia de una comprobación. Media hora de alguien con credenciales, a
   390 pt, recorriendo login → lista → filtros → detalle → salida al anuncio.

---

## Lo que se arregló durante la validación

Las puertas encontraron esto y se corrigió y verificó en el momento.

**Bloqueante · El shell se podía envenenar.** Cualquier navegación de primer
nivel a un recurso del propio origen que no fuera HTML —un enlace profundo a
`/manifest.json`— es `mode: "navigate"`, devolvía 200 y se guardaba bajo la clave
canónica `/index.html`. A partir de ahí el arranque sin red servía ese JSON como
si fuera la app, y en modo instalado no hay barra de direcciones ni botón de
recarga con los que salir. Se añadió la guarda de tipo de contenido y se
reprodujo el ataque completo sobre un build de producción: el shell aguanta, y
con el servidor parado la app sigue arrancando.

**Sesión sin salida.** Un 401 después de un refresh *correcto* caía al `throw`
genérico sin borrar los tokens ni avisar: la app se quedaba dentro del armazón de
sesión iniciada repitiendo «la sesión ha caducado» sin ruta de vuelta al login.

**Sin red bajo React.** No había *error boundary*. Un error de render dejaba la
pantalla en blanco, y en modo instalado eso no tiene salida —«Recargar la app»
vive dentro del árbol que acaba de morir—. Se añadió y se comprobó inyectando un
error de verdad.

**Nada se anunciaba.** `Banner` y `Loading` no tenían rol. Un error de login era
un bloque rojo y silencio absoluto: quien usa VoiceOver no tenía forma de saber
que el intento había fallado. Ahora `role="alert"` para los errores y
`role="status"` para el resto, y la pila de avisos se monta vacía en vez de
aparecer junto a su texto, que es el patrón que los lectores se saltan.

**Tres chips incumplían «Label in Name» (2.5.3).** Se veía `12.000 € – 30.000 €`
y se anunciaba «Quitar la banda de precio»: por voz no se podía tocar, y el
anuncio se callaba el dato que estaba filtrando.

**La fila de oferta leía cuatro cifras sin unidades** —«24.590 € −8,2 % 72 3»—
con las explicaciones colgadas de `aria-label` en elementos sin rol, donde ARIA
no permite nombrar. Ahora van en texto oculto, que es el patrón que el propio
repositorio ya usaba en Modelos.

**El único control destructivo del riel era el que no tenía borde visible**
(1,33:1). Usaba `--border-strong`, que la cabecera de tokens marca explícitamente
como decorativo, en vez de `--border-control`, que es el que delimita controles.

**Dos animaciones de scroll se escapaban de `prefers-reduced-motion`**, porque
`scrollTo({behavior:"smooth"})` no pasa por CSS. Y un candado de movimiento
reducido estaba escrito *antes* de la regla que apagaba: como una media query no
añade especificidad, no se aplicaba nunca.

**Duplicación de CSS.** Los paquetes de función no eran dueños de `styles.css`,
así que inyectaban ~630 líneas en tiempo de ejecución desde el JS. Se portaron a
la hoja y se retiró la inyección. Antes de borrar nada se comparó propiedad por
propiedad: de 107 selectores, uno no estaba cubierto —`.offer-preview.static` es
un `<figure>`, y solo el CSS inyectado le quitaba el margen que le pone el
navegador; borrar a ciegas habría devuelto 40 px por lado en una pantalla de 390.

---

## Aplazado por decisión

Hallazgos reales, no bloqueantes, con su razón para esperar:

- El aviso global de versión nueva que pide el blueprint §8.4 no existe; solo
  está la fila en «Más». O se implementa o se corrige el §8.4.
- Los bundles no están en el precaché: el primer arranque sin red se apoya en la
  caché HTTP del navegador, que iOS desaloja antes que Cache Storage.
- El manifest no puede expresar un color de arranque oscuro, así que quien use
  modo oscuro ve un destello casi blanco al abrir.
- Segunda salida externa dentro de la hoja de detalle, sin la opción de copiar
  enlace que sí tiene la principal. El enlace a `/docs` expulsa a Safari en modo
  instalado.
- El foco no se confina en las hojas: `aria-modal` cubre al lector de pantalla,
  pero con teclado se sale por detrás del fondo.
- `role="listbox"` y `role="radiogroup"` sin su modelo de teclado: se anuncian
  como un widget y se comportan como una pila de botones. O se implementa el
  patrón o se quitan los roles.
- Quedan explicaciones en `title` en la ruta táctil, donde no hay forma de
  consultarlas.
- Tras descartar una oferta el foco cae al `<body>` y el cursor de lectura vuelve
  al principio de la página.

---

## Cobertura

**Verificado ejecutándolo:** el build y las tres puertas deterministas; el worker
sobre un build de producción tras nginx real, con un backend simulado que
devolvía secretos marcados —cero apariciones en ninguna caché—; el cierre de
sesión pulsado en la interfaz; el arranque sin red con el servidor parado; el
ataque de envenenamiento del shell, antes y después del arreglo; el *error
boundary* con un error inyectado; los iconos decodificados píxel a píxel; la
geometría táctil y el contraste medidos con `getComputedStyle` sobre la hoja real
en ambos temas; la pantalla de login a 390×844.

**Razonado desde el código, no observado:** todo lo que hay detrás del login. El
comportamiento real en modo instalado —sin botón de atrás, sin recarga, y si
`target="_blank"` abre el navegador interno o expulsa a Safari—. Las áreas
seguras, que en el emulador valen 0. El service worker de WebKit, que difiere del
de Chromium en desalojo y en tiempos. Los anuncios exactos de VoiceOver.

---

## Números

Cifras de `npm run check:budgets`, que es la puerta. No coinciden exactamente con
las que imprime vite: el script comprime a nivel 9 y suma la carga real de
arranque —módulo de entrada más sus `modulepreload`—, no el tamaño suelto de cada
chunk.

| | Punto de partida | Ahora | Presupuesto |
|---|---|---|---|
| `check:pwa` | 5/23 · 10 errores | **47/47 · 0 errores** | 0 errores |
| JS inicial (gzip) | 189,3 KB | **88,9 KB** | 140 KB |
| CSS inicial (gzip) | 8,8 KB | 12,4 KB | 24 KB |
| Arranque total (gzip) | 198,1 KB | **101,3 KB** | 160 KB |
| Mayor chunk diferido | 25,3 KB | 118,5 KB | 120 KB |
| Precaché total | — | 237,4 KB | 1200 KB |

El arranque cabe con holgura: 88,9 KB contra 140. Lo que abrió ese hueco fue
sacar recharts del chunk de entrada —la ruta por defecto lo arrastraba a través
de `components/charts`, anulando el `lazy()` de Analítica—, que es exactamente lo
que el presupuesto se fijó para forzar.

El que va justo es el chunk diferido de Analítica: **118,5 de 120 KB**, un KB y
medio de margen, y la conversión táctil se comió la mayor parte. Está dentro,
pero la próxima métrica lo rompe. La palanca está dentro del paquete de gráficos,
no en el número del presupuesto: subir el límite para que pase es la regresión
que el propio validador de rendimiento trata como hallazgo bloqueante.

Tres comprobaciones nuevas congelan lo que ya se rompió una vez: `css.orphan-classes`
(una clase sin ninguna regla), `layout.no-mobile-table` (una tabla que llega al
teléfono sin alternativa táctil) y `sw.cache-put-allowlist` con sus dos hermanas
(`cache.put` fuera de los dos ayudantes revisados, la exclusión de `/api/`, la
guarda de HTML del shell). Las seis se han probado en negativo: fallan cuando se
introduce la regresión que vigilan.

---

## Siguiente, por orden

1. Un origen HTTPS. Sin esto nada de la capa PWA existe en un teléfono.
2. Media hora con credenciales a 390 pt: login → lista → filtros → detalle →
   salida al anuncio → volver. Es el hueco de cobertura más grande que queda.
3. La barra de pestañas por debajo de 256 px de ancho de maquetación.
4. Sacar peso del chunk de Analítica hasta volver dentro de presupuesto.
5. El resto de la lista de aplazados, por su orden.
