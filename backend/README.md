# Backend de SPHEREx Explorer

FastAPI + astropy. Arma el cubo del campo a partir de recortes de IRSA y lo sirve al frontend. El contrato con el frontend está en [`docs/contrato-cubo.md`](../docs/contrato-cubo.md) y manda sobre este código; el alcance, en [`SPEC.md`](../SPEC.md).

Estado: Etapa 1. Están implementados y probados el acceso a IRSA, el pipeline, la resolución de nombres, el gestor de trabajos, las rutas del contrato y el script de precálculo. Los cinco objetos de prueba están precalculados en `data/fields`. La vista provisoria de WISE está implementada pero apagada (`SPHEREX_PREVIEW_ENABLED`): hips2fits de CDS estuvo caído todo el 2026-11-15 y no se pudo verificar.

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

Los tests no usan la red: `tests/conftest.py` hace fallar cualquier conexión que no sea local. Los datos reales guardados van en `tests/fixtures/`. Los tests de IRSA, Sesame y la vista provisoria hablan con un servidor HTTP local que sirve esas respuestas guardadas.

### Pruebas contra los servicios reales

No son parte de la batería: se corren a mano y usan la red.

```powershell
uv run python scripts/smoke_irsa.py
uv run python scripts/probe_hips2fits.py --save tests/fixtures/preview
```

- `smoke_irsa.py` lista las exposiciones de Barnard por SIA2 y baja 3 recortes de a uno, con una caché temporal fuera del repositorio. Códigos de salida: 0, lista y recortes bien; 3, recortes bien y SIA2 sin responder; 1, algún recorte falló o bajó completo; 2, no se pudo probar nada. La última corrida (15 de noviembre de 2026, 13:43 UTC) terminó en 0: 3 de 3 recortes cortados antes de EPSF, de 400 a 403 kB y de 1,3 a 2,3 s cada uno.
- `probe_hips2fits.py` hace un pedido a hips2fits con la grilla de un campo. Con `--save tests/fixtures/preview` guarda la respuesta, y con un FITS real guardado se activa solo el test que hoy se saltea. Todavía no hay ninguno: el servicio respondió 404 en todos los sondeos del 15 de noviembre.

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

