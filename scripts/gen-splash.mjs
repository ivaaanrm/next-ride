#!/usr/bin/env node
/**
 * gen-splash — pantallas de arranque de la PWA para iPhone.
 *
 * iOS no genera la pantalla de arranque de una web instalada a partir del
 * manifest (Android sí): sin un `apple-touch-startup-image` que case con el
 * tamaño exacto del dispositivo, la app instalada arranca en blanco, y en modo
 * oscuro ese blanco es un fogonazo. Una imagen por tamaño de pantalla y tema.
 *
 *   node scripts/gen-splash.mjs
 *
 * Escribe `public/splash/*.png` y el bloque de `<link>` entre los marcadores
 * de `index.html`. El icono sale de `public/icons/source/icon.svg`, así que
 * cambiar el icono y volver a correr esto es todo lo que hace falta. Al
 * cambiar el diseño, sube `VERSION`: /splash se sirve como inmutable.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "splash");
const VERSION = "v2";

/**
 * Pantallas en puntos CSS (retrato) y su densidad. Cubre del iPhone X a la
 * gama Pro actual; los modelos que compartan tamaño de pantalla con alguno de
 * estos (la mayoría de cada generación) usan la misma imagen.
 */
const DEVICES = [
  { width: 375, height: 812, dpr: 3, models: "X, XS, 11 Pro, 12/13 mini" },
  { width: 390, height: 844, dpr: 3, models: "12, 13, 14, 16e" },
  { width: 393, height: 852, dpr: 3, models: "14 Pro, 15, 15 Pro, 16" },
  { width: 402, height: 874, dpr: 3, models: "16 Pro, 17, 17 Pro" },
  { width: 420, height: 912, dpr: 3, models: "Air" },
  { width: 430, height: 932, dpr: 3, models: "14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus" },
  { width: 440, height: 956, dpr: 3, models: "16 Pro Max, 17 Pro Max" },
];

/** Los mismos fondos que `--bg` en cada tema (`src/styles.css`). */
const THEMES = {
  light: "#fbfbfb",
  dark: "#121211",
};

/** Lado del icono en puntos CSS: el de la pantalla de arranque nativa de iOS. */
const ICON_PT = 96;
/** Radio de la esquina, en proporción al lado: el squircle aproximado de iOS. */
const CORNER = 0.225;

const iconSvg = readFileSync(join(ROOT, "public", "icons", "source", "icon.svg"), "utf8")
  // Solo el elemento <svg>: los comentarios del maestro no hacen falta aquí.
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();
const iconBody = iconSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

function splashSvg(width, height, background) {
  return (scale) => {
    const w = width * scale;
    const h = height * scale;
    const icon = ICON_PT * scale;
    const x = (w - icon) / 2;
    // Un poco por encima del centro óptico, como las pantallas nativas.
    const y = (h - icon) / 2 - h * 0.04;
    const r = icon * CORNER;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${background}"/>
  <defs><clipPath id="c"><rect x="${x}" y="${y}" width="${icon}" height="${icon}" rx="${r}" ry="${r}"/></clipPath></defs>
  <g clip-path="url(#c)">
    <svg x="${x}" y="${y}" width="${icon}" height="${icon}" viewBox="0 0 512 512">${iconBody}</svg>
  </g>
</svg>`;
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const links = [];
for (const device of DEVICES) {
  const px = `${device.width * device.dpr}x${device.height * device.dpr}`;
  for (const [theme, background] of Object.entries(THEMES)) {
    const file = `${px}-${theme}.${VERSION}.png`;
    const svg = splashSvg(device.width, device.height, background)(device.dpr);
    await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9, palette: true })
      .toFile(join(OUT, file));
    const media = [
      `(device-width: ${device.width}px)`,
      `(device-height: ${device.height}px)`,
      `(-webkit-device-pixel-ratio: ${device.dpr})`,
      "(orientation: portrait)",
      `(prefers-color-scheme: ${theme})`,
    ].join(" and ");
    links.push(
      `    <link rel="apple-touch-startup-image" media="${media}" href="/splash/${file}" />`,
    );
  }
}

// Inyecta los enlaces entre los marcadores de index.html.
const htmlPath = join(ROOT, "index.html");
const html = readFileSync(htmlPath, "utf8");
const START = "<!-- splash:start -->";
const END = "<!-- splash:end -->";
if (!html.includes(START) || !html.includes(END)) {
  throw new Error(`index.html necesita los marcadores ${START} y ${END}`);
}
const updated = html.replace(
  new RegExp(`${START}[\\s\\S]*?${END}`),
  `${START}\n${links.join("\n")}\n    ${END}`,
);
writeFileSync(htmlPath, updated);
console.log(`${links.length} pantallas de arranque en public/splash/ y enlazadas en index.html`);
