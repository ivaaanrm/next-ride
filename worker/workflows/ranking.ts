/**
 * El ranking con IA como Workflow.
 *
 * Un run tarda minutos —varias vueltas del modelo con esfuerzo alto—, mucho más
 * que lo que una petición puede prolongarse con `waitUntil`. Aquí cada vuelta
 * es un paso durable: si el aislado muere a mitad, el Workflow se rehidrata
 * con las respuestas ya guardadas y sigue por donde iba, sin repetir llamadas.
 *
 * Eso exige que todo lo que pasa fuera de `step.do` sea determinista. La
 * conversación se reconstruye en cada rehidratación desde las salidas de los
 * pasos (el contexto cargado y cada respuesta del modelo), y las tools son
 * funciones puras sobre ese contexto (`runTool`). El historial es solo de
 * añadir: los bloques de razonamiento vuelven al modelo tal cual llegaron.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { eq, sql } from "drizzle-orm";

import { rankingRuns } from "../db/schema";
import { getDb } from "../lib/db";
import {
  buildContext,
  callModel,
  markFailed,
  persistRanking,
  rankingSettings,
  RankingError,
  RankingRequest,
  runTool,
  userPrompt,
  type AgentContext,
} from "../services/ranking-agent";

export interface RankingParams {
  runId: number;
}

interface Turn {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  refusalCategory: string | null;
}

/** Un fallo que no se arregla reintentando: se registra y el Workflow termina. */
const fatal = (error: unknown) =>
  error instanceof RankingError ? new NonRetryableError(error.message) : error;

export class RankingWorkflow extends WorkflowEntrypoint<Env, RankingParams> {
  async run(event: WorkflowEvent<RankingParams>, step: WorkflowStep) {
    const { runId } = event.payload;
    const settings = rankingSettings(this.env);

    try {
      // Las salidas de los pasos viajan como JSON: es lo que de verdad son (el
      // contexto y las respuestas de la API), y así no hay que demostrarle al
      // sistema de tipos que un `unknown` es serializable.
      const ctxJson = await step.do("load-context", async () => {
        const db = getDb(this.env);
        const [run] = await db.select().from(rankingRuns).where(eq(rankingRuns.id, runId));
        if (!run) throw new NonRetryableError(`RankingRun ${runId} no existe.`);
        // Sin cuenta no hay ofertas que mirar: rankear «todas» sería mezclar cuentas.
        if (!run.user_id) throw new NonRetryableError(`RankingRun ${runId} no tiene cuenta.`);
        await db
          .update(rankingRuns)
          .set({ status: "running", effort: settings.effort, model_used: settings.model })
          .where(eq(rankingRuns.id, runId));
        try {
          const request = RankingRequest.parse(run.request ?? null);
          const ctx = await buildContext(
            db,
            run.user_id,
            run.make_model_key,
            run.label,
            request,
            settings.maxOffers,
          );
          return JSON.stringify(ctx);
        } catch (error) {
          throw fatal(error);
        }
      });
      const ctx = JSON.parse(ctxJson) as AgentContext;

      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: "user", content: userPrompt(ctx) },
      ];
      const toolTrace: Record<string, unknown>[] = [];

      for (let iteration = 1; iteration <= settings.maxIterations; iteration++) {
        const turnJson = await step.do(
          `model-turn-${iteration}`,
          { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" }, timeout: "15 minutes" },
          async () => {
            if (!this.env.ANTHROPIC_API_KEY) {
              throw new NonRetryableError(
                "ANTHROPIC_API_KEY no está configurada: el ranking con IA está deshabilitado.",
              );
            }
            const response = await callModel(this.env.ANTHROPIC_API_KEY, settings, messages);
            await getDb(this.env)
              .update(rankingRuns)
              .set({
                iterations: iteration,
                input_tokens: sql`${rankingRuns.input_tokens} + ${response.usage.input_tokens ?? 0}`,
                output_tokens: sql`${rankingRuns.output_tokens} + ${response.usage.output_tokens ?? 0}`,
                model_used: response.model,
              })
              .where(eq(rankingRuns.id, runId));
            const turn: Turn = {
              content: response.content,
              stopReason: response.stop_reason,
              refusalCategory: response.stop_details?.category ?? null,
            };
            return JSON.stringify(turn);
          },
        );
        const turn = JSON.parse(turnJson) as Turn;

        if (turn.stopReason === "refusal") {
          throw new RankingError(
            `El modelo rechazó la petición (categoría: ${turn.refusalCategory ?? "desconocida"}).`,
          );
        }

        // `content` íntegro: preserva los bloques de razonamiento, que la API
        // exige reenviar sin modificar.
        messages.push({ role: "assistant", content: turn.content });
        if (turn.stopReason === "pause_turn") continue;

        const toolUses = turn.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
        );
        if (!toolUses.length) {
          throw new RankingError(
            turn.stopReason === "max_tokens"
              ? "Respuesta truncada por max_tokens antes de entregar el ranking."
              : "El agente terminó el turno sin llamar a `submit_ranking`.",
          );
        }

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        let finalPayload: Record<string, unknown> | null = null;
        for (const block of toolUses) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          toolTrace.push({ tool: block.name, input });
          const [content, payload] = runTool(ctx, block.name, input);
          results.push({ type: "tool_result", tool_use_id: block.id, content });
          if (payload) finalPayload = payload;
        }

        if (finalPayload) {
          const submitted = finalPayload;
          await step.do("persist-ranking", async () => {
            try {
              await persistRanking(this.env.DB, runId, ctx, submitted, toolTrace);
            } catch (error) {
              throw fatal(error);
            }
          });
          return;
        }
        messages.push({ role: "user", content: results });
      }

      throw new RankingError(
        `Se alcanzó el límite de ${settings.maxIterations} iteraciones sin ranking final.`,
      );
    } catch (error) {
      // Un `NonRetryableError` lanzado dentro de un paso vuelve como un `Error`
      // genérico con el nombre de la clase delante del mensaje: se quita.
      const raw = error instanceof Error ? error.message : String(error);
      const expected =
        error instanceof RankingError ||
        error instanceof NonRetryableError ||
        raw.startsWith("NonRetryableError: ");
      const message = expected
        ? raw.replace(/^(NonRetryableError: )+/, "")
        : `${error instanceof Error ? error.name : "Error"}: ${raw}`;
      console.warn(JSON.stringify({ message: "ranking run failed", runId, error: message }));
      await step.do("mark-failed", async () => markFailed(getDb(this.env), runId, message));
    }
  }
}
