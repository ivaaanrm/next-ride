/**
 * Configuración de la puntuación de valor. La respuesta lleva siempre los
 * defaults al lado de lo vigente para que la UI enseñe el desvío y ofrezca
 * «restaurar» sin otro endpoint. El cambio es de la cuenta: puntúa su catálogo
 * y no toca la puntuación de ninguna otra.
 */
import { router } from "../app";
import { parseBody } from "../lib/http";
import { requireUser } from "../middleware";
import { DEFAULT_PARAMS, DEFAULT_WEIGHTS, ScoreConfigUpdate } from "../schemas/scoring";
import {
  componentInfo,
  getScoringConfig,
  saveScoringConfig,
  type ScoringConfig,
} from "../services/scoring";

const read = (config: ScoringConfig) => ({
  weights: config.weights,
  params: config.params,
  components: componentInfo(config),
  default_weights: DEFAULT_WEIGHTS,
  default_params: DEFAULT_PARAMS,
  updated_at: config.updated_at,
});

export const scoringRoutes = router();
scoringRoutes.use(requireUser);

scoringRoutes.get("/config", async (c) =>
  c.json(read(await getScoringConfig(c.var.db, c.var.user.id))),
);

scoringRoutes.put("/config", async (c) => {
  const payload = await parseBody(c, ScoreConfigUpdate);
  return c.json(
    read(await saveScoringConfig(c.var.db, c.var.user.id, payload.weights, payload.params)),
  );
});
