import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useTouchLayout } from "./SwipeRow";
import { Banner, Drawer, Sheet } from "./ui";
import { api } from "../lib/api";
import {
  CONDITION_LABELS,
  formatDateTime,
  FUEL_LABELS,
  TRANSMISSION_LABELS,
} from "../lib/format";
import { useAsync } from "../lib/hooks";
import type {
  CarModelWithStats,
  DealerWithStats,
  FuelType,
  Offer,
  OfferEditableField,
  Transmission,
  VehicleCondition,
} from "../types";

/* -------------------------------------------------------------------------- *
 * Corregir una oferta a mano
 *
 * El scraper acierta casi siempre y falla en lo de siempre: el año que venía en
 * el título y no en la ficha, los kilómetros con un punto de más, la potencia
 * que no venía, la versión resuelta contra el modelo equivocado. Hasta ahora la
 * única salida era descartar la oferta —una fila mal leída y un coche que sí
 * interesa se iban juntos—, y las medianas seguían contando con el dato malo.
 *
 * Dos reglas gobiernan todo lo de aquí:
 *
 * 1. **Se manda el diff, no el formulario.** Solo viajan los campos que han
 *    cambiado. El backend lee el cuerpo con `exclude_unset`, así que mandar los
 *    catorce campos siempre no sería «guardar»: sería anclarlos todos.
 * 2. **Lo que se corrige queda anclado.** El campo entra en `manual_fields` y
 *    el siguiente pase del scraper no lo pisa. Es lo que separa corregir de
 *    pintar; sin ello, el arreglo duraría hasta el rastreo de esa noche.
 *
 * No hay nada que recalcular al guardar: las métricas y la puntuación se
 * computan al leer, así que la respuesta del `PATCH` ya trae el km/año, el valor
 * esperado y el `value_score` rehechos. El veredicto de la IA no: es de un run
 * pasado, se hizo con los datos de entonces, y decirlo es más honrado que
 * disimularlo.
 * -------------------------------------------------------------------------- */

/** Lo que se teclea. Todo texto salvo los desplegables: un campo numérico vacío
 *  tiene que poder distinguirse de un cero, y `number | null` no da esa cuenta. */
interface Draft {
  title: string;
  price: string;
  original_price: string;
  currency: string;
  year: string;
  mileage_km: string;
  power_hp: string;
  condition: VehicleCondition;
  fuel_type: FuelType | "";
  transmission: Transmission | "";
  location: string;
  image_url: string;
  car_model_id: number;
  dealer_id: number;
}

const text = (value: string | null | undefined): string => value ?? "";
const num = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

const draftOf = (offer: Offer): Draft => ({
  title: offer.title,
  price: num(offer.price),
  original_price: num(offer.original_price),
  currency: offer.currency,
  year: num(offer.year),
  mileage_km: num(offer.mileage_km),
  power_hp: num(offer.power_hp),
  condition: offer.condition,
  fuel_type: offer.fuel_type ?? "",
  transmission: offer.transmission ?? "",
  location: text(offer.location),
  image_url: text(offer.image_url),
  car_model_id: offer.car_model.id,
  dealer_id: offer.dealer.id,
});

/** Lo que devuelve una cifra que no se entiende. No es `null`: vaciar un campo y
 *  teclear un disparate son cosas distintas y solo una de las dos se guarda. */
const INVALID = Symbol("invalid");

/** Una cifra tecleada. `""` es «sin dato»; lo ilegible sale por `INVALID`. */
function parseNumber(raw: string): number | null | typeof INVALID {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : INVALID;
}

/** Un texto opcional: en blanco se guarda como «sin dato», no como cadena vacía. */
const emptyToNull = (value: string): string | null => value.trim() || null;

interface Patch {
  [field: string]: unknown;
}

