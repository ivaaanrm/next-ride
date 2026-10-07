/**
 * Configuración inicial de fuentes de rastreo; después de crearla, la API es la
 * autoridad. La semilla vive en `migrations/0001_seed_scraping.sql`, generada
 * desde estos valores con `scripts/gen-seed-migration.ts`.
 */

export interface DefaultSource {
  key: string;
  name: string;
  base_url: string;
  search_url_template: string | null;
  listing_url: string | null;
  access: "fetch" | "playwright" | "browser" | "manual";
  notes: string;
  config: Record<string, unknown>;
}

export interface DefaultTarget {
  source_key: string;
  make: string;
  model: string;
  search_url?: string;
  search_params: Record<string, unknown>;
}

export const DEFAULT_SOURCES: DefaultSource[] = [
  {
    key: "flexicar",
    name: "Flexicar",
    base_url: "https://www.flexicar.es",
    search_url_template: "https://www.flexicar.es/{make_slug}/{model_slug}/segunda-mano/",
    listing_url: null,
    access: "fetch",
    notes:
      "El HTML trae __NEXT_DATA__. Contrastar el precio de la tarjeta con la ficha " +
      "y usar el precio de contado de la ficha.",
    config: {
      extractor: "scrapers/flexicar.py",
      vehicles_api_url: "https://services.flexicar.es/api/v1/vehicles",
      make_slug_aliases: { mercedes: "mercedes-benz" },
      _defaults_version: 2,
    },
  },
  {
    key: "coches.net",
    name: "Coches.net",
    base_url: "https://www.coches.net",
    search_url_template:
      "https://www.coches.net/search/?MakeIds%5B0%5D={make_id}&ModelIds%5B0%5D={model_id}",
    listing_url: null,
    access: "playwright",
    notes:
      "Listado público renderizado con JavaScript. Usar Playwright y navegador " +
      "real como fallback, siempre en modo de solo lectura.",
    config: {
      extractor: "scrapers/cochesnet.py",
      card_selector: ".mt-ListAds-item.mt-CardAd",
      _defaults_version: 1,
    },
  },
  {
    key: "ocasionplus",
    name: "OcasionPlus",
    base_url: "https://www.ocasionplus.com",
    search_url_template: null,
    listing_url: null,
    access: "playwright",
    notes:
      "Descubrir la URL desde la interfaz pública y persistirla en el target. " +
      "Usar navegador real como fallback y no superar tres páginas.",
    config: {
      extractor: "scrapers/ocasionplus.py",
      card_hint: "atributos data-test",
      _defaults_version: 1,
    },
  },
  {
    key: "irurimotor",
    name: "Iruri Motor",
    base_url: "https://irurimotor.com",
    search_url_template: "https://irurimotor.com/wp-json/vehica/v1/cars?marca={make_slug}",
    listing_url:
      "https://irurimotor.com/todoterrenos-coches-de-segunda-mano-y-ocasion-" +
      "sunbilla-navarra/?type=todoterrenos",
    access: "fetch",
    notes: "El endpoint público de Vehica entrega el inventario en JSON.",
    config: { extractor: "scrapers/irurimotor.py", _defaults_version: 1 },
  },
  {
    key: "compramostucoche",
    name: "Compramos Tu Coche",
    base_url: "https://www.compramostucoche.es",
    search_url_template:
      "https://www.compramostucoche.es/comprar-coche/" +
      "?brand={brand}&model={brand}.{model_token}&sort=STANDARD_PRICE_ASC",
    listing_url: "https://www.compramostucoche.es/comprar-coche/",
    access: "fetch",
    notes:
      "Listado renderizado en servidor; las clases CSS llevan hash y solo son " +
      "estables los atributos data-qa-selector. Los tokens de marca y modelo no " +
      "son los que muestra la interfaz: brand usa guion bajo (MERCEDES_BENZ) y " +
      "model usa el nombre interno en aleman (A-KLASSE, PAJERO). Un token " +
      "invalido NO da error: devuelve 200 con el catalogo sin filtrar, asi que " +
      "hay que exigir el chip filter-item-vehicle antes de dar el listado por " +
      "bueno. Cada carroceria es un modelo aparte y no se pueden combinar en una " +
      "URL, por eso el target lleva model_tokens.",
    config: {
      extractor: "scrapers/compramostucoche.py",
      card_selector: '[data-qa-selector="ad-item"]',
      assert_selector: '[data-qa-selector="filter-item-vehicle"]',
      page_size: 10,
      seller_name: "Autohero",
      _defaults_version: 1,
    },
  },
  {
    key: "quadis",
    name: "Quadis",
    base_url: "https://www.quadis.es",
    search_url_template: "https://www.quadis.es/coches/{make_slug}/{model_slug}",
    listing_url: "https://www.quadis.es/coches",
    access: "browser",
    notes:
      "El listado público renderiza tarjetas .car-card. robots.txt bloquea " +
      "las URLs con query string; usar navegador para los targets que necesiten IDs.",
    config: {
      extractor: "scrapers/quadis.py",
      card_selector: ".car-card",
      make_slug_aliases: { mercedes: "mercedes-benz" },
      _defaults_version: 1,
    },
  },
];

