# Product

## Register

product

## Users

Una sola persona: quien mantiene el proyecto, buscando coche. Entra con una
pregunta concreta ("¿ha bajado algo interesante?"), barre decenas de ofertas
seguidas en la tabla, abre las que le llaman y decide en segundos si merece la
pena ir al anuncio original.

No hay onboarding que diseñar ni usuarios que convencer: quien usa la app la
escribió. La autenticación existe sobre todo porque el scraper necesita API keys,
y los favoritos y modelos seguidos son por usuario porque el esquema ya lo
permite, no porque haya un equipo detrás.

El contexto de uso es un portátil, de noche, con muchas pestañas abiertas.
Densidad y velocidad ganan a explicaciones.

## Product Purpose

Agregar ofertas de coches de varios dealers, calcular métricas de valor
deterministas y rankearlas con un agente de IA.

El éxito es encontrar antes un buen precio que mirando los portales a mano. La
plataforma existe porque los portales de coches optimizan para que mires
anuncios, no para que compares: aquí la mediana del modelo, la desviación sobre
ella y el historial de precios son ciudadanos de primera.

## Brand Personality

Instrumento, callado, denso. Linaje Twenty CRM / Linear: la herramienta
desaparece dentro de la tarea. Nada celebra, nada persuade, nada urge. El tono de
la copy es de nota técnica en español: enuncia el dato y calla.

## Anti-references

- **Portales de coches de consumo** (Coches.net, AutoScout24, Wallapop Motor):
  fotos gigantes, insignias de urgencia, «¡CHOLLO!», carruseles, precios en rojo
  parpadeante. Todo lo que empuja a mirar en vez de a comparar.
- **Chrome de dashboard SaaS**: tiles de métrica con degradado, ilustraciones en
  los estados vacíos, tarjetas anidadas, iconos de colores por sección.
- **Cualquier cosa que decore un número.** Si un valor necesita un degradado para
  parecer importante, el problema es la jerarquía, no el color.

## Design Principles

- **La tabla enseña la identidad, el panel enseña el resto.** Las columnas son lo
  que sirve para comparar de un vistazo; el detalle vive en el panel y se pide
  bajo demanda.
- **El veredicto primero, la evidencia después.** El panel de detalle responde
  «¿merece la pena abrir esto?» antes de contar de qué coche se trata.
- **Determinismo y IA se muestran aparte.** `value_score` es la señal de la casa;
  la puntuación del agente es independiente. Si discrepan, eso es información y
  se ve.
- **La densidad es una cortesía.** Se barren decenas de ofertas por sesión. El
  espacio en blanco se gasta en separar grupos, no en airear filas.
- **Los datos de diagnóstico no compiten con los datos de decisión.** Procedencia,
  IDs de origen y payload del scraper existen y se consultan, pero plegados.

## Accessibility & Inclusion

Objetivo WCAG 2.1 AA en contraste y foco. Ya en uso: `.sr-only` para cabeceras de
columna sin texto, `aria-pressed` en el toggle de favorito, `aria-label` en los
botones de icono, foco visible con `:focus-visible` sobre las filas.

Sin requisitos de accesibilidad conocidos más allá de eso, pero la app es
teclado-primero por diseño: las filas se abren con Enter/Espacio y la navegación
se pliega con ⌘/Ctrl+B.
