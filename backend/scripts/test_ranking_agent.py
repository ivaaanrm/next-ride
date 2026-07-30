"""Prueba el loop del agente de ranking con la API de Anthropic simulada.

    docker compose exec backend python -m scripts.test_ranking_agent

Ejercita el loop completo (despacho de tools, salida estructurada, persistencia
y rutas de error) sin gastar tokens. Lo único que no cubre es el transporte HTTP
real: para eso hace falta una ANTHROPIC_API_KEY y disparar
`POST /api/v1/car-models/{id}/rank`.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionFactory
from app.models import CarModel, Offer, OfferStatus, RankingRun, RunStatus
from app.schemas.ranking import RankingRequest
from app.services import ranking_agent

ok, fail = 0, 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global ok, fail
    if condition:
        ok += 1
        print(f"  PASS  {label}" + (f"  ({detail})" if detail else ""))
    else:
        fail += 1
        print(f"  FAIL  {label}  {detail}")


# --------------------------------------------------------------------------- #
# Dobles de prueba con la forma que devuelve la Messages API
# --------------------------------------------------------------------------- #
class Block:
    def __init__(self, type_: str, **kwargs: Any) -> None:
        self.type = type_
        for key, value in kwargs.items():
            setattr(self, key, value)


class Usage:
    def __init__(self, input_tokens: int = 1200, output_tokens: int = 400) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class Response:
    def __init__(self, content: list[Block], stop_reason: str = "tool_use") -> None:
        self.content = content
        self.stop_reason = stop_reason
        self.usage = Usage()
        self.model = settings.ANTHROPIC_MODEL
        self.stop_details = None


def tool_use(name: str, tool_input: dict[str, Any], id_: str = "toolu_1") -> Block:
    return Block("tool_use", name=name, input=tool_input, id=id_)


def scripted(*responses: Response):
    """Devuelve un `_call_model` falso que reproduce las respuestas en orden."""
    queue = list(responses)
    seen: list[dict[str, Any]] = []

    async def fake_call(_client: Any, **kwargs: Any) -> Response:
        seen.append(kwargs)
        if not queue:
            raise AssertionError("El agente pidió más turnos de los previstos")
        return queue.pop(0)

    fake_call.seen = seen  # type: ignore[attr-defined]
    return fake_call


async def fresh_run(session, car_model_id: int) -> RankingRun:
    run = RankingRun(car_model_id=car_model_id, status=RunStatus.PENDING)
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


# --------------------------------------------------------------------------- #
async def main() -> None:
    settings.ANTHROPIC_API_KEY = settings.ANTHROPIC_API_KEY or "sk-ant-test-offline"
    original_call = ranking_agent._call_model

    async with SessionFactory() as session:
        car_model = await session.scalar(
            select(CarModel)
            .join(Offer, Offer.car_model_id == CarModel.id)
            .where(Offer.status == OfferStatus.ACTIVE)
            .limit(1)
        )
        if car_model is None:
            print("No hay modelos con ofertas activas. Ejecuta primero scripts.seed_demo")
            raise SystemExit(1)

        print(f"== contexto ({car_model.display_name}) ==")
        ctx = await ranking_agent.build_context(session, car_model, RankingRequest())
        check("candidatas cargadas", len(ctx.candidates) > 0, f"{len(ctx.candidates)} ofertas")

        stats_payload = ctx.market_stats_payload()
        check(
            "get_market_stats trae mediana y nº de dealers",
            stats_payload["median_price_eur"] is not None
            and stats_payload["distinct_dealers"] > 0,
            f"mediana={stats_payload['median_price_eur']} dealers={stats_payload['distinct_dealers']}",
        )

        offers_payload = ctx.offers_payload("price")
        prices = [o["price_eur"] for o in offers_payload]
        check("list_offers ordena por precio", prices == sorted(prices))
        check(
            "list_offers incluye las métricas",
            "platform_value_score" in offers_payload[0]["metrics"],
            ", ".join(offers_payload[0]["metrics"]),
        )
        by_score = [o["metrics"]["platform_value_score"] for o in ctx.offers_payload("value_score")]
        check("list_offers ordena por value_score", by_score == sorted(by_score, reverse=True))

        # El historial se precarga: en async, una carga perezosa reventaría aquí.
        content, final = await ranking_agent._run_tool(
            session, ctx, "get_offer_price_history", {"offer_id": next(iter(ctx.candidates))}
        )
        check("get_offer_price_history sin lazy-load", final is None and "history" in content)

        content, _ = await ranking_agent._run_tool(
            session, ctx, "get_offer_price_history", {"offer_id": 999_999}
        )
        check(
            "offer_id inexistente devuelve error útil",
            "valid_offer_ids" in content,
            json.loads(content)["error"][:52],
        )

        offer_ids = sorted(ctx.candidates)

        # ---------------------------------------------------------------- #
        print("\n== camino feliz (3 tools + submit_ranking) ==")
        rankings = [
            {
                "offer_id": oid,
                # Rangos desordenados y con huecos a propósito: el backend renumera.
                "rank": (index + 1) * 3,
                "score": 90 - index * 7,
                "verdict": ["excellent", "good", "fair", "poor", "avoid"][index % 5],
                "reasoning": f"Justificación {index}",
                "pros": ["precio", "km bajos"],
                "cons": ["sin garantía"],
            }
            for index, oid in enumerate(offer_ids)
        ]
        # Un offer_id inventado y un duplicado: deben descartarse.
        rankings.append(dict(rankings[0], offer_id=999_999, rank=99))
        rankings.append(dict(rankings[0], rank=100))

        fake = scripted(
            Response([tool_use("get_market_stats", {}, "t1")]),
            Response([tool_use("list_offers", {"sort_by": "value_score"}, "t2")]),
            Response([tool_use("get_offer_price_history", {"offer_id": offer_ids[0]}, "t3")]),
            Response(
                [tool_use("submit_ranking", {"summary": "Mercado con dispersión alta.", "rankings": rankings}, "t4")]
            ),
        )
        ranking_agent._call_model = fake

        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        await session.refresh(run, attribute_names=["items"])

        check("run completado", run.status == RunStatus.COMPLETED, run.error or "")
        check("resumen guardado", run.summary == "Mercado con dispersión alta.")
        check("4 iteraciones", run.iterations == 4, str(run.iterations))
        check("tokens acumulados", run.input_tokens == 4800 and run.output_tokens == 1600,
              f"in={run.input_tokens} out={run.output_tokens}")
        check("offers_considered", run.offers_considered == len(ctx.candidates), str(run.offers_considered))
        check("traza de 4 tools", len(run.tool_trace or []) == 4,
              " → ".join(step["tool"] for step in (run.tool_trace or [])))
        check("offer_id inventado descartado", len(run.items) == len(offer_ids),
              f"{len(run.items)} items de {len(rankings)} enviados")
        check("rangos renumerados 1..N", [i.rank for i in run.items] == list(range(1, len(run.items) + 1)),
              str([i.rank for i in run.items]))
        check("scores dentro de 0-100", all(0 <= i.score <= 100 for i in run.items))
        check("veredictos válidos", all(i.verdict.value for i in run.items),
              ", ".join(i.verdict.value for i in run.items[:3]))
        check("pros/cons persistidos", all(i.pros and i.cons for i in run.items))

        # Un turno con varios tool_use a la vez.
        print("\n== tools en paralelo en un mismo turno ==")
        ranking_agent._call_model = scripted(
            Response([tool_use("get_market_stats", {}, "p1"), tool_use("list_offers", {}, "p2")]),
            Response([tool_use("submit_ranking", {"summary": "ok", "rankings": rankings[: len(offer_ids)]}, "p3")]),
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("dos tools en un turno", run.status == RunStatus.COMPLETED, run.error or "")
        check("ambas quedan en la traza", len(run.tool_trace or []) == 3,
              " → ".join(step["tool"] for step in (run.tool_trace or [])))

        # ---------------------------------------------------------------- #
        print("\n== rutas de error ==")

        ranking_agent._call_model = scripted(Response([Block("text", text="No puedo.")], stop_reason="refusal"))
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("refusal -> run FAILED con motivo", run.status == RunStatus.FAILED and "rechaz" in (run.error or ""),
              (run.error or "")[:60])

        ranking_agent._call_model = scripted(
            Response([Block("text", text="Aquí va mi análisis…")], stop_reason="end_turn")
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("termina sin submit_ranking -> FAILED",
              run.status == RunStatus.FAILED and "submit_ranking" in (run.error or ""),
              (run.error or "")[:60])

        ranking_agent._call_model = scripted(
            Response([Block("text", text="…")], stop_reason="max_tokens")
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("max_tokens -> FAILED con motivo claro",
              run.status == RunStatus.FAILED and "max_tokens" in (run.error or ""),
              (run.error or "")[:60])

        # Bucle infinito de tools: debe cortar en RANKING_MAX_ITERATIONS.
        loops = settings.RANKING_MAX_ITERATIONS
        ranking_agent._call_model = scripted(
            *[Response([tool_use("get_market_stats", {}, f"l{i}")]) for i in range(loops)]
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("corta en el límite de iteraciones",
              run.status == RunStatus.FAILED and "iteraciones" in (run.error or ""),
              f"{run.iterations} iteraciones")

        ranking_agent._call_model = scripted(
            Response([tool_use("submit_ranking", {"summary": "vacío", "rankings": []}, "e1")])
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("submit_ranking vacío -> FAILED", run.status == RunStatus.FAILED, (run.error or "")[:60])

        ranking_agent._call_model = scripted(
            Response([tool_use("submit_ranking", {"summary": "x", "rankings": [
                {"offer_id": 424242, "rank": 1, "score": 50, "verdict": "good",
                 "reasoning": "", "pros": [], "cons": []}]}, "e2")])
        )
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("solo offer_ids inventados -> FAILED",
              run.status == RunStatus.FAILED and "válida" in (run.error or ""),
              (run.error or "")[:60])

        async def boom(_client: Any, **_kwargs: Any) -> Response:
            raise RuntimeError("connection reset by peer")

        ranking_agent._call_model = boom
        run = await fresh_run(session, car_model.id)
        run = await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        check("excepción de red -> FAILED, no propaga",
              run.status == RunStatus.FAILED and "connection reset" in (run.error or ""),
              (run.error or "")[:60])

        # ---------------------------------------------------------------- #
        print("\n== restricciones del comprador en el prompt ==")
        ctx.request = RankingRequest(max_budget=20000, max_mileage_km=50000, min_year=2021,
                                     priorities="prefiero automático")
        prompt = ranking_agent._user_prompt(ctx)
        check("presupuesto en el prompt", "20000 EUR" in prompt)
        check("kilometraje en el prompt", "50000 km" in prompt)
        check("año en el prompt", "2021" in prompt)
        check("prioridades en el prompt", "automático" in prompt)

        print("\n== forma de la petición a la API ==")
        fake2 = scripted(
            Response([tool_use("submit_ranking", {"summary": "ok", "rankings": rankings[: len(offer_ids)]}, "s1")])
        )
        ranking_agent._call_model = fake2
        run = await fresh_run(session, car_model.id)
        await ranking_agent.execute_ranking_run(session, run.id, RankingRequest())
        sent = fake2.seen[0]  # type: ignore[attr-defined]
        check("modelo correcto", sent["model"] == settings.ANTHROPIC_MODEL, sent["model"])
        check("effort en output_config", sent["output_config"]["effort"] == settings.ANTHROPIC_EFFORT,
              str(sent["output_config"]))
        check("sin temperature/top_p (400 en Opus 5)",
              "temperature" not in sent and "top_p" not in sent and "top_k" not in sent)
        check("sin budget_tokens (400 en Opus 5)", "thinking" not in sent or "budget_tokens" not in str(sent.get("thinking")))
        check("4 tools declaradas", len(sent["tools"]) == 4,
              ", ".join(t["name"] for t in sent["tools"]))
        check("submit_ranking es strict", any(t.get("strict") for t in sent["tools"]))
        check("system prompt presente", "analista" in sent["system"])
        check("max_tokens razonable", sent["max_tokens"] == settings.ANTHROPIC_MAX_TOKENS,
              str(sent["max_tokens"]))

        # Limpieza: los runs de prueba no deben quedarse en la BD.
        for run_row in await session.scalars(
            select(RankingRun).where(RankingRun.triggered_by_id.is_(None))
        ):
            await session.delete(run_row)
        await session.commit()

    ranking_agent._call_model = original_call
    print(f"\n{'=' * 46}\n  {ok} PASS · {fail} FAIL\n{'=' * 46}")
    raise SystemExit(1 if fail else 0)


if __name__ == "__main__":
    asyncio.run(main())