/**
 * Qué ha cambiado de verdad.
 *
 * Comparar contra la oferta y no marcar «sucio» al escribir no es una
 * optimización de bytes: cada campo que viaja queda anclado, así que mandar uno
 * que no se ha tocado le quitaría al scraper una columna que nadie le quiso
 * quitar. Los `null` sí viajan cuando son un cambio —vaciar el año **es**
 * borrarlo—, que es justo lo que `exclude_unset` sabe distinguir al otro lado.
 */
function buildPatch(draft: Draft, offer: Offer): Patch | typeof INVALID {
  const patch: Patch = {};
  const put = (field: OfferEditableField, next: unknown, current: unknown) => {
    if (next !== current) patch[field] = next;
  };

  put("title", draft.title.trim(), offer.title);
  put("currency", draft.currency.trim().toUpperCase(), offer.currency);
  put("condition", draft.condition, offer.condition);
  put("fuel_type", draft.fuel_type || null, offer.fuel_type);
  put("transmission", draft.transmission || null, offer.transmission);
  put("location", emptyToNull(draft.location), offer.location);
  put("image_url", emptyToNull(draft.image_url), offer.image_url);
  put("car_model_id", draft.car_model_id, offer.car_model.id);
  put("dealer_id", draft.dealer_id, offer.dealer.id);

  const numbers: [OfferEditableField, string, number | null][] = [
    ["price", draft.price, offer.price],
    ["original_price", draft.original_price, offer.original_price],
    ["year", draft.year, offer.year],
    ["mileage_km", draft.mileage_km, offer.mileage_km],
    ["power_hp", draft.power_hp, offer.power_hp],
  ];
  for (const [field, raw, current] of numbers) {
    const parsed = parseNumber(raw);
    if (parsed === INVALID) return INVALID;
    put(field, parsed, current);
  }

  return patch;
}

