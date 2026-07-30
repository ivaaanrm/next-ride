"""Descarga la configuración de captación antes de abrir ningún portal."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "state" / "runtime-config.json"
DEFAULT_API_BASE = "http://localhost:8000"
TIMEOUT_S = 30


class ConfigError(RuntimeError):
    pass


def api_base() -> str:
    return os.environ.get("NR_API_BASE_URL", DEFAULT_API_BASE).rstrip("/")


def fetch_runtime_config() -> dict[str, Any]:
    api_key = os.environ.get("NR_API_KEY", "")
    if not api_key:
        raise ConfigError("falta NR_API_KEY")

    request = urllib.request.Request(
        f"{api_base()}/api/v1/scraping/config",
        headers={"X-API-Key": api_key, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise ConfigError(f"la API rechazó la configuración (HTTP {exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ConfigError(f"no se pudo leer la configuración: {exc}") from exc

    targets = payload.get("targets")
    if not isinstance(targets, list):
        raise ConfigError("respuesta inválida: falta targets[]")
    for target in targets:
        if not isinstance(target, dict) or not isinstance(target.get("source"), dict):
            raise ConfigError("respuesta inválida: cada target necesita una fuente")
        required = ("id", "make", "model", "label", "max_results")
        if any(target.get(field) in (None, "") for field in required):
            raise ConfigError("respuesta inválida: target incompleto")
    return payload


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def load_runtime_config(path: Path | None = None) -> dict[str, Any]:
    config_path = path or DEFAULT_OUT
    if not config_path.exists():
        raise ConfigError(
            f"falta {config_path}; ejecuta primero scrapers/config.py"
        )
    return json.loads(config_path.read_text("utf-8"))


def find_target(
    source_key: str, label: str, path: Path | None = None
) -> dict[str, Any]:
    payload = load_runtime_config(path)
    match = next(
        (
            target
            for target in payload["targets"]
            if target["source"]["key"] == source_key
            and target["label"].casefold() == label.casefold()
        ),
        None,
    )
    if match is None:
        raise ConfigError(f"{label!r} no está activo para {source_key!r}")
    return match


def main() -> int:
    parser = argparse.ArgumentParser(description="Descarga la configuración del scraper")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    try:
        payload = fetch_runtime_config()
        write_atomic(args.out, payload)
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    sources = {target["source"]["key"] for target in payload["targets"]}
    print(
        json.dumps(
            {
                "targets": len(payload["targets"]),
                "sources": len(sources),
                "max_per_target": payload.get("max_per_target", 15),
                "config": str(args.out),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
