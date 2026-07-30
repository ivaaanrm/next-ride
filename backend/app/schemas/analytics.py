"""Esquemas de la vista Analítica.

La unidad de análisis aquí **no** es `car_models`, es el binomio marca-modelo.
El catálogo se fragmenta por acabado (un «Audi A4 Allroad Quattro» son once filas
de `car_models`, una por versión) y comparar a ese nivel no responde ninguna
pregunta: las medianas salen de dos o tres ofertas y el ruido tapa la señal. Los
binomios se agrupan además ignorando mayúsculas, porque el scraper trae la misma
marca escrita de varias formas («A4 Allroad Quattro» y «A4 Allroad quattro»).
"""

from pydantic import BaseModel


class SegmentPoint(BaseModel):
    """Una oferta reducida a lo que dibujan los gráficos.

    Va sin `url` ni `image_url` a propósito: esto se pide para nubes de puntos de
    cientos de ofertas y el detalle ya vive en la vista de Ofertas.
    """

    id: int
    price: float
    mileage_km: int | None = None
    year: int | None = None
    km_per_year: float | None = None
    value_score: float | None = None
    discount_pct: float | None = None
    dealer: str
    trim: str
    title: str


class YearPoint(BaseModel):
    year: int
    offers: int
    median_price: float


class DealerPoint(BaseModel):
    dealer_id: int
    dealer: str
    offers: int
    median_price: float
    min_price: float


class MixSlice(BaseModel):
    """Recuento por valor de un enum (combustible, cambio, estado)."""

    key: str
    offers: int


class SegmentMix(BaseModel):
    fuel: list[MixSlice] = []
    transmission: list[MixSlice] = []
    condition: list[MixSlice] = []


class PriceTrend(BaseModel):
    """Regresión por mínimos cuadrados de precio sobre kilómetros.

    `price_per_10k_km` es la lectura útil: lo que el mercado de *este* binomio
    cobra por cada 10.000 km menos de uso. Positivo es el comportamiento normal.
    `r2` viaja con ella porque con ocho ofertas una pendiente puede ser puro
    ruido, y una pendiente sin su ajuste es un número que aparenta saber algo.
    """

    slope: float
    intercept: float
    r2: float
    n: int
    price_per_10k_km: float


class Segment(BaseModel):
    """Un binomio marca-modelo con sus agregados.

    Los agregados salen de `SQL` sobre el conjunto **filtrado entero**. Lo que
    depende de `value_score` no: esa puntuación se calcula en Python, así que se
    acota igual que el orden por puntuación del listado y solo se rellena en los
    binomios con detalle. `offers_sampled` dice sobre cuántas ofertas se calculó,
    para que no se lea como si describiera todo el segmento cuando no lo hace.
    """

    key: str
    make: str
    model: str
    label: str

    offers: int
    dealers: int
    trims: int

    min_price: float | None = None
    p25_price: float | None = None
    median_price: float | None = None
    p75_price: float | None = None
    max_price: float | None = None
    avg_price: float | None = None
    avg_mileage_km: float | None = None
    avg_year: float | None = None
    avg_km_per_year: float | None = None
    avg_discount_pct: float | None = None

    # Solo en los binomios con detalle: dependen de la puntuación en Python.
    detailed: bool = False
    offers_sampled: int = 0
    avg_value_score: float | None = None
    trend: PriceTrend | None = None

    by_year: list[YearPoint] = []
    by_dealer: list[DealerPoint] = []
    mix: SegmentMix = SegmentMix()
    points: list[SegmentPoint] = []


class AnalyticsSegments(BaseModel):
    """Todos los binomios del conjunto filtrado; unos pocos con detalle.

    El selector necesita la lista completa para poder elegir, pero mandar la nube
    de puntos de treinta binomios sería pesar de más por algo que nadie mira: el
    detalle solo se rellena para los que pide `keys` (o los de más ofertas si no
    se pide ninguno). `max_detail` es el tope, y no es arbitrario — son las
    ranuras de color que el gráfico puede distinguir.
    """

    segments: list[Segment]
    detail_keys: list[str]
    offers: int
    max_detail: int
