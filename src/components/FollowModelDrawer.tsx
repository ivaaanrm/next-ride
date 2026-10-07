import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { api } from "../lib/api";
import { formatDateTime, formatNumber, formatPrice } from "../lib/format";
import type { CarModelGroup, CarModelWithStats, ScrapeSource, ScrapeTarget } from "../types";
import { IconCheck, IconChevronRight, IconPlus, IconSearch, IconSparkle } from "./icons";
import { Banner, Drawer, Loading } from "./ui";

/**
 * Seguir un modelo, de principio a fin, en un solo panel.
 *
 * Antes eran dos flujos que no se conocían: «Seguir un modelo» elegía entre
 * dos mil versiones sueltas (cada acabado, una fila) y su «Modelo nuevo» creaba
 * una versión en el catálogo **sin decirle al scraper que la buscara**, así que
 * nunca llegaba una oferta; la captación vivía aparte, en una matriz global.
 * Para empezar a seguir un coche había que pasar por las dos y en el orden
 * correcto.
 *
 * Aquí se elige el binomio marca-modelo —la unidad con la que se piensa «sigo
 * el Corolla»—, se dice en qué portales buscarlo y, si se quiere, a partir de
 * qué precio avisar. Todo va en una sola llamada (`PUT /tracked-models/group`).
 *
 * El mismo panel es la ficha de un binomio ya en el catálogo: con `group` llega
 * directamente al paso de configurar, y en táctil añade las cifras y las
 * versiones que en escritorio están en la tabla.
 */
export type FollowTarget = { kind: "new" } | { kind: "group"; group: CarModelGroup };

/** Lo que se puede elegir: un binomio del catálogo o uno que solo está en captación. */
interface Candidate {
  key: string;
  make: string;
  model: string;
  label: string;
  group: CarModelGroup | null;
}

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/** Espejo de `makeModelKey` del servidor sobre lo ya colapsado. */
const keyOf = (make: string, model: string) =>
  `${collapse(make).toLowerCase()}|${collapse(model).toLowerCase()}`;

/** Para buscar: sin tildes ni mayúsculas, «leon» encuentra «León». */
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** «Toyota Corolla Cross» → marca «Toyota», modelo «Corolla Cross». Se corrige a mano. */
function splitQuery(query: string): { make: string; model: string } {
  const [make = "", ...rest] = collapse(query).split(" ");
  return { make, model: rest.join(" ") };
}

const offersOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "oferta" : "ofertas"}`;
const portalsOf = (count: number) => `${count} ${count === 1 ? "portal" : "portales"}`;
const theVersions = (count: number) => (count === 1 ? "la versión" : `las ${count} versiones`);

/**
 * Pliega el mismo criterio de varias versiones: el valor si todas coinciden y,
 * si no, `null` más la señal de que discrepan. Un `null` a secas no distingue
 * «ninguna lo tiene puesto» de «cada una el suyo».
 */
function foldValues<T>(values: T[]): { value: T | null; mixed: boolean } {
  if (values.length === 0) return { value: null, mixed: false };
  const [first] = values;
  const same = values.every((value) => value === first);
  return { value: same ? first : null, mixed: !same };
}

interface Criteria {
  target_price: string;
  max_mileage_km: string;
  min_year: string;
  notes: string;
}

const EMPTY_CRITERIA: Criteria = { target_price: "", max_mileage_km: "", min_year: "", notes: "" };

/** Con qué llega relleno el formulario, y si el binomio tiene criterios dispares. */
function criteriaOf(group: CarModelGroup | null): { criteria: Criteria; mixed: boolean } {
  if (!group) return { criteria: EMPTY_CRITERIA, mixed: false };
  const tracked = group.variants.flatMap((variant) => (variant.tracking ? [variant.tracking] : []));
  const price = foldValues(tracked.map((prefs) => prefs.target_price));
  const mileage = foldValues(tracked.map((prefs) => prefs.max_mileage_km));
  const year = foldValues(tracked.map((prefs) => prefs.min_year));
  const notes = foldValues(tracked.map((prefs) => prefs.notes));
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    criteria: {
      target_price: text(price.value),
      max_mileage_km: text(mileage.value),
      min_year: text(year.value),
      notes: notes.value ?? "",
    },
    // Discrepan, o hay versiones sin seguir: guardar cambia más de lo que se ve.
    mixed:
      price.mixed ||
      mileage.mixed ||
      year.mixed ||
      notes.mixed ||
      (tracked.length > 0 && tracked.length < group.variant_count),
  };
}

/** En qué estado de seguimiento está el binomio, dicho con palabras. */
export function followStatus(group: CarModelGroup): string {
  if (group.tracked_variants === 0) return "No lo sigues";
  if (group.tracked_variants === group.variant_count) {
    return group.variant_count === 1 ? "Lo sigues" : `Sigues ${theVersions(group.variant_count)}`;
  }
  return `Sigues ${group.tracked_variants} de ${group.variant_count} versiones`;
}

export function FollowModelDrawer({
  target,
  touch,
  onPickVariant,
  onRanking,
  onClose,
  onSaved,
}: {
  target: FollowTarget;
  touch: boolean;
  /** Abre los criterios de una versión suelta (con su PVP de referencia). */
  onPickVariant?: (model: CarModelWithStats) => void;
  onRanking?: (group: CarModelGroup) => void;
  onClose: () => void;
  /** `message` es el acuse para el aviso de la página; `undo`, cómo volver atrás. */
  onSaved: (message: string, undo?: () => Promise<void>) => void;
}) {
  const initialGroup = target.kind === "group" ? target.group : null;

  const [sources, setSources] = useState<ScrapeSource[] | null>(null);
  const [targets, setTargets] = useState<ScrapeTarget[]>([]);
  const [catalog, setCatalog] = useState<CarModelGroup[] | null>(
    initialGroup ? [initialGroup] : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Candidate | null>(
    initialGroup
      ? {
          key: initialGroup.key,
          make: initialGroup.make,
          model: initialGroup.model,
          label: initialGroup.label,
          group: initialGroup,
        }
      : null,
  );
  // Binomio escrito a mano: marca y modelo editables, todavía sin catálogo.
  const [custom, setCustom] = useState<{ make: string; model: string } | null>(null);

  const initial = criteriaOf(initialGroup);
  const [criteria, setCriteria] = useState<Criteria>(initial.criteria);
  const [mixed, setMixed] = useState(initial.mixed);
  // `null` mientras no se sabe qué hay en captación: no se envía lo que no se ha visto.
  const [picked, setPicked] = useState<Set<number> | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<ScrapeSource[]>("/scraping/sources"),
      api.get<ScrapeTarget[]>("/scraping/targets"),
      initialGroup ? Promise.resolve(null) : api.get<CarModelGroup[]>("/car-models/groups"),
    ])
      .then(([nextSources, nextTargets, groups]) => {
        if (!active) return;
        setSources(nextSources);
        setTargets(nextTargets);
        if (groups) setCatalog(groups);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setLoadError(reason instanceof Error ? reason.message : "No se pudo cargar el catálogo");
        setSources([]);
        setCatalog((current) => current ?? []);
      });
    return () => {
      active = false;
    };
  }, [initialGroup]);

  /** Fuentes activas en las que se busca cada binomio hoy. */
  const searchedIn = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const item of targets) {
      map.set(item.make_model_key, [...(map.get(item.make_model_key) ?? []), item.source_id]);
    }
    return map;
  }, [targets]);

  /** El catálogo más lo que solo está en captación, sin repetidos. */
  const candidates = useMemo<Candidate[]>(() => {
    const rows = new Map<string, Candidate>();
    for (const group of catalog ?? []) {
      rows.set(group.key, {
        key: group.key,
        make: group.make,
        model: group.model,
        label: group.label,
        group,
      });
    }
    for (const item of targets) {
      if (rows.has(item.make_model_key)) continue;
      rows.set(item.make_model_key, {
        key: item.make_model_key,
        make: item.make,
        model: item.model,
        label: `${item.make} ${item.model}`,
        group: null,
      });
    }
    return [...rows.values()];
  }, [catalog, targets]);

  // Un binomio escrito a mano que ya existe se trata como el que existe: si no,
  // el formulario hablaría de «nuevo» de algo que tiene trescientas ofertas.
  const customKey = custom ? keyOf(custom.make, custom.model) : null;
  const customTwin = customKey
    ? (candidates.find((candidate) => candidate.key === customKey) ?? null)
    : null;

  // Al tener elegido el binomio y saber qué hay en captación, los interruptores
  // nacen con lo que ya se busca. Si no se busca en ninguno, encendidos todos:
  // quien sigue un modelo quiere que se busque, y apagar lo que sobre es menos
  // trabajo que encender cinco. Un binomio nuevo es una sola identidad mientras
  // se escribe: si no, cada tecla volvería a encenderlo todo.
  const initKey = custom ? (customTwin?.key ?? "nuevo") : (chosen?.key ?? null);
  useEffect(() => {
    if (!sources || initKey === null) return;
    const current = (searchedIn.get(initKey) ?? []).filter((id) =>
      sources.some((source) => source.id === id),
    );
    setPicked(new Set(current.length ? current : sources.map((source) => source.id)));
    // Solo al cambiar de binomio o al llegar los datos: después manda quien toca.
  }, [sources, initKey, searchedIn]);

  const matches = useMemo(() => {
    const needle = fold(collapse(query));
    const list = needle
      ? candidates.filter((candidate) => fold(candidate.label).includes(needle))
      : candidates;
    // Lo que no se sigue primero: es lo que se viene a buscar aquí. Dentro, lo
    // que más ofertas tiene, que es lo más probable.
    return [...list].sort(
      (a, b) =>
        Number((a.group?.tracked_variants ?? 0) > 0) - Number((b.group?.tracked_variants ?? 0) > 0) ||
        (b.group?.active_offers ?? -1) - (a.group?.active_offers ?? -1) ||
        a.label.localeCompare(b.label, "es"),
    );
  }, [candidates, query]);

  const exact = useMemo(() => {
    const needle = fold(collapse(query));
    return candidates.some((candidate) => fold(candidate.label) === needle);
  }, [candidates, query]);

  function choose(candidate: Candidate) {
    const next = criteriaOf(candidate.group);
    setChosen(candidate);
    setCustom(null);
    setCriteria(next.criteria);
    setMixed(next.mixed);
    setError(null);
  }

  function startCustom() {
    setChosen(null);
    setCustom(splitQuery(query));
    setCriteria(EMPTY_CRITERIA);
    setMixed(false);
    setError(null);
  }

  function backToSearch() {
    setChosen(null);
    setCustom(null);
    setPicked(null);
    setError(null);
  }

  const subject: Candidate | null = customTwin ?? chosen;
  const group = subject?.group ?? null;
  const tracked = (group?.tracked_variants ?? 0) > 0;
  const configuring = chosen !== null || custom !== null;

  const make = custom ? collapse(custom.make) : (subject?.make ?? "");
  const model = custom ? collapse(custom.model) : (subject?.model ?? "");
  const label = customTwin ? customTwin.label : `${make} ${model}`.trim();

  const number = (value: string) => (value.trim() === "" ? null : Number(value));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!make || !model) {
      setError("Escribe la marca y el modelo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sourceIds = picked ? [...picked] : null;
      await api.put("/tracked-models/group", {
        make: subject?.make ?? make,
        model: subject?.model ?? model,
        target_price: number(criteria.target_price),
        max_mileage_km: number(criteria.max_mileage_km),
        min_year: number(criteria.min_year),
        notes: criteria.notes.trim() || null,
        source_ids: sourceIds,
      });
      const where =
        sourceIds === null
          ? ""
          : sourceIds.length === 0
            ? " · no se busca en ningún portal"
            : ` · se busca en ${portalsOf(sourceIds.length)}`;
      onSaved(`${tracked ? "Guardado" : "Siguiendo"} ${label}${where}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el seguimiento");
    } finally {
      setBusy(false);
    }
  }

  async function unfollow() {
    if (!group) return;
    setBusy(true);
    setError(null);
    // Lo que había, para que «Deshacer» lo devuelva tal cual. Las fuentes no se
    // tocan al dejar de seguir, así que deshacer tampoco las toca.
    const previous = criteriaOf(group).criteria;
    try {
      await api.delete("/tracked-models/group", { key: group.key });
      onSaved(`Has dejado de seguir ${group.label}`, async () => {
        await api.put("/tracked-models/group", {
          make: group.make,
          model: group.model,
          target_price: number(previous.target_price),
          max_mileage_km: number(previous.max_mileage_km),
          min_year: number(previous.min_year),
          notes: previous.notes.trim() || null,
          source_ids: null,
        });
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo dejar de seguir");
      setBusy(false);
    }
  }

  function togglePortal(id: number) {
    setPicked((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const setField = (field: keyof Criteria) => (value: string) =>
    setCriteria((current) => ({ ...current, [field]: value }));

  const title = initialGroup ? initialGroup.label : "Seguir un modelo";
  const subtitle = initialGroup
    ? [
        initialGroup.active_offers === 0 ? "Sin ofertas aún" : offersOf(initialGroup.active_offers),
        initialGroup.median_price !== null ? `mediana ${formatPrice(initialGroup.median_price)}` : null,
        followStatus(initialGroup).toLowerCase(),
      ]
        .filter(Boolean)
        .join(" · ")
    : configuring
      ? "Dónde buscarlo y cuándo avisarte"
      : "Elige el modelo o escríbelo si es nuevo";

  const footer = configuring ? (
    <>
      {tracked && group ? (
        <button
          type="button"
          className="btn btn-ghost btn-danger follow-unfollow"
          disabled={busy}
          onClick={() => void unfollow()}
        >
          Dejar de seguir
        </button>
      ) : !initialGroup ? (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={backToSearch}>
          Atrás
        </button>
      ) : null}
      <button
        type="submit"
        form="follow-form"
        className="btn btn-primary follow-submit"
        disabled={busy || !make || !model}
      >
        {busy ? <span className="spinner" /> : null}
        {tracked ? "Guardar cambios" : label ? `Seguir ${label}` : "Seguir"}
      </button>
    </>
  ) : undefined;

  return (
    <Drawer
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={footer}
    >
      {loadError ? <Banner kind="error">{loadError}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}

      {!configuring ? (
        <PickStep
          query={query}
          onQuery={setQuery}
          loading={catalog === null}
          matches={matches}
          exact={exact}
          searchedIn={searchedIn}
          onChoose={choose}
          onCustom={startCustom}
        />
      ) : (
        <form id="follow-form" className="follow-form" onSubmit={submit}>
          {initialGroup && touch ? (
            <ModelFigures group={initialGroup} onRanking={onRanking} />
          ) : null}

          {!initialGroup ? (
            <section className="follow-subject">
              {custom ? (
                <>
                  <div className="follow-grid">
                    <div className="field">
                      <label htmlFor="follow-make">Marca</label>
                      <input
                        id="follow-make"
                        className="input"
                        required
                        autoComplete="off"
                        autoCapitalize="words"
                        value={custom.make}
                        onChange={(event) => setCustom({ ...custom, make: event.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="follow-model">Modelo</label>
                      <input
                        id="follow-model"
                        className="input"
                        required
                        autoComplete="off"
                        autoCapitalize="words"
                        value={custom.model}
                        onChange={(event) => setCustom({ ...custom, model: event.target.value })}
                      />
                    </div>
                  </div>
                  <p className="follow-note">
                    {customTwin
                      ? `Ya está en el catálogo como «${customTwin.label}»: se usará ese.`
                      : "Tal como lo escriben los portales. Aparecerá en Modelos ya seguido y con cero ofertas hasta que llegue la primera."}
                  </p>
                </>
              ) : subject ? (
                <div className="follow-chosen">
                  <div className="follow-chosen-text">
                    <span className="follow-chosen-name">{subject.label}</span>
                    <span className="record-meta">
                      {group
                        ? `${offersOf(group.active_offers)} · ${followStatus(group).toLowerCase()}`
                        : "En captación · todavía sin ofertas"}
                    </span>
                  </div>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={backToSearch}>
                    Cambiar
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}

          {mixed && group ? (
            <Banner kind="warn">
              {group.tracked_variants < group.variant_count
                ? `Sigues ${group.tracked_variants} de ${group.variant_count} versiones. Al guardar, pasas a seguir ${theVersions(group.variant_count)} con estos criterios.`
                : `Tus versiones tienen criterios distintos. Al guardar, estos se aplican a ${theVersions(group.variant_count)}.`}
            </Banner>
          ) : null}

          <section className="follow-section" aria-labelledby="follow-where">
            <h3 className="section-title" id="follow-where">
              Dónde buscarlo
            </h3>
            {sources === null || picked === null ? (
              <Loading label="Cargando portales…" />
            ) : sources.length === 0 ? (
              <p className="follow-note">
                No hay portales activos. Se dan de alta en Captación, en la cabecera de Modelos.
              </p>
            ) : (
              <>
                <ul className="record-list">
                  {sources.map((source) => {
                    const on = picked.has(source.id);
                    return (
                      <li key={source.id} className="record-item">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          className="switch-row"
                          onClick={() => togglePortal(source.id)}
                        >
                          <span className="switch-row-text">
                            <span className="switch-row-title">{source.name}</span>
                            <span className="switch-row-meta">{ACCESS_LABELS[source.access]}</span>
                          </span>
                          <span className="switch" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="follow-note">
                  {picked.size === 0
                    ? "Sin portales el scraper no lo buscará: solo verás las ofertas que lleguen por otra vía."
                    : `El scraper lo buscará en ${portalsOf(picked.size)} en cada pasada.`}
                </p>
              </>
            )}
          </section>

          <section className="follow-section" aria-labelledby="follow-when">
            <h3 className="section-title" id="follow-when">
              Avísame si… <span className="section-title-hint">opcional</span>
            </h3>
            <div className="follow-grid">
              <NumberField
                id="follow-target"
                label="Precio por debajo de"
                unit="€"
                step={500}
                value={criteria.target_price}
                onChange={setField("target_price")}
              />
              <NumberField
                id="follow-km"
                label="Kilómetros, como mucho"
                unit="km"
                step={5000}
                value={criteria.max_mileage_km}
                onChange={setField("max_mileage_km")}
              />
              <NumberField
                id="follow-year"
                label="Año, desde"
                min={1950}
                max={2100}
                value={criteria.min_year}
                onChange={setField("min_year")}
              />
            </div>
            <div className="field">
              <label htmlFor="follow-notes">Notas</label>
              <textarea
                id="follow-notes"
                className="textarea"
                rows={2}
                placeholder="Automático, con garantía oficial…"
                value={criteria.notes}
                onChange={(event) => setField("notes")(event.target.value)}
              />
            </div>
            {group && group.variant_count > 1 ? (
              <p className="follow-note">
                Se aplican a {theVersions(group.variant_count)} y a las que lleguen después. El PVP
                de referencia es de cada versión y se pone en la suya.
              </p>
            ) : null}
          </section>

          {initialGroup && touch && onPickVariant ? (
            <VariantList group={initialGroup} onPick={onPickVariant} />
          ) : null}
        </form>
      )}
    </Drawer>
  );
}

const ACCESS_LABELS: Record<ScrapeSource["access"], string> = {
  fetch: "HTML directo",
  playwright: "Playwright",
  browser: "Navegador real",
  manual: "Manual · no se rastrea",
};

/* ------------------------------------------------------------------------- */

function PickStep({
  query,
  onQuery,
  loading,
  matches,
  exact,
  searchedIn,
  onChoose,
  onCustom,
}: {
  query: string;
  onQuery: (value: string) => void;
  loading: boolean;
  matches: Candidate[];
  exact: boolean;
  searchedIn: Map<string, number[]>;
  onChoose: (candidate: Candidate) => void;
  onCustom: () => void;
}) {
  const typed = collapse(query);
  // Para escribir uno nuevo hacen falta dos palabras: marca y modelo.
  const canCreate = typed.includes(" ") && !exact;

  return (
    <div className="follow-pick">
      <div className="search-field">
        <IconSearch size={18} />
        <label htmlFor="follow-search" className="sr-only">
          Marca y modelo
        </label>
        <input
          id="follow-search"
          className="input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="words"
          placeholder="Marca y modelo, p. ej. Toyota Corolla"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (matches.length === 1) onChoose(matches[0]);
            else if (canCreate && matches.length === 0) onCustom();
          }}
        />
      </div>

      {loading ? (
        <Loading label="Cargando el catálogo…" />
      ) : (
        <>
          {canCreate ? (
            <button type="button" className="follow-create" onClick={onCustom}>
              <span className="follow-create-icon">
                <IconPlus size={18} />
              </span>
              <span className="follow-create-text">
                <span>
                  Seguir <strong>{typed}</strong>
                </span>
                <span className="record-meta">Nuevo: entra en el catálogo y en la captación</span>
              </span>
            </button>
          ) : null}

          {matches.length ? (
            <ul className="record-list" aria-label="Modelos">
              {matches.map((candidate) => {
                const following = (candidate.group?.tracked_variants ?? 0) > 0;
                const portals = searchedIn.get(candidate.key)?.length ?? 0;
                return (
                  <li key={candidate.key} className="record-item">
                    <button
                      type="button"
                      className="record-link follow-candidate"
                      onClick={() => onChoose(candidate)}
                    >
                      <span className="record-head">
                        <span className="record-title">{candidate.label}</span>
                        {following ? (
                          <span className="follow-tag">
                            <IconCheck size={14} />
                            Siguiendo
                          </span>
                        ) : null}
                      </span>
                      <span className="record-meta">
                        {[
                          candidate.group ? offersOf(candidate.group.active_offers) : "Sin ofertas aún",
                          portals ? `se busca en ${portalsOf(portals)}` : "no se busca",
                        ].join(" · ")}
                      </span>
                      <IconChevronRight size={16} className="follow-candidate-chevron" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : typed && !canCreate ? (
            <p className="follow-note">
              Nada coincide. Escribe la marca y el modelo, p. ej. «Toyota Corolla», para seguir uno
              nuevo.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

export function NumberField({
  id,
  label,
  unit,
  value,
  onChange,
  step,
  min = 0,
  max,
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  onChange: (value: string) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={`input-affix${unit ? "" : " bare"}`}>
        <input
          id={id}
          className="input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {unit ? <span aria-hidden="true">{unit}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * Las columnas de la tabla que no caben en la ficha táctil, como cifras en
 * rejilla y no como ocho filas de lista: son para leer de un vistazo, no para
 * tocar.
 */
function ModelFigures({
  group,
  onRanking,
}: {
  group: CarModelGroup;
  onRanking?: (group: CarModelGroup) => void;
}) {
  // Sin ofertas, seis rayas no dicen nada que no diga una frase.
  if (group.active_offers === 0) {
    return (
      <p className="follow-note model-waiting">
        Todavía no ha llegado ninguna oferta. Aparecerán aquí en cuanto el scraper encuentre la
        primera en los portales marcados abajo.
      </p>
    );
  }
  const reached =
    group.target_price !== null && group.min_price !== null && group.min_price <= group.target_price;
  const figures: { label: string; value: ReactNode; hint?: string; tone?: string }[] = [
    { label: "Mínimo", value: formatPrice(group.min_price) },
    { label: "Mediana", value: formatPrice(group.median_price) },
    { label: "Máximo", value: formatPrice(group.max_price) },
    { label: "Dealers", value: formatNumber(group.dealers_count) },
    {
      label: "PVP ref.",
      value: formatPrice(group.reference_price),
      hint:
        group.reference_variants > 0 && group.reference_variants < group.variant_count
          ? `${group.reference_variants} de ${group.variant_count} versiones`
          : undefined,
    },
    {
      label: "Objetivo",
      value: group.target_price === null ? "—" : formatPrice(group.target_price),
      hint: group.target_price === null ? undefined : reached ? "ya hay ofertas por debajo" : "sin alcanzar",
      tone: reached ? "positive" : undefined,
    },
  ];
  return (
    <section className="model-figures" aria-label="Cifras del modelo">
      {figures.map((figure) => (
        <div key={figure.label} className="figure">
          <span className="figure-label">{figure.label}</span>
          <span className={`figure-value${figure.tone ? ` ${figure.tone}` : ""}`}>{figure.value}</span>
          {figure.hint ? <span className="figure-hint">{figure.hint}</span> : null}
        </div>
      ))}
      {/* El ranking es lo siguiente que se hace con un modelo que se mira: va
          con sus cifras, como una fila más, y no como un botón a lo ancho de la
          cabecera que empujaba el titular. */}
      {onRanking ? (
        <button
          type="button"
          className="model-ranking"
          disabled={group.active_offers === 0}
          onClick={() => onRanking(group)}
        >
          <IconSparkle size={18} />
          <span className="model-ranking-text">
            <span>Ranking con IA</span>
            <span className="record-meta">
              {group.active_offers === 0
                ? "Sin ofertas que comparar todavía"
                : group.last_ranked_at
                  ? `Último: ${formatDateTime(group.last_ranked_at)}`
                  : `Compara sus ${offersOf(group.active_offers)}`}
            </span>
          </span>
          <IconChevronRight size={16} />
        </button>
      ) : null}
    </section>
  );
}

function VariantList({
  group,
  onPick,
}: {
  group: CarModelGroup;
  onPick: (model: CarModelWithStats) => void;
}) {
  return (
    <details className="follow-variants">
      <summary className="section-title">
        Versiones <span className="section-title-hint">{group.variant_count}</span>
      </summary>
      <ul className="record-list">
        {group.variants.map((variant) => (
          <li key={variant.id} className="record-item">
            <button type="button" className="record-link" onClick={() => onPick(variant)}>
              <span className="sr-only">Criterios de </span>
              <span className="record-head">
                <span className="record-title">{variant.trim || "Sin acabado"}</span>
                <span className="record-value">
                  {formatPrice(variant.median_price)}
                  <span className="sr-only"> de mediana</span>
                </span>
              </span>
              <span className="record-meta">
                {[
                  variant.is_tracked ? "Siguiendo" : null,
                  offersOf(variant.active_offers),
                  variant.tracking?.target_price != null
                    ? `objetivo ${formatPrice(variant.tracking.target_price)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="follow-note">Cada versión se afina —o se deja de seguir— desde su ficha.</p>
    </details>
  );
}
