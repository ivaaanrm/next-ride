# Diseño: recetas de acceso por dealer

## Objetivo

Documentar en `skill-next-ride/SKILL.md` el procedimiento real y reproducible
usado para acceder a Flexicar, coches.net, OcasionPlus e Iruri Motor.

## Estructura

Añadir una sección concisa después de las reglas generales de acceso. Empezar
con una tabla de decisión y continuar con una receta por dealer que indique:

- fuente o URL de búsqueda;
- método de acceso y fallback;
- campos o selectores estables;
- forma de cargar y capturar candidatos;
- extractor o normalizador que debe ejecutarse;
- controles de calidad específicos.

## Límites

Mantener las reglas comunes existentes: leer `robots.txt`, no resolver CAPTCHA,
no iniciar sesión, limitar las navegaciones y usar solo páginas públicas.
Evitar transcripciones de movimientos concretos del navegador y remitir a los
scripts deterministas para la normalización detallada.

## Correcciones relacionadas

Corregir las referencias a la configuración para usar las rutas reales
`targets.json` y `dealers.json`, ambas en la raíz del skill.

## Validación

Comprobar que `SKILL.md` sigue por debajo de 500 líneas, que todos los scripts y
fixtures mencionados existen y que el validador oficial del skill termina sin
errores.
