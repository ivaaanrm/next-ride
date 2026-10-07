/**
 * Réplica del `slugify` del backend, solo para avisar de duplicados *antes* de
 * enviar el formulario. La autoridad sigue siendo el backend, que responde 409
 * si el slug ya existe; esto es únicamente una pista de UX.
 */
export function slugify(...parts: (string | null | undefined)[]): string {
  const text = parts.filter(Boolean).join(" ");
  const withoutAccents = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = withoutAccents
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "sin-nombre";
}
