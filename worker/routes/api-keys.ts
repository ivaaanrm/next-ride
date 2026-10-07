/**
 * API keys del servicio scraper. Cada cuenta ve y revoca solo las suyas, y lo
 * que su scraper ingesta con ellas entra en ella.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { router } from "../app";
import { apiKeys } from "../db/schema";
import { notFound, parseBody, parseId } from "../lib/http";
import { generateApiKey } from "../lib/security";
import { requireUser } from "../middleware";
import { apiKeyRead } from "../services/serialize";

export const apiKeysRoutes = router();
apiKeysRoutes.use(requireUser);

apiKeysRoutes.get("/", async (c) => {
  const rows = await c.var.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.user_id, c.var.user.id))
    .orderBy(desc(apiKeys.created_at), desc(apiKeys.id));
  return c.json(rows.map(apiKeyRead));
});

apiKeysRoutes.post("/", async (c) => {
  const payload = await parseBody(c, z.object({ name: z.string().min(1).max(120) }));
  const { raw, prefix, hashed } = await generateApiKey();
  const [key] = await c.var.db
    .insert(apiKeys)
    .values({
      user_id: c.var.user.id,
      name: payload.name,
      prefix,
      hashed_key: hashed,
      created_by_id: c.var.user.id,
    })
    .returning();
  // `raw` solo se devuelve aquí: en la base únicamente queda el hash.
  return c.json({ ...apiKeyRead(key), api_key: raw }, 201);
});

apiKeysRoutes.delete("/:id", async (c) => {
  const [key] = await c.var.db
    .update(apiKeys)
    .set({ is_active: false })
    .where(and(eq(apiKeys.id, parseId(c, "id")), eq(apiKeys.user_id, c.var.user.id)))
    .returning({ id: apiKeys.id });
  if (!key) throw notFound("API key no encontrada");
  return c.body(null, 204);
});
