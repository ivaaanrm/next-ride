# Diseño: ingesta de coches.net mediante navegador

## Objetivo

Capturar y enviar hasta 15 ofertas de coches.net para Audi A4 Allroad quattro,
Audi A3 y Mercedes Clase A usando únicamente páginas públicas y navegación de
solo lectura.

## Enfoque aprobado

Usar el navegador para aplicar los filtros oficiales del portal y cargar 20
tarjetas por modelo. Guardar una captura JSON compacta con título, URL, precio
de contado, combustible, año, kilómetros, potencia, ubicación e imagen.

Normalizar la captura con `scrapers/cochesnet.py`, puntuar las 20 candidatas con
pesos 0,40 precio, 0,35 kilometraje y 0,25 año, y conservar las 15 mejores.

## Normalización

- Usar `Coches.net` como nombre del dealer.
- Resolver marca y modelo desde el target configurado.
- Inferir la transmisión desde el título: `S tronic`, `Tiptronic`, `automático`,
  `automatic` o `DSG` significan `automatic`; en caso contrario usar `manual`.
- Mapear las etiquetas de combustible al enum real de la API.
- Canonicalizar la URL a `/{modelo}-{id}-covo.aspx` para mantener la
  deduplicación histórica y guardar la URL descriptiva original en `raw`.
- Usar `cochesnet-{id}` como `external_id`.
- Conservar en `raw` la etiqueta original, la puntuación y la regla de selección.

## Validación y envío

Validar las 45 seleccionadas contra `OfferIngest` y ejecutar primero una
simulación del ingestor. Si un target supera el freno de emergencia, no enviar
ninguna oferta de ese target. Enviar las válidas en lotes de 25 como máximo y
actualizar `seen.json` solo tras respuestas 2xx.

## Verificación

Comprobar la respuesta de la API, el reparto por target en `seen.json` y el
recuento persistido en PostgreSQL. Añadir el resultado al informe diario.
