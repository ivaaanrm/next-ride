/**
 * Payloads crudos del scraper en R2.
 *
 * Son datos de diagnóstico: se consultan de uvas a peras y pesan más que la
 * oferta entera. En D1 ocuparían la mayor parte de la base (que tiene tope) y
 * engordarían cada lectura de la tabla de ofertas. Aquí se guarda **un objeto
 * por lote de ingesta** —un array alineado con el lote— y la oferta apunta a su
 * posición con `raw_ref = "<clave>#<índice>"`. Un lote son una escritura en R2,
 * no veinticinco.
 */

const PREFIX = "raw/batches";

export async function putRawBatch(
  bucket: R2Bucket,
  raws: (Record<string, unknown> | null)[],
): Promise<string | null> {
  if (!raws.some((raw) => raw !== null)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${PREFIX}/${day}/${crypto.randomUUID()}.json`;
  await bucket.put(key, JSON.stringify(raws), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

export const rawRef = (key: string, index: number) => `${key}#${index}`;

export async function getRaw(
  bucket: R2Bucket,
  ref: string | null,
): Promise<Record<string, unknown> | null> {
  if (!ref) return null;
  const hash = ref.lastIndexOf("#");
  const key = hash === -1 ? ref : ref.slice(0, hash);
  const object = await bucket.get(key);
  if (!object) return null;
  const body = await object.json<unknown>();
  if (hash === -1) return (body as Record<string, unknown>) ?? null;
  const items = Array.isArray(body) ? body : [];
  return (items[Number(ref.slice(hash + 1))] as Record<string, unknown>) ?? null;
}