/** El título en blanco no es una corrección, es perder el nombre de la fila. */
function localError(draft: Draft, patch: Patch): string | null {
  if ("title" in patch && !draft.title.trim()) return "El título no puede quedarse en blanco";
  if ("price" in patch && !(Number(draft.price.replace(",", ".")) > 0)) {
    return "El precio tiene que ser mayor que cero";
  }
  if ("currency" in patch && draft.currency.trim().length !== 3) {
    return "La moneda son tres letras (EUR)";
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * El editor
 * -------------------------------------------------------------------------- */

/**
 * Misma lista de campos, dos superficies.
 *
 * En escritorio es un panel lateral con los campos en dos columnas: se llega
 * desde la ficha, que ocupa 880 px al lado, y la corrección se hace mirando el
 * dato malo. En un móvil es una hoja inferior a una columna, con los campos
 * numéricos pidiendo el teclado numérico y la geometría táctil que la hoja de
 * estilos ya da a `.input` por debajo de 860 px.
 *
 * No son dos componentes: lo que cambia es el envoltorio y la rejilla, no lo que
 * se edita. Dos listas de catorce campos habrían empezado iguales y habrían
 * acabado distintas.
 */
export function OfferEditor({
  offer,
  onClose,
  onSaved,
}: {
  offer: Offer;
  onClose: () => void;
  /** La oferta ya guardada, con sus métricas rehechas por el servidor. */
  onSaved: (offer: Offer) => void;
}) {
  const touch = useTouchLayout();
  const [draft, setDraft] = useState<Draft>(() => draftOf(offer));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // El catálogo se pide al abrir el editor y no con la lista: reatribuir una
  // oferta a otra versión es la corrección más rara de todas, y no puede costar
  // dos peticiones a quien solo viene a mirar ofertas.
  const models = useAsync<CarModelWithStats[]>(() => api.get("/car-models"), []);
  const dealers = useAsync<DealerWithStats[]>(() => api.get("/dealers"), []);

  const patch = (next: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...next }));
  const pinned = new Set<OfferEditableField>(offer.manual_fields);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    const body = buildPatch(draft, offer);
    if (body === INVALID) {
      setError("Hay una cifra que no se entiende. Revisa precio, año, kilómetros y potencia");
      return;
    }

    const invalid = localError(draft, body);
    if (invalid) {
      setError(invalid);
      return;
    }

    // Sin cambios no hay nada que mandar: un `PATCH` vacío anclaría cero campos
    // y devolvería la misma oferta, pero también sellaría `edited_at` con una
    // edición que no existió.
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }

    setError(null);
    setBusy(true);
    try {
      onSaved(await api.patch<Offer>(`/offers/${offer.id}`, body));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la corrección");
    } finally {
      setBusy(false);
    }
  }

  /** Suelta los anclajes: los valores se quedan, pero el scraper vuelve a mandar. */
  async function release() {
    setError(null);
    setBusy(true);
    try {
      onSaved(await api.patch<Offer>(`/offers/${offer.id}`, { clear_manual: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron soltar los campos");
    } finally {
      setBusy(false);
    }
  }

  const fields = (
    <OfferFields
      draft={draft}
      offer={offer}
      pinned={pinned}
      touch={touch}
      models={models.data ?? []}
      dealers={dealers.data ?? []}
      onChange={patch}
    />
  );

  const banner = error ? <Banner kind="error">{error}</Banner> : null;
  const provenance = <ManualNote offer={offer} busy={busy} onRelease={release} />;

  if (touch) {
    return (
      <Sheet
        over
        title="Corregir datos"
        onClose={onClose}
        footer={
          <button
            type="button"
            className="btn btn-primary sheet-apply"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <span className="spinner" /> : null}
            Guardar
          </button>
        }
      >
        {banner}
        {/* El formulario lleva su `onSubmit` aunque el botón viva en el pie de la
            hoja: así «intro» desde cualquier campo guarda, sin bajar a buscarlo. */}
        <form className="edit-form" onSubmit={save}>
          {fields}
          {provenance}
        </form>
      </Sheet>
    );
  }

  return (
    <Drawer
      over
      /* Del mismo ancho que la ficha desde la que se abre: así la tapa entera en
         vez de dejar media asomando por la izquierda, y los rótulos de tres
         columnas caben sin partirse en dos renglones. */
      wide
      title="Corregir datos"
      subtitle={offer.title}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? <span className="spinner" /> : null}
            Guardar
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancelar
          </button>
        </>
      }
    >
      {banner}
      <form className="edit-form" onSubmit={save}>
        {fields}
        {provenance}
        {/* Los mismos dos botones que la cabecera, al final del recorrido: en un
            formulario largo, volver arriba para guardar es un viaje que no hace
            falta cobrar. */}
        <div className="edit-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Guardar
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Drawer>
  );
}

/* -------------------------------------------------------------------------- *
 * Los campos
 * -------------------------------------------------------------------------- */