export const DEFAULT_TARGETS: DefaultTarget[] = [
  {
    source_key: "flexicar",
    make: "Audi",
    model: "A4 Allroad quattro",
    search_params: { make_slug: "audi", model_slug: "a4-allroad-quattro" },
  },
  {
    source_key: "coches.net",
    make: "Audi",
    model: "A4 Allroad quattro",
    search_params: { make_id: 4, model_id: 925 },
  },
  {
    source_key: "flexicar",
    make: "Mercedes",
    model: "Clase A",
    search_params: { make_slug: "mercedes-benz", model_slug: "clase-a" },
  },
  {
    source_key: "coches.net",
    make: "Mercedes",
    model: "Clase A",
    search_params: { make_id: 28, model_id: 275 },
  },
  { source_key: "ocasionplus", make: "Mercedes", model: "Clase A", search_params: {} },
  {
    source_key: "flexicar",
    make: "Audi",
    model: "A3",
    search_params: { make_slug: "audi", model_slug: "a3" },
  },
  {
    source_key: "coches.net",
    make: "Audi",
    model: "A3",
    search_params: { make_id: 4, model_id: 345 },
  },
  { source_key: "ocasionplus", make: "Audi", model: "A3", search_params: {} },
  {
    source_key: "irurimotor",
    make: "Mitsubishi",
    model: "Montero",
    search_url: "https://irurimotor.com/wp-json/vehica/v1/cars?marca=mitsubishi",
    search_params: {},
  },
  {
    source_key: "quadis",
    make: "Audi",
    model: "A3",
    search_url: "https://www.quadis.es/coches/audi/a3",
    search_params: { make_id: 13, model_id: 37 },
  },
  {
    source_key: "quadis",
    make: "Audi",
    model: "A4 Allroad quattro",
    search_url: "https://www.quadis.es/coches?makeId=13&modelId=38",
    search_params: { make_id: 13, model_id: 38 },
  },
  {
    source_key: "quadis",
    make: "Mercedes",
    model: "Clase A",
    search_url: "https://www.quadis.es/coches/mercedes-benz/clase-a",
    search_params: { make_id: 4, model_id: 12 },
  },
  // Compramos Tu Coche indexa cada carrocería como un modelo distinto y no
  // admite varios `model` en la misma URL, así que el cupo se completa
  // recorriendo `model_tokens` en el orden del propio portal.
  {
    source_key: "compramostucoche",
    make: "Audi",
    model: "A3",
    search_url:
      "https://www.compramostucoche.es/comprar-coche/" +
      "?brand=AUDI&model=AUDI.A3&sort=STANDARD_PRICE_ASC",
    search_params: {
      brand: "AUDI",
      model_tokens: ["A3", "A3 SPORTBACK", "A3 LIMOUSINE", "A3 ALLSTREET"],
    },
  },
  {
    source_key: "compramostucoche",
    make: "Audi",
    model: "A4 Allroad quattro",
    search_url:
      "https://www.compramostucoche.es/comprar-coche/" +
      "?brand=AUDI&model=AUDI.A4%20ALLROAD&sort=STANDARD_PRICE_ASC",
    search_params: { brand: "AUDI", model_tokens: ["A4 ALLROAD"] },
  },
  {
    source_key: "compramostucoche",
    make: "Mercedes",
    model: "Clase A",
    search_url:
      "https://www.compramostucoche.es/comprar-coche/" +
      "?brand=MERCEDES_BENZ&model=MERCEDES_BENZ.A-KLASSE&sort=STANDARD_PRICE_ASC",
    search_params: {
      brand: "MERCEDES_BENZ",
      model_tokens: ["A-KLASSE", "A-KLASSE LIMOUSINE"],
    },
  },
  {
    source_key: "compramostucoche",
    make: "Mitsubishi",
    model: "Montero",
    search_url:
      "https://www.compramostucoche.es/comprar-coche/" +
      "?brand=MITSUBISHI&model=MITSUBISHI.PAJERO&sort=STANDARD_PRICE_ASC",
    search_params: { brand: "MITSUBISHI", model_tokens: ["PAJERO"] },
  },
];

/** Espacios colapsados y en minúsculas: clave estable compartida por API, UI y skill. */
export function canonicalMakeModelKey(make: string, model: string): string {
  const clean = (value: string) => value.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  return `${clean(make)}|${clean(model)}`;
}

function slug(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase();
  return ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Los `{campo}` de una plantilla al estilo `str.format` de Python. */
export function templateFields(template: string | null | undefined): Set<string> {
  const fields = new Set<string>();
  for (const match of (template ?? "").matchAll(/\{([^{}]*)\}/g)) fields.add(match[1]);
  return fields;
}

/** Completa parámetros deducibles; los IDs propios de cada portal se descubren. */
export function defaultSearchParams(
  source: { search_url_template: string | null; config: Record<string, unknown> },
  make: string,
  model: string,
): Record<string, string> {
  const fields = templateFields(source.search_url_template);
  const result: Record<string, string> = {};
  if (fields.has("make_slug")) {
    const aliases = (source.config.make_slug_aliases ?? {}) as Record<string, string>;
    result.make_slug = String(aliases[make.toLowerCase()] || slug(make));
  }
  if (fields.has("model_slug")) result.model_slug = slug(model);
  return result;
}

/**
 * La URL de búsqueda efectiva de un target: la persistida, o la plantilla de la
 * fuente rellenada si están todos sus campos. Nunca una URL a medias.
 */
export function renderSearchUrl(
  template: string | null,
  params: Record<string, unknown>,
  override: string | null,
): string | null {
  if (override) return override;
  if (!template) return null;
  const fields = templateFields(template);
  for (const field of fields) {
    if (!(field in params) || field === "") return null;
  }
  return template.replace(/\{([^{}]*)\}/g, (_, field: string) => String(params[field]));
}
