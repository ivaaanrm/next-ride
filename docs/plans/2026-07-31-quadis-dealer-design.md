# Diseño: incorporar Quadis y ejecutar un run aislado

## Objetivo

Incorporar `https://www.quadis.es/coches` como fuente activa de captación para
Mercedes Clase A, Audi A3 y Audi A4 Allroad quattro, sin desactivar ninguna de
las selecciones actuales de la plataforma. Después de configurarla, ejecutar
una iteración limitada exclusivamente a esos tres targets de Quadis.

## Diseño

- Añadir Quadis al catálogo de fuentes iniciales y a la receta operativa de
  `next-ride/SKILL.md` con el método de acceso que corresponda a la estructura
  pública y a su política de robots.
- Añadir los tres pares modelo-fuente a la selección activa conservando todos
  los targets existentes.
- Crear un extractor determinista de Quadis, con fixture de la respuesta fuente,
  normalización al contrato `OfferIngest` y límites iguales a los demás dealers.
- Permitir que el run se limite por fuente sin cambiar la selección persistente.
  La configuración completa seguirá viniendo de la API y el filtro solo afectará
  a la ejecución solicitada.
- Ejecutar primero el dry run. Solo si la validación y el freno de emergencia
  pasan, enviar las ofertas nuevas o con cambio de precio y actualizar el estado.
- Guardar un informe y los artefactos del run identificados como Quadis para no
  confundirlos con la ejecución diaria completa.

## Errores y seguridad

- No se sortearán CAPTCHA, login ni bloqueos técnicos.
- Se respetarán el límite de tres páginas, la pausa mínima de dos segundos y las
  reglas de `robots.txt` descritas en el skill.
- Un cambio de layout, más de un 40 % de descartes o una caída anómala a cero
  resultados detendrá el envío del target afectado.
- La clave de API no se escribirá en logs, fixtures ni informes.

## Verificación

- Comprobar que la API expone Quadis y los tres targets junto a las selecciones
  previas.
- Ejecutar pruebas del extractor sobre el fixture.
- Confirmar que el resumen del run contiene exactamente tres targets y que todos
  pertenecen a Quadis.