function OfferFields({
  draft,
  offer,
  pinned,
  touch,
  models,
  dealers,
  onChange,
}: {
  draft: Draft;
  offer: Offer;
  pinned: Set<OfferEditableField>;
  touch: boolean;
  models: CarModelWithStats[];
  dealers: DealerWithStats[];
  onChange: (next: Partial<Draft>) => void;
}) {
  return (
    <>
      {/* El precio primero: es el dato por el que se abre una oferta y el que
          más veces trae mal el scraper (el «desde», el precio financiado). */}
      <Section title="Precio">
        <div className="edit-grid">
          <Field name="price" label="Precio" pinned={pinned}>
            <input
              id="edit-price"
              className="input"
              type="number"
              inputMode="decimal"
              min={1}
              step={50}
              required
              value={draft.price}
              onChange={(event) => onChange({ price: event.target.value })}
            />
          </Field>
          <Field
            name="original_price"
            label="PVP anunciado"
            hint="antes del descuento"
            pinned={pinned}
          >
            <input
              id="edit-original-price"
              className="input"
              type="number"
              inputMode="decimal"
              min={1}
              step={50}
              value={draft.original_price}
              onChange={(event) => onChange({ original_price: event.target.value })}
            />
          </Field>
          <Field name="currency" label="Moneda" pinned={pinned}>
            <input
              id="edit-currency"
              className="input"
              maxLength={3}
              autoCapitalize="characters"
              value={draft.currency}
              onChange={(event) => onChange({ currency: event.target.value })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Vehículo">
        <div className="edit-grid">
          <Field name="year" label="Año" pinned={pinned}>
            <input
              id="edit-year"
              className="input"
              type="number"
              inputMode="numeric"
              min={1950}
              max={2100}
              step={1}
              value={draft.year}
              onChange={(event) => onChange({ year: event.target.value })}
            />
          </Field>
          <Field name="mileage_km" label="Kilómetros" pinned={pinned}>
            <input
              id="edit-mileage-km"
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              value={draft.mileage_km}
              onChange={(event) => onChange({ mileage_km: event.target.value })}
            />
          </Field>
          <Field name="power_hp" label="Potencia" hint="CV" pinned={pinned}>
            <input
              id="edit-power-hp"
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              step={5}
              value={draft.power_hp}
              onChange={(event) => onChange({ power_hp: event.target.value })}
            />
          </Field>
          <Field name="condition" label="Estado" pinned={pinned}>
            <select
              id="edit-condition"
              className="select"
              value={draft.condition}
              onChange={(event) =>
                onChange({ condition: event.target.value as VehicleCondition })
              }
            >
              {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field name="fuel_type" label="Combustible" pinned={pinned}>
            <select
              id="edit-fuel-type"
              className="select"
              value={draft.fuel_type}
              onChange={(event) =>
                onChange({ fuel_type: event.target.value as FuelType | "" })
              }
            >
              <option value="">Sin dato</option>
              {Object.entries(FUEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field name="transmission" label="Cambio" pinned={pinned}>
            <select
              id="edit-transmission"
              className="select"
              value={draft.transmission}
              onChange={(event) =>
                onChange({ transmission: event.target.value as Transmission | "" })
              }
            >
              <option value="">Sin dato</option>
              {Object.entries(TRANSMISSION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Anuncio">
        <Field name="title" label="Título" pinned={pinned}>
          <input
            id="edit-title"
            className="input"
            required
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <div className="edit-grid two">
          <Field
            name="location"
            label="Ubicación"
            hint="la del anuncio, no la del dealer"
            pinned={pinned}
          >
            <input
              id="edit-location"
              className="input"
              value={draft.location}
              onChange={(event) => onChange({ location: event.target.value })}
            />
          </Field>
          <Field name="image_url" label="Foto (URL)" pinned={pinned}>
            <input
              id="edit-image-url"
              className="input"
              inputMode="url"
              placeholder="https://…"
              value={draft.image_url}
              onChange={(event) => onChange({ image_url: event.target.value })}
            />
          </Field>
        </div>
        {/* La URL no se edita y se enseña para que se vea por qué: es la clave
            con la que el scraper reconoce esta oferta, así que cambiarla no
            corregiría nada, crearía otra ficha y dejaría esta huérfana. */}
        <p className="edit-note">
          La dirección del anuncio no se toca: es la clave con la que el scraper
          reconoce esta oferta.
          <span className="mono edit-url">{offer.url}</span>
        </p>
      </Section>

      {/* Reatribuir es la corrección cara: la oferta se mide contra la mediana de
          su binomio marca-modelo, así que una versión mal resuelta no estropea
          una celda, estropea la puntuación entera. */}
      <Section
        title="Atribución"
        hint="El modelo decide contra qué mercado se compara esta oferta."
      >
        <ModelField
          value={draft.car_model_id}
          current={offer.car_model}
          models={models}
          touch={touch}
          pinned={pinned.has("car_model_id")}
          onChange={(car_model_id) => onChange({ car_model_id })}
        />
        <Field name="dealer_id" label="Dealer" pinned={pinned}>
          <select
            id="edit-dealer-id"
            className="select"
            value={draft.dealer_id}
            onChange={(event) => onChange({ dealer_id: Number(event.target.value) })}
          >
            {/* El dealer de la oferta puede estar inactivo y no venir en la
                lista: se añade delante para que el desplegable no aparezca
                vacío justo sobre el dato que describe. */}
            {(dealers.some((dealer) => dealer.id === offer.dealer.id)
              ? dealers
              : [offer.dealer as DealerWithStats, ...dealers]
            ).map((dealer) => (
              <option key={dealer.id} value={dealer.id}>
                {dealer.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="edit-section">
      <h3 className="edit-legend">{title}</h3>
      {hint ? <p className="edit-note">{hint}</p> : null}
      {children}
    </section>
  );
}

/**
 * Un campo con su rótulo y, si lo lleva, su marca de anclado.
 *
 * La marca no es decoración: dice que ese valor lo escribió una persona y que el
 * scraper ya no lo escribe. Es lo que hay que saber cuando el dato no cuadra con
 * el anuncio —puede ser que el anuncio haya cambiado y aquí siga la corrección
 * vieja—, y lo que explica el botón de soltar que hay al final del formulario.
 */
function Field({
  name,
  label,
  hint,
  pinned,
  children,
}: {
  name: OfferEditableField;
  label: string;
  hint?: string;
  pinned: Set<OfferEditableField>;
  children: ReactNode;
}) {
  const isPinned = pinned.has(name);
  return (
    <div className="edit-field">
      <label htmlFor={`edit-${name.replace(/_/g, "-")}`}>
        {label}
        {hint ? <span className="edit-hint">{hint}</span> : null}
        {isPinned ? (
          <span className="edit-pin" title="Lo llevas tú: el scraper no lo escribe">
            a mano
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

/**
 * La versión a la que cuelga la oferta.
 *
 * En escritorio, un desplegable: el catálogo se recorre escribiendo y el teclado
 * está debajo de las manos. En un móvil no, y por lo mismo que en la hoja de
 * filtros: iOS dibuja un `<select>` largo como una rueda, y un catálogo partido
 * por acabado —un Audi A3 son veintitrés filas que se llaman casi igual— es
 * exactamente lo que no se puede girar a ciegas. Ahí van un buscador y una lista
 * de opciones de 44 pt.
 */
function ModelField({
  value,
  current,
  models,
  touch,
  pinned,
  onChange,
}: {
  value: number;
  current: Offer["car_model"];
  models: CarModelWithStats[];
  touch: boolean;
  pinned: boolean;
  onChange: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const centered = useRef(false);

  /* La versión puesta, a la vista al abrir.
   *
   * La lista va en orden de catálogo y la de esta oferta puede caer en la fila
   * ciento veinte: sin esto, el control se abre enseñando siete Audi A3 y la
   * marca de «elegida» queda fuera de la ventanilla, que es justo lo que hay que
   * ver antes de tocar nada. Se mueve el scroll de la propia lista y no
   * `scrollIntoView`, que arrastraría también a la hoja que la contiene.
   *
   * Una sola vez, y en cuanto el catálogo llega: después el scroll es de quien
   * mira, y recolocarlo al teclear sería quitarle la lista de las manos. */
  useEffect(() => {
    if (centered.current) return;
    const box = list.current;
    const option = box?.querySelector<HTMLElement>(".sheet-option.on");
    if (!box || !option) return;
    centered.current = true;
    const offset =
      option.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, offset - box.clientHeight / 2 + option.offsetHeight / 2);
  });

  // La versión de la oferta puede estar inactiva y no venir en el listado: se
  // añade siempre, porque es la que hay que poder ver seleccionada.
  const known = useMemo(
    () =>
      models.some((model) => model.id === current.id)
        ? models
        : [current as CarModelWithStats, ...models],
    [models, current],
  );

  // Solo para la lista táctil. El desplegable de escritorio se recorre
  // escribiendo, así que ahí no hay nada que acotar ni que recortar.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = needle
      ? known.filter((model) => model.display_name.toLowerCase().includes(needle))
      : known;
    // Tope de cuarenta filas: la lista es un control dentro de una hoja, no la
    // pantalla, y el buscador está justo encima para acortarla.
    const top = found.slice(0, 40);
    // La versión puesta se cuela siempre, aunque el tope o el filtro la dejen
    // fuera. El catálogo va en orden alfabético y son ciento setenta y ocho
    // filas: un Toyota no entra en las cuarenta primeras, así que sin esto el
    // control se abría sin ninguna opción marcada y no decía qué hay puesto.
    const selected = known.find((model) => model.id === value);
    return selected && !top.some((model) => model.id === value)
      ? [selected, ...top]
      : top;
  }, [known, query, value]);

  const label = (
    <>
      Modelo y versión
      {pinned ? (
        <span className="edit-pin" title="Lo llevas tú: el scraper no lo escribe">
          a mano
        </span>
      ) : null}
    </>
  );

  if (!touch) {
    return (
      <div className="edit-field">
        <label htmlFor="edit-car-model">{label}</label>
        <select
          id="edit-car-model"
          className="select"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {known.map((model) => (
            <option key={model.id} value={model.id}>
              {model.display_name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="edit-field">
      <label htmlFor="edit-car-model">{label}</label>
      <input
        id="edit-car-model"
        className="input"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Filtrar la lista de versiones…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="sheet-options" role="listbox" aria-label="Modelo y versión" ref={list}>
        {matches.map((model) => (
          <button
            key={model.id}
            type="button"
            role="option"
            aria-selected={model.id === value}
            className={`sheet-option${model.id === value ? " on" : ""}`}
            onClick={() => onChange(model.id)}
          >
            <span className="sheet-option-name">{model.display_name}</span>
            <span className="sheet-tick" aria-hidden="true">
              {model.id === value ? "✓" : ""}
            </span>
          </button>
        ))}
        {matches.length === 0 ? (
          <p className="sheet-empty">Ninguna versión se llama así.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Qué lleva la mano y cómo devolverlo.
 *
 * Un anclaje sin salida es una decisión de hoy que sobrevive a la fuente para
 * siempre: si el dealer corrige el anuncio, la corrección vieja seguiría tapando
 * el dato bueno sin que nada lo dijera. Soltar no borra los valores —los deja
 * donde están—, solo devuelve esas columnas al scraper.
 */
function ManualNote({
  offer,
  busy,
  onRelease,
}: {
  offer: Offer;
  busy: boolean;
  onRelease: () => void;
}) {
  if (offer.manual_fields.length === 0) {
    return (
      <p className="edit-note">
        Lo que corrijas aquí queda fijado: el scraper seguirá actualizando el resto
        de la oferta, pero no volverá a escribir esos campos.
      </p>
    );
  }

  const one = offer.manual_fields.length === 1;
  return (
    <div className="edit-manual">
      <p className="edit-note">
        {one ? "Un campo lo llevas tú" : `${offer.manual_fields.length} campos los llevas tú`}:{" "}
        {offer.manual_fields
          .map((field) => FIELD_LABELS[field])
          .join(", ")
          .toLowerCase()}
        . El scraper {one ? "no lo escribe" : "no los escribe"}
        {offer.edited_at ? ` · corregido el ${formatDateTime(offer.edited_at)}` : ""}.
      </p>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onRelease}>
        Devolver al scraper
      </button>
    </div>
  );
}

/** Cómo se llama cada campo anclado en la frase de arriba. */
const FIELD_LABELS: Record<OfferEditableField, string> = {
  title: "Título",
  price: "Precio",
  original_price: "PVP anunciado",
  currency: "Moneda",
  year: "Año",
  mileage_km: "Kilómetros",
  power_hp: "Potencia",
  condition: "Estado",
  fuel_type: "Combustible",
  transmission: "Cambio",
  location: "Ubicación",
  image_url: "Foto",
  car_model_id: "Modelo",
  dealer_id: "Dealer",
};
