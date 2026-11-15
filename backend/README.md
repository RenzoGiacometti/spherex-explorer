# Backend de SPHEREx Explorer

FastAPI + astropy. Arma el cubo del campo a partir de recortes de IRSA y lo sirve al frontend. El contrato con el frontend está en [`docs/contrato-cubo.md`](../docs/contrato-cubo.md) y manda sobre este código; el alcance, en [`SPEC.md`](../SPEC.md).

Estado: cimientos de la Etapa 1. Están implementados la configuración, los modelos del contrato, la geometría, las estadísticas, el almacén de campos en disco, el modelo de error, la lectura de coordenadas y el servidor falso. El acceso a IRSA, el pipeline, la resolución de nombres con Sesame, la vista provisoria y el gestor de trabajos tienen la firma y la documentación, y lanzan `NotImplementedError`.

## Instalar

Hace falta [uv](https://docs.astral.sh/uv/). Desde `backend/`:

```powershell
uv sync
```

Crea `.venv` con Python 3.12 y las dependencias de `uv.lock`.

## Tests y estilo

```powershell
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

Los tests no usan la red: `tests/conftest.py` hace fallar cualquier conexión que no sea local. Los datos reales guardados van en `tests/fixtures/`.

## Servidor falso

Para desarrollar el frontend sin IRSA ni CDS. Tiene los mismos endpoints que el backend real y responde con campos de muestra ya armados, simulando la carga progresiva por SSE.

```powershell
uv run uvicorn app.fake:app --port 8000
```

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SPHEREX_FAKE_FIELDS_DIR` | `tests/fixtures/fields` | Carpeta con los campos de muestra |
| `SPHEREX_FAKE_SESAME_DIR` | `tests/fixtures/sesame` | Respuestas de Sesame guardadas (`*.xml`) para `/api/resolve` |
| `SPHEREX_FAKE_SECONDS` | `25` | Duración de un campo nuevo simulado |

Si corre a la vez que el backend real, va en otro puerto; el frontend elige a cuál apuntar con `SPHEREX_API_TARGET`.

- `POST /api/field` elige, entre las muestras del escalón pedido, la de centro más cercano. El `id` y los metadatos son los de la muestra, no los del pedido.
- La primera vez que se pide un campo se simula como nuevo; después responde `ready`. `?scenario=` fuerza el caso (tabla de abajo).
- `GET /api/health` lista las muestras disponibles con su centro y los nombres que resuelve `/api/resolve`.
- El detalle del comportamiento (revisiones, orden de los planos, qué llega en cada evento) está en el encabezado de `app/fake.py`.

### Escenarios

| `POST /api/field?scenario=` | Qué pasa |
|---|---|
| (sin `scenario`) | La primera vez, campo nuevo; después, en caché |
| `new` | Campo nuevo: `202`, y por SSE toda la secuencia hasta `done` |
| `cached` | Campo ya terminado: `200` con los metadatos completos |
| `queued` | Espera en la cola con la posición bajando de 3 a 1 y después sigue como nuevo |
| `error` | El trabajo falla después de las primeras imágenes provisorias: evento `error`, `status: "failed"` |
| `queue_full` | `429 queue_full` con `Retry-After: 5`; no crea nada |
| `no_coverage` | `404 no_coverage`; no crea nada |
| `upstream_unavailable` | `503 upstream_unavailable`; no crea nada |

`GET /api/resolve?name=...&scenario=upstream_unavailable` responde `503`, como si Sesame no contestara.

### Qué entrega el flujo de eventos

Es lo que hace el servidor falso y lo que tiene que hacer el backend real. Estos puntos están fijados en la versión 1.1 del contrato (sección 15); acá va el resumen.

- En `listed` los planos sin exposiciones ya vienen `empty` y no tienen evento `plane`. Los demás vienen `pending`.
- `flags` llega como lista vacía en `listed`: los bits salen del encabezado del primer archivo que se baja. Desde ese momento están en `GET .../meta`; ningún evento `plane` los lleva.
- Justo antes de `done` sale un `state` con el documento terminado. Es el único evento que trae `planes[].cube_offset`, `flags` completo y `provenance.built_at`. Quien prefiera no depender de él puede pedir `GET .../meta` al recibir `done`: trae lo mismo.
- `progress`: `planes_total` y `planes_ready` cuentan también los planos vacíos. `cutouts_done` no incluye los recortes fallidos, así que el avance es `(cutouts_done + cutouts_failed) / cutouts_total`.
- Revisiones: la `rev` de un plano sube de a 1 con cada publicación. En el servidor falso la provisoria es la 1 y la definitiva la 2; en el backend real un plano de una sola exposición no tiene provisoria. Provisorio es `status: "building"`, no un número. Las muestras guardan en disco la `rev` que se sirve.
- Con `?rev=N`, un plano o el cubo salen `immutable` solo si N es la revisión vigente. Si se pide otra, llega la vigente con `no-cache`.
- Si el trabajo falla, `status` pasa a `failed` y `progress.phase` queda en la fase en la que estaba. Lo que no se llegó a construir responde `409 not_ready` con `retryable: false`.
- La vista provisoria queda rotulada con la banda del pedido que creó el trabajo: W2 si `band` era 5 o 6, W1 si no. En el servidor falso la imagen es siempre la misma.

### Qué resuelve `/api/resolve`

- Coordenadas, sin consultar nada: grados decimales (`269.4463 4.7683`, `269.4463, +4.7683`) o sexagesimales con RA en horas (`08h55m10.831s -07d14m42.53s`, `08:55:10.83 -07:14:42.5`, `08 55 10.83 -07 14 42.5`).
- Nombres: solo los de las respuestas de Sesame guardadas, por el texto buscado o por el nombre principal, sin distinguir mayúsculas ni signos. Un apodo como `WISE 0855` o `barnard` responde `404 not_resolved`.

| Texto buscado | Nombre principal | Muestra |
|---|---|---|
| `Barnard's Star` | `NAME Barnard's star` | `barnard` |
| `Epsilon Indi B` | `* eps Ind B` | `epsindb` |
| `WISE J085510.83-071442.5` | `WISEA J085510.74-071442.5` | `wise0855` |
| `R Draconis` | `V* R Dra` | sin muestra |
| `RW Aurigae` | `V* RW Aur` | sin muestra |

`GET /api/field/{id}/track?name=` devuelve la trayectoria guardada con la muestra si el nombre es uno de esos; con cualquier otro texto, `positions` vacío.

### Campos de muestra

Los genera `scripts/make_sample_fields.py` a partir de las salidas de la Etapa 0 (`spike/out`, `spike/cache`), sin red. El mismo script copia a `frontend/src/test/fixtures` los metadatos, un plano de dos muestras y la transcripción de eventos de un campo nuevo. `tests/fixtures/fields/index.json` dice qué es cada una.

| Muestra | Objeto | Épocas | Qué tiene de particular |
|---|---|---|---|
| `wise0855` | WISE 0855 | 3 | Datos en todo el campo. Un recorte fallido: campo `partial` |
| `epsindb` | Epsilon Indi B | 4 | Dos planos vacíos, planos con pocas exposiciones, un recorte fallido |
| `barnard` | Barnard's Star | 3 | Núcleo saturado (`+Infinity`) en los 18 planos |

Las tres están en el escalón base del contrato: `request.fov` y `grid.fov` valen 0,1667, la grilla mide 195 × 195 px y el `id` sale de `request` con la fórmula de la sección 3. Límites que conviene conocer:

- **Datos solo en el centro.** La Etapa 0 corrió `epsindb` y `barnard` con un campo de 6′. Ese cubo va, sin remuestrear, en el centro de la grilla de 10′; el marco de 39 px que lo rodea es `NaN` con cobertura 0, y por eso todos sus planos llevan el aviso `low_coverage`. Las vistas de 10′ de esas dos muestras tienen un marco vacío; la de 5′ cae casi toda dentro de la zona con datos.
- **`pipeline` propio.** Las muestras llevan `pipeline: "muestra-1"` (`SAMPLE_PIPELINE_VERSION` en `app/config.py`), no el del backend real. Así su `id` nunca coincide con el del campo real del mismo centro, y un navegador que guardó planos del servidor falso (`immutable`, un año) no los muestra en lugar de los del backend real, que comparte origen y rutas.
- **No hay muestra del escalón amplio (30′).** Un pedido con `fov` mayor que 0,1667 responde `404 no_coverage`.
- **`grid.crval` no es exactamente `request`.** La grilla está centrada en el centro con el que corrió la Etapa 0 (6 decimales) y `request` lo lleva a 4: difieren en menos de 0,2″ (0,06 px). El backend real centra la grilla en `request`. Para ubicar algo en la imagen se usa siempre `grid`.
- **La capa de flags está casi vacía.** La Etapa 0 no guardó los flags por píxel: solo `barnard` tiene bits encendidos (OVERFLOW y BLOOM sobre el núcleo saturado). La cobertura sí es real.
- **La vista provisoria es sintética.** `preview.f32` sale de los planos del detector 4, en unidades arbitrarias; no es una imagen de WISE. Va rotulada `hips: "muestra"`.
- **Una época puede durar un día.** La época 1 de `wise0855` son 30 exposiciones en 0,8 días.

Para regenerarlas, desde `backend/`:

```powershell
uv run python scripts/make_sample_fields.py
```

## Backend real

```powershell
uv run uvicorn app.api.main:app --port 8000
```

Por ahora solo responde `GET /api/health`.

## Configuración

Cada campo de `Settings` (`app/config.py`) se puede cambiar con una variable `SPHEREX_<NOMBRE>`: `SPHEREX_DATA_DIR`, `SPHEREX_CACHE_DIR`, `SPHEREX_MAX_ACTIVE_JOBS`, etc. Las descargas simultáneas contra IRSA nunca pasan de 10, aunque la variable diga más.

## Datos en disco

```
data/fields/     campos precalculados (se versionan)
cache/           caché de ejecución (ignorada por git): fields/, cutouts/, sia/, sesame/
```

Un campo es una carpeta `<id>/`, igual en `data/fields`, en `cache/fields` y en las muestras:

```
meta.json                  documento de metadatos del contrato
plane_e<E>_d<D>.f32        Float32 little-endian, ny*nx, fila 0 = sur
aux_e<E>_d<D>.bin.gz       gzip de: Uint32 flags (ny*nx) y después Uint16 cobertura (ny*nx)
preview.f32                vista provisoria de WISE (opcional)
track_<slug>.json          trayectoria de un objeto (opcional)
```

El cubo no se guarda: `/cube` se arma concatenando los planos al servirlo.

## Mapa de módulos

| Módulo | Qué hace | Estado |
|---|---|---|
| `app/config.py` | `Settings`: rutas y límites, variables `SPHEREX_*` | Hecho |
| `app/contract.py` | Modelos pydantic del JSON del contrato | Hecho |
| `app/domain.py` | Tipos internos (`Exposure`, `Grid`, `PlaneArrays`, etc.) | Hecho |
| `app/geometry.py` | Escalones de campo, normalización del pedido, `id`, grilla WCS, lado del recorte | Hecho |
| `app/pipeline/stats.py` | Estadísticas de un plano, escala de contraste, regiones saturadas | Hecho |
| `app/jobs/store.py` | `FieldStore`: campo en disco | Hecho |
| `app/api/errors.py` | `ApiError` y el cuerpo de error del contrato | Hecho |
| `app/api/main.py` | Aplicación real | Solo `/api/health` |
| `app/fake.py` | Servidor falso | Hecho |
| `app/irsa/limits.py` | Límite global de conexiones hacia IRSA | Pendiente |
| `app/irsa/sia.py` | Lista de exposiciones por SIA2 | Pendiente |
| `app/irsa/cutouts.py` | Descarga de un recorte, leyendo por HDU | Pendiente |
| `app/pipeline/exposure.py` | Cargar, enmascarar y reproyectar un recorte | Pendiente |
| `app/pipeline/coadd.py` | Coadd incremental de un plano | Pendiente |
| `app/pipeline/epochs.py` | Regla de 60 días | Pendiente |
| `app/resolve/coords.py` | Lectura de un texto como coordenadas, en grados o sexagesimales | Hecho |
| `app/resolve/sesame.py`, `motion.py` | Sesame, propagación y trayectoria | Pendiente |
| `app/preview/hips2fits.py` | Vista provisoria de WISE | Pendiente, salvo la elección de banda (`preview_band`) |
| `app/jobs/events.py` | Eventos SSE | Pendiente |
| `app/jobs/manager.py` | Cola y planificación de trabajos | Pendiente |
