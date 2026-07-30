#!/usr/bin/env bash
# Lanza la rutina diaria de captacion de ofertas en modo headless.
#
# Instalacion del cron (todos los dias a las 08:15):
#   crontab -e
#   15 8 * * * /ruta/a/car-scan/run-daily.sh >> /ruta/a/car-scan/logs/cron.log 2>&1
#
# Autenticacion: en un cron no hay sesion interactiva. Usa un token de larga duracion
# (`claude setup-token`, requiere suscripcion) o ANTHROPIC_API_KEY. Guardalo en
# ~/.config/car-scan/env con permisos 600, nunca en este fichero.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p logs reports state

# shellcheck source=/dev/null
[[ -f "$HOME/.config/car-scan/env" ]] && source "$HOME/.config/car-scan/env"
: "${NR_API_KEY:?Falta NR_API_KEY (definela en ~/.config/car-scan/env)}"
: "${NR_API_BASE_URL:=http://localhost:8000}"

DATE=$(date +%F)
LOG="logs/run-$DATE.log"

echo "=== $(date -Is) inicio del run ===" | tee -a "$LOG"

# La API es la única fuente de configuración. Si falla, no se abre ningún portal.
python3 scrapers/config.py --out state/runtime-config.json | tee -a "$LOG"

# --print: headless, una pasada y salir.
# --output-format json: la ultima linea del stdout es parseable por el cron.
# --permission-mode acceptEdits: sin humano que confirme escrituras en el proyecto.
#   Si tu version no lo soporta, usa --dangerously-skip-permissions y ejecuta esto
#   en un contenedor o en un usuario con acceso solo a este directorio.
set +e
claude --print \
  --permission-mode acceptEdits \
  --output-format json \
  "/daily-car-scan" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
set -e

echo "=== $(date -Is) fin del run (exit $status) ===" | tee -a "$LOG"

# Rotacion simple: conserva 30 dias de logs y payloads.
find logs -name 'run-*.log' -mtime +30 -delete
find logs -name 'payload-*.json' -mtime +30 -delete

exit "$status"