Es lo que hace el servidor falso y lo que tiene que hacer el backend real. Estos puntos están fijados en el contrato (secciones 15 y 16); acá va el resumen.

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
uv run uvicorn app.api.main:app --port 8000 --timeout-graceful-shutdown 5
```

Implementa todos los endpoints del contrato. El frontend en desarrollo (`pnpm dev`) le llega por el proxy de `/api` de Vite; no tiene CORS.

- Un solo proceso de uvicorn (sin `--workers`): el límite de 10 descargas hacia IRSA, la cola y la protección de la caché de recortes valen por proceso.
- `--timeout-graceful-shutdown` hace falta para poder detenerlo con un flujo de eventos abierto.

### Campos precalculados

```powershell
uv run python scripts/precompute.py                 # los cinco objetos de prueba, de a uno
uv run python scripts/precompute.py wise0855 --refresh
```

Alias: `barnard`, `epsindb`, `wise0855`, `rwaur`, `rdra`. Usa la red (IRSA y Sesame) y deja cada campo en `data/fields`, con la trayectoria del objeto. Código de salida: 0 todos `ready`, 2 alguno `partial` (`--refresh` lo completa), 1 alguno falló. No correrlo mientras el backend arma campos: cada proceso tendría su propio cupo de 10 descargas.

Medido el 2026-11-15 contra IRSA: Barnard (358 exposiciones) en 148 s, Epsilon Indi B (458) en 157 s, WISE 0855 (258) en 138 s.

### Despliegue público

El `Dockerfile` de la raíz arma una imagen de un solo proceso: la API, el frontend compilado (`SPHEREX_STATIC_DIR`) y los campos precalculados, que salen sin tocar IRSA. Un campo que no está precalculado se arma contra IRSA igual que en desarrollo, con 2 trabajos activos y hasta 10 en cola (`SPHEREX_MAX_ACTIVE_JOBS`, `SPHEREX_MAX_QUEUED_JOBS`); la interfaz avisa que tarda unos minutos. Lo que se arma queda en la caché del contenedor y se pierde al redesplegar.

- `SPHEREX_NEARBY_FIELD_ARCSEC=60`: un pedido a menos de 1 minuto de arco del centro de un campo ya armado abre ese campo en vez de armar otro casi igual.
- `SPHEREX_PRECOMPUTED_ONLY=1` vuelve al modo que solo sirve lo ya armado: cualquier otro campo responde `404 not_found` y nunca se toca IRSA.
- El frontend se compila con `VITE_WIDE_FIELD=0`: no ofrece el campo de 30′, que no se probó con datos reales.
- 4 descargas en paralelo contra IRSA (`SPHEREX_MAX_CUTOUT_DOWNLOADS=4`), `/docs` apagado (`SPHEREX_DOCS_ENABLED=0`) y el proceso corre como el usuario `spherex` (uid 1000), con `/app/cache` como única carpeta escribible.
- Las respuestas de 1 kB o más salen con gzip (`app/api/compression.py`); `/assets/*` del frontend lleva caché larga e `immutable` y lo demás `no-cache` (`app/api/static.py`).
- `render.yaml` describe el servicio para Render (plan de 2 GB, una sola instancia).

```powershell
docker build -t spherex-explorer .
docker run --rm -p 7860:7860 spherex-explorer
```

`data/sesame/` guarda las respuestas de Sesame de los cinco objetos; la imagen las copia a su caché para que los links con `name` abran aunque CDS no responda.

### Lo que el gestor de trabajos tiene que hacer con estas piezas

- Si `load_exposure` lanza `OSError`, `KeyError` o `ValueError` sobre un recorte, llamar a `discard_cutout(path, settings)` y volver a pedirlo una vez.
- Llamar a `prune_cutout_cache` al arrancar y al terminar cada trabajo: no se llama sola.
- `fetch_cutout` hace un solo intento. Ante `IrsaBusy`, soltar el cupo y esperar `retry_after` (ya acotado a 60 s); si `requested` es mayor, dar el recorte por fallido en ese trabajo.
- `resolve()`, `field_track()`, `list_exposures()`, `fetch_cutout()` y `fetch_preview()` bloquean: desde una ruta `async` se llaman en un hilo.
- Más hilos casi no aceleran `load_exposure` (retiene el GIL): unas 30 a 40 exposiciones por segundo en total.

## Configuración

Cada campo de `Settings` (`app/config.py`) se puede cambiar con una variable `SPHEREX_<NOMBRE>`: `SPHEREX_DATA_DIR`, `SPHEREX_CACHE_DIR`, `SPHEREX_MAX_ACTIVE_JOBS`, etc. Las descargas simultáneas contra IRSA nunca pasan de 10, aunque la variable diga más.

| Variable | Por defecto | Qué hace |
|---|---|---|
| `SPHEREX_SIA_URL` | SIA2 de IRSA | Servicio de la lista de exposiciones |
| `SPHEREX_SIA_ATTEMPTS`, `SPHEREX_SIA_RETRY_WAIT_S` | 6, 2 | Intentos por colección y espera entre ellos |
| `SPHEREX_IRSA_CONNECT_TIMEOUT_S`, `SPHEREX_IRSA_READ_TIMEOUT_S`, `SPHEREX_IRSA_TOTAL_TIMEOUT_S` | 15, 60, 180 | Topes de un pedido a IRSA: conexión, silencio entre tramos y total del cuerpo |
| `SPHEREX_IRSA_RETRY_AFTER_DEFAULT_S`, `SPHEREX_IRSA_RETRY_AFTER_MAX_S` | 5, 60 | Espera si IRSA no manda `Retry-After`, y máximo que se respeta |
| `SPHEREX_CUTOUT_CACHE_MAX_GB` | 10 | Tope de disco de la caché de recortes |
| `SPHEREX_SESAME_URLS`, `SPHEREX_SESAME_TIMEOUT_S`, `SPHEREX_SESAME_TOTAL_TIMEOUT_S` | CDS y CfA, 10, 20 | Servidores de nombres, en orden, y sus plazos |
| `SPHEREX_HIPS2FITS_URL`, `SPHEREX_PREVIEW_HIPS_W1`, `SPHEREX_PREVIEW_HIPS_W2` | hips2fits de CDS, `CDS/P/allWISE/W1` y `W2` | Servicio e imágenes de la vista provisoria |
| `SPHEREX_PREVIEW_ENABLED` | 0 | Con 1, pide la vista provisoria de WISE. Apagada: el campo sale con `preview.status = "unavailable"` |
| `SPHEREX_PRECOMPUTED_ONLY` | 0 | Con 1, solo sirve campos ya armados y no toca IRSA |
| `SPHEREX_NEARBY_FIELD_ARCSEC` | 0 | Distancia al centro de un campo ya armado por debajo de la cual un pedido abre ese campo; 0 lo desactiva |
| `SPHEREX_STATIC_DIR` | vacío | Carpeta del frontend compilado, servida en `/` |

## Datos en disco

```
data/fields/     campos precalculados (se versionan)
data/sesame/     respuestas de Sesame de los objetos precalculados (se versionan; las usa la imagen Docker)
cache/           caché de ejecución (ignorada por git): fields/, cutouts/, sia/, sesame/
```

En `cache/cutouts` cada recorte es `<archivo de la exposición>__<ra>_<dec>_<lado>_img.fits` si se cortó antes de EPSF, o `_full.fits` si hubo que bajarlo entero. En `cache/sia`, `<colección>__<ra>_<dec>.xml` con un `.json` al lado.

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
| `app/api/main.py` | Aplicación real: rutas y ciclo de vida | Hecho |
| `app/api/backend.py` | `ApiBackend`: lo que hace cada endpoint, sin HTTP | Hecho |
| `app/api/headers.py` | Cabeceras del contrato, compartidas con el servidor falso | Hecho |
| `app/fake.py` | Servidor falso | Hecho |
| `app/irsa/limits.py` | Límite global de conexiones hacia IRSA | Hecho |
| `app/irsa/sia.py` | Lista de exposiciones por SIA2, con caché y copia vencida como respaldo | Hecho |
| `app/irsa/cutouts.py` | Descarga de un recorte, leyendo por HDU; caché en disco con tope | Hecho |
| `app/irsa/transport.py` | Sesión por hilo, timeouts, plazo total y lectura de `Retry-After` | Hecho |
| `app/pipeline/exposure.py` | Cargar, enmascarar y reproyectar un recorte | Hecho |
| `app/pipeline/coadd.py` | Coadd incremental de un plano | Hecho |
| `app/pipeline/flag_table.py` | Unión de las tablas de bits de los archivos: `flags[]` del campo | Hecho |
| `app/pipeline/epochs.py` | Regla de 60 días | Hecho |
| `app/resolve/coords.py` | Lectura de un texto como coordenadas, en grados o sexagesimales | Hecho |
| `app/resolve/sesame.py`, `motion.py` | Sesame (CDS y espejo de CfA), propagación y trayectoria | Hecho |
| `app/resolve/service.py` | `resolve()` y `field_track()`: las respuestas de `/api/resolve` y `/track` | Hecho |
| `app/preview/hips2fits.py` | Vista provisoria de WISE | Hecho, sin verificar contra el servicio |
| `app/jobs/events.py` | Eventos SSE y bus por campo | Hecho |
| `app/jobs/manager.py` | Cola y planificación de trabajos | Hecho |
| `app/jobs/job.py`, `plan.py`, `document.py`, `deps.py` | Un trabajo, orden de descarga y reintentos, documento final, dependencias inyectables | Hecho |
| `scripts/precompute.py` | Precálculo de los objetos de prueba en `data/fields` | Hecho |
| `app/spectrum/` | `GET /api/spectrum`: fotometría de apertura por exposición, longitud de onda y espectros guardados | Hecho |
