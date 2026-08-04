import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api } from "../lib/api";
import { slugify } from "../lib/slug";
import type {
  CarModelGroup,
  ScrapeAccess,
  ScrapeSource,
  ScrapeTarget,
  ScrapeTargetSelection,
} from "../types";
import { useTouchLayout } from "./SwipeRow";
import { Banner, Drawer, Empty, Loading, Toggle } from "./ui";

const pairKey = (sourceId: number, modelKey: string) => `${sourceId}:${modelKey}`;

/** Los espacios de sobra fuera: « Audi   A3 » y «Audi A3» son el mismo modelo. */
const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/**
 * Espejo de `canonical_make_model_key` del backend: `marca|modelo` en minúsculas.
 *
 * Se calcula aquí para que un modelo recién escrito caiga en la misma casilla
 * que el target que el servidor creará con él. Sin esa coincidencia, al reabrir
 * el panel la fila saldría dos veces: la que se escribió y la que volvió.
 */
const modelKey = (make: string, model: string) =>
  `${collapse(make).toLowerCase()}|${collapse(model).toLowerCase()}`;

/** Qué implica cada modo de acceso para quien está dando de alta el portal. */
const ACCESS_HINTS: Record<ScrapeAccess, string> = {
  fetch:
    "El portal sirve el HTML ya montado. Es lo más rápido y lo más barato, y se somete a robots.txt.",
  playwright:
    "El listado se pinta con JavaScript. El scraper lo abre con Playwright y, si no puede, con el navegador.",
  browser:
    "Hace falta un navegador real. Resérvalo para lo que Playwright no consigue leer.",
  manual:
    "El sitio prohíbe el acceso automatizado. Sus combinaciones se guardan, pero no se rastrean.",
};

/**
 * Una fila de la matriz: un binomio marca-modelo que el scraper puede buscar.
 *
 * No sale solo del catálogo. Lo que el scraper sigue vive en `scrape_targets`,
 * que no apunta a `car_models`: un modelo puede estar en captación mucho antes
 * de que exista una sola oferta suya, y hasta entonces el catálogo no tiene
 * grupo del que salga su fila. Si la matriz mirara solo al catálogo, esas filas
 * no se verían **y al guardar se apagarían sin decirlo**, porque guardar
 * reemplaza la selección entera.
 */
interface ModelRow {
  key: string;
  make: string;
  model: string;
  label: string;
  /** `catalog`: está en el catálogo. `target`: solo en captación. `new`: sin guardar. */
  origin: "catalog" | "target" | "new";
}

/** Lo que se acaba de escribir primero; el resto, por orden alfabético. */
const compareRows = (a: ModelRow, b: ModelRow) =>
  (a.origin === "new" ? 0 : 1) - (b.origin === "new" ? 0 : 1) ||
  a.label.localeCompare(b.label, "es");

/** El catálogo y la captación, en una sola lista de filas sin repetidos. */
function mergeRows(groups: CarModelGroup[], targets: ScrapeTarget[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const group of groups) {
    rows.set(group.key, {
      key: group.key,
      make: group.make,
      model: group.model,
      label: group.label,
      origin: "catalog",
    });
  }
  for (const target of targets) {
    if (rows.has(target.make_model_key)) continue;
    rows.set(target.make_model_key, {
      key: target.make_model_key,
      make: target.make,
      model: target.model,
      label: `${target.make} ${target.model}`,
      origin: "target",
    });
  }
  return [...rows.values()].sort(compareRows);
}

/** El campo puede quedarse vacío mientras se teclea; lo que se envía, no. */
const clampLimit = (value: number) =>
  Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 15;

