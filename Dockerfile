# Imagen del despliegue publico: un solo proceso que sirve la API y el frontend
# compilado, solo con los campos precalculados (backend/data/fields). No toca IRSA.
#
#   docker build -t spherex-explorer .
#   docker run --rm -p 7860:7860 spherex-explorer
#
# El puerto sale de $PORT (7860 por defecto).

# ---- Frontend: compila frontend/dist ----
FROM node:22-slim AS frontend
RUN npm install -g pnpm@12.21.0
WORKDIR /src/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- Backend ----
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.13.8
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY backend/app ./app
COPY backend/data ./data
COPY --from=frontend /src/frontend/dist /app/static

# Nombres ya resueltos de los objetos precalculados: los links con `name` abren
# aunque Sesame (CDS) no responda. La cache queda escribible para cualquier usuario.
COPY backend/data/sesame /app/cache/sesame
RUN chmod -R a+rwX /app/cache

ENV SPHEREX_PRECOMPUTED_ONLY=1 \
    SPHEREX_STATIC_DIR=/app/static \
    SPHEREX_CACHE_DIR=/app/cache \
    PYTHONUNBUFFERED=1 \
    PORT=7860
EXPOSE 7860

# Un solo proceso, sin --workers (contrato, seccion 10).
CMD ["sh", "-c", "exec .venv/bin/python -m uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT} --timeout-graceful-shutdown 5"]
