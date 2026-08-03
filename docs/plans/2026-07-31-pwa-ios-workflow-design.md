# Diseño: workflow multiagente para adaptar el frontend a PWA de iPhone

## Objetivo

Convertir el frontend de escritorio en una PWA instalable y bien resuelta en un
iPhone, mediante un workflow reproducible en vez de una sesión manual. El
workflow es el entregable: doce agentes especializados, un grafo de seis fases
con barreras explícitas, y validaciones que se ejecutan como comandos y no como
opiniones.

El punto de partida está medido, no supuesto:

- No hay manifest, ni iconos, ni service worker, ni metadatos de iOS.
- La navegación es una barra lateral que hace `display: none` por debajo de
  860 px **sin sustituto**: en un móvil la aplicación es innavegable.
- La fuente base son 13 px, así que los campos de formulario caen por debajo del
  umbral de 16 px y Safari hace zoom al enfocarlos.
- `src/pages/Offers.tsx` —la ruta por defecto, ~1900 líneas— importa
  `../components/charts`, que arrastra recharts + d3 al chunk de entrada y anula
  el `lazy()` de Analytics. El arranque son 189,3 KB de JS comprimido.
- La regla `immutable` de `nginx.conf` casa con cualquier `.js`, incluido el
  futuro `sw.js`: serviría un worker caducado durante 30 días.
- Las ofertas enlazan a webs de dealers; en modo standalone esos enlaces expulsan
  al usuario a Safari.

## El grafo

```
                    ┌─ pwa-ios-auditor ───────┐
   Discovery        ├─ mobile-pattern-scout ──┤   tres carriles independientes
                    └─ pwa-platform-analyst ──┘
                                 │  barrera: el plan necesita los tres a la vez
                                 ▼
   Blueprint        minimalist-design-director ──▶ docs/plans/pwa-ios-blueprint.md
                                 │  validación en código: un único paquete
                                 │  foundation, ids únicos, criterios de
                                 │  aceptación presentes, ficheros disjuntos
                                 ▼
   Foundation       pwa-shell-engineer ──▶ package-verifier ──┐
                                 ▲                            │ falla
                                 └──────── repair ◀───────────┘
                                 │  puerta dura: si no pasa, no se abanica nada
                                 ▼
   Features         pipeline (sin barrera entre etapas)
                    pkg A: build ──▶ verify ──▶ (repair ──▶ verify)
                    pkg B: build ──▶ verify ...          B verifica mientras C
                    pkg C: build ──▶ verify ...          todavía se implementa
                                 │  barrera: el informe reconcilia todo
                                 ▼
   Gates            ┌─ ios-hig-validator ────────┐
                    ├─ mobile-a11y-validator ────┤   cuatro lentes en paralelo
                    ├─ mobile-perf-validator ────┤   sobre la app terminada
                    └─ pwa-compliance-validator ─┘
                                 ▼
   Report           pwa-release-critic ──▶ docs/plans/pwa-ios-adaptation-report.md
```

Las barreras están donde hacen falta y en ningún otro sitio. Blueprint necesita
los tres carriles a la vez. Foundation es secuencial porque posee todas las
superficies compartidas —`index.html`, `styles.css`, el shell, el manifest, el
worker, `vite.config.ts`, `nginx.conf`— y todo lo demás se apoya en ellas. Las
features van en `pipeline`, sin sincronizar etapas: un paquete se verifica
mientras el siguiente todavía se está implementando.

## Los agentes

| Agente | Papel |
|---|---|
| `pwa-ios-auditor` | Audita lo que hoy se rompe en un iPhone. Solo lectura, cada hallazgo con `file:line`. |
| `mobile-pattern-scout` | Inspiración. Investiga cómo resuelven estos problemas las apps móviles mejor diseñadas y **elige una** por problema. |
| `pwa-platform-analyst` | Restricciones de build, servidor, contenedor, API e iOS. Produce la tabla de cacheabilidad por ruta. |
| `minimalist-design-director` | Funde los tres carriles en una especificación con valores cerrados y un plan particionado por propiedad de ficheros. |
| `pwa-shell-engineer` | Implementa la base: manifest, iconos, worker, metadatos iOS, safe areas, tokens, shell y navegación. |
| `mobile-ui-implementer` | Implementa un paquete de features con las buenas prácticas móviles como no negociables. |
| `package-verifier` | Puerta adversarial por paquete: build, propiedad de ficheros, criterios de aceptación, regresiones. |
| `ios-hig-validator` | Geometría táctil, jerarquía, alcance del pulgar y fidelidad al diseño, medidos en el navegador. |
| `mobile-a11y-validator` | Semántica, lector de pantalla, contraste, foco, escalado de texto. |
| `mobile-perf-validator` | Presupuestos de arranque, composición de chunks, tareas largas, coste de scroll. |
| `pwa-compliance-validator` | Instalabilidad, iconos, corrección del worker, seguridad de la caché, offline. |
| `pwa-release-critic` | Reconcilia todo, busca lo que nadie miró y escribe el informe con veredicto. |

Los tres carriles de descubrimiento están separados a propósito: el que audita
lo que hay no debe estar buscando inspiración a la vez, y el que investiga
patrones no debe estar limitado por lo que el código actual ya hace.

## Las validaciones

Tres capas, de la más barata a la más cara.

**1. En código, sin agentes.** El script del workflow valida el plan antes de
gastar un solo agente en construir: exactamente un paquete `foundation`, ids sin
duplicar, criterios de aceptación presentes, y sobre todo **propiedad de
ficheros disjunta**. Si dos paquetes reclaman el mismo fichero gana el primero,
el segundo lo pierde y el conflicto se registra en el log; un paquete que se
queda sin ficheros se descarta. Es lo que hace segura la concurrencia de la fase
de features, y se aplica en vez de confiarse.