export function ScrapingConfigDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sources, setSources] = useState<ScrapeSource[]>([]);
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [maxPerTarget, setMaxPerTarget] = useState(15);
  const [search, setSearch] = useState("");
  const [newMake, setNewMake] = useState("");
  const [newModel, setNewModel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // `null` = cerrado. `{ source: null }` = alta de un portal nuevo.
  const [editingSource, setEditingSource] = useState<{ source: ScrapeSource | null } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const makeInput = useRef<HTMLInputElement>(null);
  const touch = useTouchLayout();

  useEffect(() => {
    let active = true;
    Promise.all([
      // Las inactivas también: son las columnas que faltan de la matriz, y el
      // único sitio desde el que se pueden volver a encender. Sin ellas, apagar
      // una fuente por error sería un callejón sin salida fuera de la API.
      api.get<ScrapeSource[]>("/scraping/sources", { include_inactive: true }),
      api.get<ScrapeTarget[]>("/scraping/targets"),
      api.get<CarModelGroup[]>("/car-models/groups"),
    ])
      .then(([nextSources, targets, groups]) => {
        if (!active) return;
        setSources(nextSources);
        setRows(mergeRows(groups, targets));
        setSelected(
          new Set(targets.map((target) => pairKey(target.source_id, target.make_model_key))),
        );
        if (targets[0]) setMaxPerTarget(targets[0].max_results);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "No se pudo cargar el rastreo");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  /** Solo las activas tienen columna: el PUT rechaza targets de fuentes apagadas. */
  const activeSources = useMemo(() => sources.filter((source) => source.is_active), [sources]);

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("es");
    if (!needle) return rows;
    return rows.filter((row) => row.label.toLocaleLowerCase("es").includes(needle));
  }, [rows, search]);

  /**
   * Las combinaciones que se van a rastrear, que son exactamente las que envía
   * `save()`. No es `selected.size`: ahí puede haber casillas de una fuente que
   * se apagó —siguen guardadas, para cuando vuelva— y esas no son búsquedas de
   * este run.
   */
  const selectedCount = useMemo(
    () =>
      rows.reduce(
        (total, row) =>
          total +
          activeSources.filter((source) => selected.has(pairKey(source.id, row.key))).length,
        0,
      ),
    [rows, activeSources, selected],
  );

  function toggle(sourceId: number, key: string) {
    const pair = pairKey(sourceId, key);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(pair)) next.delete(pair);
      else next.add(pair);
      return next;
    });
  }

  function toggleRow(row: ModelRow) {
    const keys = activeSources.map((source) => pairKey(source.id, row.key));
    const allSelected = keys.every((key) => selected.has(key));
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  /**
   * Añade un binomio a la captación.
   *
   * No toca el catálogo a propósito: `car_models` está partido por acabado y lo
   * puebla la ingesta con el acabado que traiga cada oferta. Crear aquí una
   * versión de acabado vacío dejaría en «Modelos» una fila fantasma que no va a
   * tener ofertas nunca. Lo que hace que el scraper busque un modelo es el
   * target, y eso es exactamente lo que se guarda.
   */
  function addModel(event: FormEvent) {
    event.preventDefault();
    const make = collapse(newMake);
    const model = collapse(newModel);
    if (!make || !model) return;

    const key = modelKey(make, model);
    const existing = rows.find((row) => row.key === key);
    if (existing) {
      setAddError(`«${existing.label}» ya está en la lista. Marca sus dealers en la matriz.`);
      setSearch("");
      return;
    }

    setRows((current) =>
      [...current, { key, make, model, label: `${make} ${model}`, origin: "new" as const }].sort(
        compareRows,
      ),
    );
    // Un modelo se añade aquí para buscarlo, así que nace marcado en todos los
    // dealers activos: desmarcar los que sobren es menos trabajo que marcar
    // cinco casillas a mano, y explica por qué la fila aparece llena.
    setSelected((current) => {
      const next = new Set(current);
      for (const source of activeSources) next.add(pairKey(source.id, key));
      return next;
    });
    setNewMake("");
    setNewModel("");
    setAddError(null);
    // El filtro se limpia: una fila nueva escondida detrás de una búsqueda que
    // no la nombra parecería que el botón no ha hecho nada.
    setSearch("");
    makeInput.current?.focus();
  }

  /** Descarta una fila recién escrita. Las que ya están guardadas se desmarcan. */
  function dropRow(row: ModelRow) {
    setRows((current) => current.filter((other) => other.key !== row.key));
    setSelected((current) => {
      const next = new Set(current);
      for (const source of sources) next.delete(pairKey(source.id, row.key));
      return next;
    });
  }

  /**
   * Un portal recién creado o corregido entra en la lista sin recargar nada.
   *
   * Al apagarlo se queda sin columna, pero **sus casillas marcadas no se
   * borran**: `save()` solo envía las de fuentes activas y el servidor conserva
   * los targets de las apagadas, así que volver a encenderlo —aquí mismo o
   * dentro de un mes— devuelve la fila tal y como estaba.
   */
  function sourceSaved(saved: ScrapeSource) {
    setSources((current) =>
      (current.some((source) => source.id === saved.id)
        ? current.map((source) => (source.id === saved.id ? saved : source))
        : [...current, saved]
      ).sort((a, b) => a.name.localeCompare(b.name, "es")),
    );
    setEditingSource(null);
  }

  async function save() {
    setSaving(true);
    setError(null);

    const targets: ScrapeTargetSelection[] = [];
    for (const row of rows) {
      for (const source of activeSources) {
        if (!selected.has(pairKey(source.id, row.key))) continue;
        targets.push({
          source_id: source.id,
          make: row.make,
          model: row.model,
        });
      }
    }

    try {
      await api.put("/scraping/targets", {
        max_per_target: clampLimit(maxPerTarget),
        targets,
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el rastreo");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      title="Configurar captación"
      subtitle={`${selectedCount} combinaciones activas · configuración global`}
      onClose={onClose}
      wide
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {loading ? (
        <Loading label="Cargando modelos y fuentes…" />
      ) : (
        /* Un `div` y no un `form`: dentro hay un formulario propio —el alta de
           un modelo— y los formularios no se anidan. De paso, `Enter` en el
           buscador deja de guardar la configuración entera. */
        <div className="scrape-config">
          <div className="scrape-config-intro">
            <div>
              <p className="card-title">Qué debe buscar el scraper</p>
              <p className="tiny muted">
                Marca cada combinación de modelo y dealer. La captación intentará completar
                la cantidad indicada; no elegirá solo las ofertas que parezcan mejores.
              </p>
            </div>
            <div className="field scrape-limit">
              <label htmlFor="scrape-limit">Resultados por combinación</label>
              <input
                id="scrape-limit"
                className="input"
                type="number"
                min={1}
                max={100}
                value={maxPerTarget}
                onChange={(event) => setMaxPerTarget(Number(event.target.value))}
              />
            </div>
          </div>

          {/* Los dealers, arriba de la matriz: son sus columnas, y este es el
              único sitio donde se dan de alta y se corrigen. Se listan en las dos
              maquetaciones —en táctil no hay cabecera de tabla que los enseñe— y
              cada uno abre su ficha, que es también donde se apagan. */}
          <section className="scrape-sources">
            <div className="scrape-sources-head">
              <p className="card-title">
                Dealers y portales{" "}
                <span className="tiny muted">
                  {activeSources.length} activos de {sources.length}
                </span>
              </p>
              <div className="spacer" />
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => setEditingSource({ source: null })}
              >
                Añadir dealer
              </button>
            </div>
            {sources.length === 0 ? (
              <p className="tiny muted" style={{ margin: 0 }}>
                Todavía no hay ningún portal. Añade el primero para poder marcar
                combinaciones.
              </p>
            ) : (
              <div className="scrape-source-chips">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className={`scrape-source-chip${source.is_active ? "" : " off"}`}
                    title={`Editar ${source.name}`}
                    onClick={() => setEditingSource({ source })}
                  >
                    <span className="sr-only">Editar </span>
                    <span className="scrape-source-name">{source.name}</span>
                    <small>{source.is_active ? source.access : "inactiva"}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* El alta de un modelo es su propio formulario: dos campos, `Enter`
              que añade y validación nativa de obligatorios, sin heredar el envío
              del panel. */}
          <form className="scrape-add" onSubmit={addModel}>
            <div className="field grow">
              <label htmlFor="scrape-new-make">Marca</label>
              <input
                id="scrape-new-make"
                ref={makeInput}
                className="input"
                required
                autoComplete="off"
                placeholder="Toyota"
                value={newMake}
                onChange={(event) => setNewMake(event.target.value)}
              />
            </div>
            <div className="field grow">
              <label htmlFor="scrape-new-model">Modelo</label>
              <input
                id="scrape-new-model"
                className="input"
                required
                autoComplete="off"
                placeholder="Corolla"
                value={newModel}
                onChange={(event) => setNewModel(event.target.value)}
              />
            </div>
            <button className="btn btn-sm" type="submit">
              Añadir modelo
            </button>
          </form>
          <p className="tiny muted scrape-add-hint">
            Se añade a la captación marcado en todos los dealers; desmarca los que no lo
            vendan. En «Modelos» aparecerá cuando llegue su primera oferta.
          </p>
          {addError ? <Banner kind="warn">{addError}</Banner> : null}

          <div className="field">
            <label htmlFor="scrape-model-search">Buscar modelo</label>
            <input
              id="scrape-model-search"
              className="input"
              type="search"
              placeholder="Audi A3, Montero…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {activeSources.length === 0 ? (
            <Empty
              title="No hay dealers activos"
              hint="Añade un portal ahí arriba —o vuelve a activar uno— para poder marcar combinaciones."
            />
          ) : visibleRows.length === 0 ? (
            <Empty
              title="No hay modelos que coincidan"
              hint={
                rows.length === 0
                  ? "Añade el primero con «Añadir modelo»."
                  : "Prueba con otra búsqueda, o añade el modelo si todavía no está."
              }
            />
          ) : touch ? (
            /* La matriz es lo único de la app que es 2D de verdad: modelos por
               fuentes. En 390 pt no cabe, y arrastrarla de lado para marcar una
               casilla es el peor gesto posible. Así que se pivota: un modelo por
               tarjeta y sus fuentes como interruptores dentro. Se pierde la
               lectura en columna —comparar una fuente entre modelos— y se gana la
               única operación que se hace aquí de verdad, que es marcar. */
            <ul className="record-list">
              {visibleRows.map((row) => {
                const rowKeys = activeSources.map((source) => pairKey(source.id, row.key));
                const active = rowKeys.filter((key) => selected.has(key)).length;
                const allSelected = active === activeSources.length;
                return (
                  <li className="record-item" key={row.key}>
                    <div className="record-head">
                      <span className="record-title">{row.label}</span>
                      <span className="record-value">
                        {active}/{activeSources.length}
                      </span>
                    </div>
                    <p className="record-meta">
                      {row.origin === "new" ? "Sin guardar · " : ""}
                      {active === 0
                        ? "Sin dealers: no se buscará"
                        : `Se buscará en ${active} ${active === 1 ? "dealer" : "dealers"}`}
                    </p>
                    <div className="record-actions" role="group" aria-label={row.label}>
                      <Toggle
                        on={allSelected}
                        onChange={() => toggleRow(row)}
                        title={
                          allSelected
                            ? "Quitar este modelo de todos los dealers"
                            : "Seleccionar este modelo en todos los dealers"
                        }
                      >
                        Todos
                      </Toggle>
                      {activeSources.map((source) => (
                        <Toggle
                          key={source.id}
                          on={selected.has(pairKey(source.id, row.key))}
                          onChange={() => toggle(source.id, row.key)}
                          title={`${row.label} en ${source.name}`}
                        >
                          {source.name}
                        </Toggle>
                      ))}
                      {row.origin === "new" ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => dropRow(row)}
                        >
                          Quitar
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="scrape-matrix-wrap">
              <table className="scrape-matrix">
                <thead>
                  <tr>
                    <th>Modelo</th>
                    {activeSources.map((source) => (
                      <th key={source.id}>
                        <span>{source.name}</span>
                        <small>{source.access}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const rowKeys = activeSources.map((source) => pairKey(source.id, row.key));
                    const allSelected = rowKeys.every((key) => selected.has(key));
                    return (
                      <tr key={row.key}>
                        <th scope="row">
                          <span className="scrape-model-cell">
                            <button
                              className={`scrape-model-toggle${allSelected ? " on" : ""}`}
                              type="button"
                              onClick={() => toggleRow(row)}
                              title={
                                allSelected
                                  ? "Quitar este modelo de todos los dealers"
                                  : "Seleccionar este modelo en todos los dealers"
                              }
                            >
                              {row.label}
                            </button>
                            {row.origin === "new" ? (
                              <>
                                <span className="scrape-model-new">sin guardar</span>
                                <button
                                  type="button"
                                  className="scrape-model-drop"
                                  onClick={() => dropRow(row)}
                                  title={`Quitar ${row.label} de la lista`}
                                >
                                  <span aria-hidden="true">✕</span>
                                  <span className="sr-only">Quitar {row.label}</span>
                                </button>
                              </>
                            ) : null}
                          </span>
                        </th>
                        {activeSources.map((source) => {
                          const key = pairKey(source.id, row.key);
                          const checked = selected.has(key);
                          return (
                            <td key={source.id}>
                              <label
                                className={`scrape-check${checked ? " on" : ""}`}
                                title={`${row.label} en ${source.name}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggle(source.id, row.key)}
                                />
                                <span aria-hidden="true">{checked ? "✓" : ""}</span>
                                <span className="sr-only">
                                  {row.label} en {source.name}
                                </span>
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="scrape-config-actions">
            <span className="tiny muted">{selectedCount} búsquedas por ejecución</span>
            <div className="spacer" />
            <button className="btn" type="button" onClick={onClose}>
              Cancelar
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <span className="spinner" /> : null}
              Guardar captación
            </button>
          </div>
        </div>
      )}

      {editingSource ? (
        <SourceDrawer
          source={editingSource.source}
          known={sources}
          onPickExisting={(source) => setEditingSource({ source })}
          onClose={() => setEditingSource(null)}
          onSaved={sourceSaved}
        />
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Alta y edición de un portal, en el panel que se abre sobre la matriz.
 *
 * Un portal es de dónde saca el scraper el inventario, no el vendedor que
 * firma una oferta: eso es `Dealer` y vive en su propia pantalla. Lo que se
 * decide aquí es cómo se entra —`access`— y con qué URL, que es justo lo que el
 * skill de captación lee antes de abrir nada.
 *
 * La clave no se edita: es la que usan el skill y sus extractores para
 * reconocer la fuente entre runs, y el backend no la deja cambiar.
 */
function SourceDrawer({
  source,
  known,
  onPickExisting,
  onClose,
  onSaved,
}: {
  source: ScrapeSource | null;
  known: ScrapeSource[];
  onPickExisting: (source: ScrapeSource) => void;
  onClose: () => void;
  onSaved: (saved: ScrapeSource) => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [key, setKey] = useState(source?.key ?? "");
  // Mientras nadie la toque, la clave sigue al nombre. En cuanto se edita a
  // mano deja de moverse: es un identificador, no un reflejo del rótulo.
  const [keyTouched, setKeyTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState(source?.base_url ?? "");
  const [access, setAccess] = useState<ScrapeAccess>(source?.access ?? "fetch");
  const [template, setTemplate] = useState(source?.search_url_template ?? "");
  const [listingUrl, setListingUrl] = useState(source?.listing_url ?? "");
  const [notes, setNotes] = useState(source?.notes ?? "");
  const [isActive, setIsActive] = useState(source?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveKey = source
    ? source.key
    : keyTouched
      ? key
      : name.trim()
        ? slugify(name)
        : "";

  // Solo al crear: ¿hay ya un portal con esta clave? Puede estar inactivo y por
  // tanto sin columna en la matriz, así que sin este aviso el único síntoma
  // sería un 409 sin nada que hacer al respecto.
  const duplicate =
    source === null && effectiveKey
      ? (known.find((candidate) => candidate.key === effectiveKey) ?? null)
      : null;

  /* Sin plantilla, `fetch` no tiene de dónde sacar la URL de búsqueda: el skill
     solo descubre y persiste URLs cuando navega, y con `fetch` no navega. */
  const templateMissing = !template.trim() && (access === "fetch" || access === "manual");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        search_url_template: template.trim() || null,
        listing_url: listingUrl.trim() || null,
        access,
        notes: notes.trim() || null,
      };

      const saved = source
        ? await api.patch<ScrapeSource>(`/scraping/sources/${source.id}`, {
            ...body,
            is_active: isActive,
          })
        : await api.post<ScrapeSource>("/scraping/sources", {
            ...body,
            key: effectiveKey,
            config: {},
          });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el portal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={source ? source.name : "Nuevo dealer o portal"}
      subtitle={
        source
          ? `clave ${source.key} · acceso ${source.access}`
          : "De dónde saca el scraper el inventario"
      }
      onClose={onClose}
      over
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {duplicate ? (
        /* El texto va envuelto en un solo nodo: `.banner` es un `flex` con
           hueco, y suelto cada trozo —«Ya existe», el nombre, «con la clave»…—
           sería un elemento flexible propio, cada uno en su columna. */
        <Banner kind="warn">
          <span>
            Ya existe <strong>{duplicate.name}</strong> con la clave{" "}
            <span className="mono">{duplicate.key}</span>
            {duplicate.is_active ? "" : " (está inactiva)"}.
          </span>
          <div className="spacer" />
          <button className="btn btn-sm" type="button" onClick={() => onPickExisting(duplicate)}>
            Editarla
          </button>
        </Banner>
      ) : null}

      <form className="stack" onSubmit={submit}>
        <div className="row">
          <div className="field grow">
            <label htmlFor="source-name">Nombre</label>
            <input
              id="source-name"
              className="input"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field grow">
            <label htmlFor="source-key">Clave</label>
            <input
              id="source-key"
              className="input"
              required
              readOnly={source !== null}
              pattern="[a-z0-9._-]+"
              title="Minúsculas, cifras, punto, guion y guion bajo"
              value={effectiveKey}
              onChange={(event) => {
                setKeyTouched(true);
                setKey(event.target.value);
              }}
            />
          </div>
        </div>
        <p className="tiny muted" style={{ margin: "-4px 0 0" }}>
          {source
            ? "La clave no se cambia: es con la que el scraper reconoce esta fuente y nombra sus extractores."
            : "Se usa en el scraper y en el nombre de su extractor. Sale del nombre; cámbiala si quieres otra."}
        </p>

        <div className="field">
          <label htmlFor="source-base">URL base</label>
          <input
            id="source-base"
            className="input"
            required
            inputMode="url"
            placeholder="https://www.ejemplo.es"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="source-access">Acceso</label>
          <select
            id="source-access"
            className="select"
            value={access}
            onChange={(event) => setAccess(event.target.value as ScrapeAccess)}
          >
            <option value="fetch">fetch — el HTML ya viene montado</option>
            <option value="playwright">playwright — el listado se pinta con JavaScript</option>
            <option value="browser">browser — hace falta un navegador real</option>
            <option value="manual">manual — no se rastrea</option>
          </select>
          <p className="tiny muted" style={{ margin: "4px 0 0" }}>
            {ACCESS_HINTS[access]}
          </p>
        </div>

        <div className="field">
          <label htmlFor="source-template">Plantilla de búsqueda</label>
          <input
            id="source-template"
            className="input mono"
            inputMode="url"
            placeholder="https://www.ejemplo.es/{make_slug}/{model_slug}/"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          />
          <p className="tiny muted" style={{ margin: "4px 0 0" }}>
            <span className="mono">{"{make_slug}"}</span> y{" "}
            <span className="mono">{"{model_slug}"}</span> los rellena el servidor con la
            marca y el modelo de cada combinación. Si el portal busca por identificadores
            propios (<span className="mono">{"{make_id}"}</span>,{" "}
            <span className="mono">{"{model_id}"}</span>), los descubre el scraper y los
            guarda en cada combinación.
          </p>
        </div>

        {templateMissing ? (
          <Banner kind="warn">
            {access === "manual"
              ? "Con acceso «manual» esta fuente no se rastrea: se guarda para tenerla anotada."
              : "Sin plantilla y con acceso «fetch», el scraper no puede componer la URL y marcará cada combinación como «configuration_missing». Ponla, o usa playwright o browser para que la descubra él."}
          </Banner>
        ) : null}

        <div className="field">
          <label htmlFor="source-listing">URL de listado (opcional)</label>
          <input
            id="source-listing"
            className="input"
            inputMode="url"
            placeholder="https://www.ejemplo.es/coches"
            value={listingUrl}
            onChange={(event) => setListingUrl(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="source-notes">Notas para el scraper</label>
          <textarea
            id="source-notes"
            className="textarea"
            placeholder="Ej: el precio de la tarjeta no es el de contado; usar el de la ficha."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <p className="tiny muted" style={{ margin: "4px 0 0" }}>
            El skill de captación las lee antes de abrir el portal.
          </p>
        </div>

        {source ? (
          <label className="row tiny muted">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            Activa — al desactivarla desaparece de la matriz y sus combinaciones dejan de
            rastrearse, pero se conservan por si vuelve
          </label>
        ) : null}

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {source ? "Guardar" : "Crear portal"}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Drawer>
  );
}
