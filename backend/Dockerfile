FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Las dependencias se instalan antes de copiar el código para aprovechar la caché.
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY pyproject.toml alembic.ini entrypoint.sh ./
COPY alembic ./alembic
COPY scripts ./scripts
COPY app ./app

# El bit de ejecución viaja en git, pero se fuerza aquí por si el checkout se
# hace en un sistema de ficheros que no lo conserva.
RUN chmod +x entrypoint.sh \
    && useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# `start-period` holgado: antes de uvicorn corre `alembic upgrade head`, y una
# migración sobre una tabla grande puede tardar. Los fallos dentro de esa
# ventana no cuentan como reintentos.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# El entrypoint migra y cede el proceso al CMD.
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
