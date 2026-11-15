# Imagen del despliegue publico: un solo proceso que sirve la API y el frontend
# compilado. Los campos precalculados (backend/data/fields) salen sin tocar IRSA; un
# campo nuevo se arma contra IRSA, con 2 trabajos activos, hasta 10 en cola y 4 descargas
# en paralelo. El proceso corre con un usuario sin privilegios.
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
# El campo de 30' no se probo con datos reales: el despliegue no lo ofrece.
ENV VITE_WIDE_FIELD=0
RUN pnpm build

# ---- Backend ----
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.13.8
# Usuario sin privilegios con el que corre el backend. Tiene carpeta propia porque astropy
# guarda su configuracion en $HOME.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin spherex
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
# Con el bytecode ya compilado: ese usuario no puede escribir los .pyc al lado de las
# dependencias, y sin ellos cada arranque las compilaria de nuevo.
RUN uv sync --frozen --no-dev --no-cache --compile-bytecode
COPY backend/app ./app
RUN .venv/bin/python -m compileall -q app
COPY backend/data ./data
COPY --from=frontend /src/frontend/dist /app/static

# En /app/cache van los recortes bajados y los campos que se arman en vivo: es lo unico que
# el usuario del backend puede escribir. En Render ahi se monta el disco persistente
# (render.yaml). Los nombres ya resueltos de los objetos precalculados se leen de
# data/sesame, asi que los links con `name` abren aunque Sesame (CDS) no responda.
RUN mkdir -p /app/cache && chown -R spherex:spherex /app/cache && chmod -R u+rwX /app/cache

# SPHEREX_PRECOMPUTED_ONLY=1 (por ejemplo desde el panel de Render) vuelve al modo que solo
# sirve lo precalculado y nunca toca IRSA.
# 4 descargas en paralelo contra IRSA: con 10 responde `503 Server busy` a buena parte de los
# pedidos; con 4 responde bien. /docs, /redoc y /openapi.json van apagados en la version publica.
ENV SPHEREX_STATIC_DIR=/app/static \
    SPHEREX_CACHE_DIR=/app/cache \
    SPHEREX_MAX_ACTIVE_JOBS=2 \
    SPHEREX_MAX_QUEUED_JOBS=10 \
    SPHEREX_MAX_CUTOUT_DOWNLOADS=4 \
    SPHEREX_DOCS_ENABLED=0 \
    SPHEREX_NEARBY_FIELD_ARCSEC=60 \
    SPHEREX_CUTOUT_CACHE_MAX_GB=2 \
    PYTHONUNBUFFERED=1 \
    PORT=7860
EXPOSE 7860

USER spherex

# Un solo proceso, sin --workers (contrato, seccion 10).
CMD ["sh", "-c", "exec .venv/bin/python -m uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT} --timeout-graceful-shutdown 5"]