**2. Deterministas, como comandos.** Dos scripts sin dependencias que cualquiera
puede ejecutar fuera del workflow:

```bash
cd frontend && npm run validate:mobile
```

- `npm run check:pwa` — 44 comprobaciones estáticas: viewport y `viewport-fit`,
  zoom no bloqueado, metadatos de iOS, campos del manifest, existencia real de
  los iconos declarados, registro del worker, la trampa de caché de `nginx.conf`
  sobre `sw.js`, `env(safe-area-inset-*)`, `100vh`, y el tamaño de fuente de los
  campos de entrada parseando las reglas CSS.

  Dos de esas comprobaciones existen porque el propio workflow entregó el fallo
  que detectan, y las dos son bloqueantes:

  - `css.orphan-classes` — una clase que usa un componente y que no tiene ni una
    regla en ninguna hoja. Compila, pasa el typecheck y la pantalla sale desnuda.
    Ocurrió: los paquetes de función escribieron cuatro componentes nuevos
    mientras `styles.css` era de la fundación, y acabaron inyectando ~630 líneas
    de CSS en tiempo de ejecución desde el JS para esquivar la propiedad.
  - `layout.no-mobile-table` — una tabla de escritorio que llega al teléfono como
    tabla con scroll horizontal. Se exige marcado distinto detrás del gate táctil;
    desmontar la tabla con `display: block` no cuenta, porque pierde la semántica
    sin avisar.
- `npm run check:budgets` — mide en gzip la carga de arranque (módulo de
  entrada, sus `modulepreload` y su hoja de estilos) contra
  `frontend/perf-budgets.json`. Hoy: 189,3 KB de JS inicial contra un límite de
  140 KB. El límite está fijado para que sacar recharts de la ruta por defecto
  sea obligatorio; subirlo para que pase es, por instrucción explícita del
  validador de rendimiento, un hallazgo bloqueante.

**3. Por agente, adversarial.** Cada paquete pasa por `package-verifier`, que
reejecuta los comandos en vez de creerse el informe del implementador y compara
el diff contra la lista de ficheros del paquete. Un fallo devuelve una lista de
puntos bloqueantes concretos a un ciclo de reparación acotado (1 ronda en
`standard`, 2 en `deep`). Al final, cuatro lentes independientes juzgan la app
entera, y el crítico de cierre busca lo que ninguna de ellas tenía asignado.

Todas las fronteras entre agentes están tipadas con JSON Schema, así que ninguna
etapa parsea prosa de la anterior.

## Ejecución

```bash
# Requiere que el usuario pida explícitamente la orquestación multiagente.
Workflow({ scriptPath: ".claude/workflows/pwa-ios.js" })
Workflow({ scriptPath: ".claude/workflows/pwa-ios.js", args: { scale: "deep" } })
Workflow({ scriptPath: ".claude/workflows/pwa-ios.js", args: { scale: "lean", only: ["pwa", "perf"] } })
```

Se invoca por ruta, no por nombre: el registro de workflows con nombre solo
resuelve los integrados y los de plugins.

El workflow tampoco vincula los agentes por nombre de registro. El registro se
carga al arrancar la sesión, así que un rol recién escrito no existiría hasta
reiniciarla. En su lugar cada tarea se lanza como `general-purpose` con una
primera instrucción que apunta a su propia definición: *«tus instrucciones están
en `.claude/agents/<rol>.md`, léelo y síguelo al pie de la letra»*. Un único
origen de la verdad, y el workflow arranca sin reiniciar nada.

| `scale` | Paquetes de features | Lentes | Reparaciones | Agentes aprox. |
|---|---|---|---|---|
| `lean` | 2 | hig, pwa | 1 | ~12 |
| `standard` (por defecto) | 3 | las cuatro | 1 | ~16 |
| `deep` | 5 | las cuatro | 2 | ~22 |

Los paquetes planificados que no caben en la escala elegida no desaparecen en
silencio: quedan en el blueprint y el log dice cuántos se aplazaron.

## Errores y seguridad

- Ningún agente edita ficheros fuera de la lista de su paquete. Si necesita otro,
  lo declara en `blocked_on` y se detiene.
- Ninguna respuesta autenticada puede escribirse en una caché que sobreviva al
  cierre de sesión ni que se comparta entre cuentas. Es una restricción de
  seguridad y `pwa-compliance-validator` la trata como bloqueante.
- Perder funcionalidad en silencio al adaptar una pantalla es el fallo que este
  workflow existe para impedir: lo que se elimina va en `dropped[]` con su razón,
  y el verificador diffea lo eliminado.
- La adaptación no puede empeorar el escritorio; los verificadores comprueban
  ambos anchos.
- Lo que solo se puede verificar en un iPhone real —render en el dispositivo,
  comportamiento instalado, notificaciones— se declara como no verificado en el
  informe en vez de darse por bueno.

## Verificación de este diseño

- `node --check` sobre el script del workflow (envuelto en su contexto async) y
  sobre ambos scripts de validación: correcto.
- Los doce `agentType` referenciados por el workflow resuelven contra los doce
  ficheros de `.claude/agents/`.
- `npm run check:pwa` y `npm run check:budgets` se ejecutan y salen con código 1
  sobre el estado actual, que es la línea base roja que el workflow debe cerrar.

## Nota

`.claude` está en `.gitignore`, así que los agentes y el workflow no viajan con
el repositorio. Si se quiere compartirlos con el equipo hay que exceptuar
`.claude/agents/` y `.claude/workflows/` en `.gitignore`.
