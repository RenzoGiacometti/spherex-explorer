# Contrato del cubo del campo

Versión 1, aprobada el 15 de noviembre de 2026. Define lo que el backend entrega y lo que el frontend puede asumir sobre `/api/field` y `/api/resolve` en la Etapa 1. Backend y frontend se construyen en paralelo contra este documento; cualquier cambio posterior se hace acá primero.

Las cifras salen de `spike/RESULTADOS.md` (Etapa 0 y fase A de la Etapa 1). Las decisiones tomadas al aprobarlo están en la sección 14.

## 1. Flujo

```
Navegador                                  Backend
   |  GET /api/resolve?name=...               |   (solo si el usuario buscó por nombre)
   |----------------------------------------->|
   |  POST /api/field {ra, dec, fov, band}    |
   |----------------------------------------->|   campo en caché: 200, status "ready", meta incluida
   |                                          |   campo nuevo:    202, status "queued"
   |  GET /api/field/{id}/events (SSE)        |
   |<-----------------------------------------|   state, preview, listed, progress, plane, plane, ..., done
   |  GET /api/field/{id}/preview             |   imagen de WISE de la misma zona, mientras llega SPHEREx
   |  GET /api/field/{id}/plane/{e}/{d}       |   un plano Float32 por cada evento "plane"
   |  GET /api/field/{id}/cube                |   todos los planos de una vez (campo terminado)
   |  GET /api/field/{id}/aux/{e}/{d}         |   flags y cobertura, al activar la capa de flags
```

Un campo ya calculado no necesita SSE: la respuesta de `POST` trae los metadatos y el frontend pide los planos de la banda actual.

## 2. Convenciones

- JSON en UTF-8, claves en `snake_case`. Ángulos en grados ICRS, escalas en segundos de arco, fechas como MJD (UTC) y como texto ISO `AAAA-MM-DD`, longitudes de onda en µm, brillo superficial en MJy/sr.
- `epoch` va de 1 a N en orden temporal. `detector` va de 1 a 6 y es el detector de SPHEREx (`SPHEREx-D1` a `SPHEREx-D6`). La interfaz lo muestra como B1 a B6.
- Una **época** es una pasada del relevamiento: exposiciones separadas por más de 60 días caen en épocas distintas. Hay 3 o 4 por campo y cada una abarca de 2 semanas a 3 meses.
- Un **plano** es el coadd de una época y un detector.
- Coordenadas de píxel: enteros desde 0 en el centro del primer píxel. `x` crece hacia el oeste y `y` hacia el norte. La fila 0 es el borde sur y la columna 0 el borde este, así que la imagen se dibuja con el norte arriba y el este a la izquierda sin invertir nada.
- Errores: código HTTP y cuerpo `{"error": {"code": "...", "message": "...", "retryable": true}}`. El mensaje es para el log; el texto que ve la persona lo arma el frontend a partir de `code`.

| `code` | HTTP | Cuándo |
|---|---|---|
| `invalid_request` | 422 | Coordenadas fuera de rango, `fov` no admitido, `band` fuera de 1 a 6 |
| `not_resolved` | 404 | Sesame no conoce el nombre |
| `not_found` | 404 | No existe ese `id`, plano o capa |
| `not_ready` | 409 | Se pidió `/cube` o un plano que todavía no está construido |
| `no_coverage` | 404 | Ninguna exposición de DR1 o QR3 cubre el punto |
| `queue_full` | 429 | Cola de trabajos llena; trae `Retry-After` |
| `upstream_unavailable` | 503 | IRSA o Sesame no responden y no hay copia en caché |

## 3. Identidad y tamaño del campo

El backend normaliza el pedido antes de buscarlo en caché:

- `ra` se lleva a [0, 360) y se redondea, igual que `dec`, a 4 decimales (0,36").
- `fov` se redondea hacia arriba al escalón admitido más cercano.
- `id` son los primeros 16 caracteres hexadecimales del SHA-256 de `"{pipeline}|{ra:.4f}|{dec:+.4f}|{escalón}"`.

El `id` depende solo de la geometría y de la versión del pipeline. No depende del nombre del objeto: dos objetos en el mismo campo comparten cubo, y un cambio en el pipeline invalida la caché sin borrar nada.

### Escalones de campo

El servicio de recortes siempre entrega píxeles nativos, así que el costo crece con el área. Para cubrir las esquinas con cualquier giro del detector, el recorte se pide con lado `fov × √2 + 4 px`.

| Escalón | `fov` | Grilla de salida | Plano | Cubo de 18 planos | Recorte pedido | Bytes por recorte |
|---|---|---|---|---|---|---|
| Base | 0,1667° (10′) | 3,075"/px | 195 × 195 px, 152 kB | 2,7 MB | 0,2425°, 142 px | 0,4 MB |
| Amplio | 0,5° (30′) | 6,15"/px | 293 × 293 px, 343 kB | 6,2 MB | 0,714°, 419 px | 2,9 MB |

- Las vistas de 5′ y de 10′ de la interfaz usan el mismo cubo base: 5′ es un acercamiento en el navegador y no genera trabajo nuevo.
- El escalón base está probado: WISE 0855 con 258 exposiciones tardó 207 s de descarga y quedó cubierto al 100 %. El amplio no se corrió entero: se midió un solo recorte (2,9 MB en 8,8 s). Para 358 exposiciones son un gigabyte y, por extrapolación, entre 5 y 10 minutos.
- El campo de 1° no entra en este contrato (sección 13).
- Con 4 épocas el cubo tiene hasta 24 planos (3,7 MB en el escalón base).

## 4. Endpoints

### 4.1 `POST /api/field`

Pide un campo. Es idempotente: el mismo pedido devuelve siempre el mismo `id`, y si el trabajo ya existe se suma a él en vez de crear otro.

```json
{ "ra": 269.4463, "dec": 4.7683, "fov": 0.1667, "band": 3 }
```

| Campo | Tipo | Obligatorio | Significado |
|---|---|---|---|
| `ra`, `dec` | número | sí | Centro del campo, grados ICRS |
| `fov` | número | no | Lado en grados. Por defecto 0,1667. Entre 0,02 y 0,5 |
| `band` | entero | no | Detector que la persona está mirando. Sus planos se construyen primero. Por defecto 3 |
| `refresh` | booleano | no | Vuelve a listar exposiciones aunque el campo esté en caché |

Respuesta `200` si el campo está terminado, `202` si no:

```json
{
  "id": "f3a91c0e52d47b18",
  "status": "ready",
  "events_url": "/api/field/f3a91c0e52d47b18/events",
  "meta": { "...": "documento de metadatos completo, sección 5" }
}
```

`meta` viene siempre. Si el trabajo recién entra en la cola, trae solo `id`, `status`, `request` y `progress`.

### 4.2 `GET /api/field/{id}/events`

Flujo `text/event-stream`. Cada evento lleva `event`, `id` (entero creciente) y `data` (JSON en una línea).

| Evento | `data` | Cuándo |
|---|---|---|
| `state` | Documento de metadatos completo | Siempre el primero al conectar o reconectar |
| `queued` | `{"position": 2}` | Mientras espera turno, cada vez que cambia la posición |
| `preview` | Objeto `preview` (sección 5) | Cuando la vista provisoria de WISE queda lista o se descarta |
| `listed` | Documento de metadatos completo, con todos los planos en `pending` | Al terminar la consulta de exposiciones. Desde acá el frontend conoce épocas, detectores y grilla |
| `progress` | Objeto `progress` (sección 5) | Como máximo 4 por segundo durante la descarga |
| `plane` | `{"plane": {...}, "detector_display": {...}}` | Cada vez que hay una revisión nueva de un plano, provisional o definitiva |
| `warning` | Un aviso (sección 5) | Al detectarlo |
| `done` | `{"status": "ready", "rev": 1, "elapsed_s": 155.4}` | Fin del trabajo. `status` es `ready` o `partial` |
| `error` | Objeto de error (sección 2) | El trabajo no puede continuar |

Reglas:

- El servidor cierra el flujo después de `done` o `error`. Si el campo ya estaba terminado, manda `state`, `done` y cierra.
- Cada 15 s sin eventos manda un comentario `: ping`.
- No hay repetición de eventos perdidos. Al reconectar llega un `state` nuevo, que contiene todo lo anterior. Los eventos `plane` son idempotentes: el frontend compara `rev` y vuelve a pedir el plano solo si aumentó.
- El trabajo no depende de la conexión: si el navegador se va, sigue y queda en caché.
- Quien no pueda usar SSE puede consultar `GET /api/field/{id}/meta` cada 2 s; trae lo mismo que `state`.

Ejemplo de un campo nuevo:

```
event: state
id: 1
data: {"id":"f3a91c0e52d47b18","status":"queued","rev":0,"progress":{"phase":"queued","queue_position":1}, ...}

event: listed
id: 3
data: {"id":"f3a91c0e52d47b18","status":"downloading","epochs":[...],"detectors":[...],"planes":[...], ...}

event: progress
id: 9
data: {"phase":"downloading","cutouts_total":358,"cutouts_done":21,"cutouts_failed":0,"cutouts_cached":0,"planes_total":18,"planes_ready":0,"elapsed_s":11.8}

event: plane
id: 10
data: {"plane":{"epoch":1,"detector":3,"status":"ready","rev":1, ...},"detector_display":{"detector":3,"vmin":-0.08,"vmax":9.8,"median":0.002,"sigma":0.041}}

event: done
id: 412
data: {"status":"ready","rev":1,"elapsed_s":155.4}
```

### 4.3 `GET /api/field/{id}/meta`

Documento de metadatos (sección 5) en su estado actual. `Cache-Control: no-cache` con `ETag`.

### 4.4 `GET /api/field/{id}/plane/{epoch}/{detector}`

Un plano en binario (sección 6), en su revisión más reciente. Con `?rev=N` la respuesta lleva `Cache-Control: public, max-age=31536000, immutable`, porque una revisión no cambia nunca; si esa revisión ya fue reemplazada, devuelve la vigente. Devuelve `409 not_ready` si el plano está en `pending` y `404 not_found` si está en `empty`.

### 4.5 `GET /api/field/{id}/cube`

Todos los planos con datos, concatenados en el orden de `planes` (sección 6). Solo cuando el trabajo terminó; antes devuelve `409 not_ready`. Acepta `?rev=N` con la misma política de caché que un plano.

### 4.6 `GET /api/field/{id}/aux/{epoch}/{detector}`

Capas auxiliares de un plano: flags y cobertura (sección 6). Se piden recién al activar la capa de flags.

### 4.7 `POST /api/field/{id}/priority`

Cuerpo `{"band": 6}`. Reordena los planos pendientes para que los de esa banda se construyan antes. Sirve cuando la persona cambia de banda mientras el campo carga. Responde `204`; no hace nada si el trabajo ya terminó.

### 4.8 `GET /api/resolve?name=`

Resuelve un nombre con Sesame, o interpreta el texto como coordenadas si lo son. Si el objeto tiene movimiento propio, propaga la posición.

```json
{
  "query": "Barnard's Star",
  "name": "NAME Barnard's star",
  "source": "sesame",
  "object_type": "BY*",
  "j2000": { "ra": 269.452077, "dec": 4.693365 },
  "motion": { "pm_ra": -801.551, "pm_dec": 10362.394, "parallax": 546.976, "radial_velocity": -110.11, "per_year_arcsec": 10.39 },
  "field_center": { "ra": 269.4463, "dec": 4.7683, "epoch": 2026.0 },
  "moved_arcsec": 270.4
}
```

- `j2000` es la posición de catálogo, en la época 2000,0.
- `motion` es `null` si el catálogo no trae movimiento propio. `pm_ra` incluye el factor cos(dec); unidades mas/año, mas y km/s.
- `field_center` es donde hay que centrar el campo: la posición propagada a una época fija, 2026,0. Es fija a propósito: si dependiera de la fecha del día, el `id` del campo cambiaría con el tiempo y la caché no serviría. Sin movimiento propio coincide con `j2000`.
- `moved_arcsec` es cuánto se apartó de la posición de catálogo. Para Barnard son 4,5′, más que medio campo.
- Para coordenadas, `source` es `"coordinates"`, `name` es `null` y `motion` es `null`.

### 4.9 `GET /api/field/{id}/track?name=`

Posición esperada de un objeto en cada época de un campo, para la mira y el rastro. Incluye movimiento propio y paralaje.

```json
{
  "name": "NAME Barnard's star",
  "positions": [
    { "epoch": 1, "mjd": 60913.7, "ra": 269.44604, "dec": 4.76740, "x": 97.3, "y": 96.0, "in_field": true },
    { "epoch": 2, "mjd": 61116.2, "ra": 269.44661, "dec": 4.76896, "x": 96.6, "y": 97.8, "in_field": true }
  ]
}
```

Va aparte del cubo para que el `id` del campo no dependa del objeto. Devuelve `positions` vacío si el objeto no tiene movimiento propio; en ese caso la mira va en `field_center`.

### 4.10 `GET /api/field/{id}/preview`

Vista provisoria: un recorte de WISE de la misma zona, para tener algo en pantalla mientras carga un campo nuevo. El backend lo pide a hips2fits de CDS al crear el trabajo, en paralelo con la lista de exposiciones, y lo guarda con el campo.

- Mismo formato que un plano (sección 6): Float32, la misma grilla y la misma forma que el cubo. `NaN` es sin datos.
- Los valores están en las unidades del relevamiento de origen, no en MJy/sr. Sirven solo para mirar; no se comparan con los planos de SPHEREx ni entran en los modos de comparación.
- Banda: W1 (3,4 µm), o W2 (4,6 µm) si el `band` pedido es 5 o 6.
- Devuelve `409 not_ready` mientras `preview.status` es `pending` y `404 not_found` si es `unavailable`.
- Si hips2fits no responde en 20 s, `preview.status` pasa a `unavailable` y el trabajo sigue sin vista provisoria. No es un error del campo.

## 5. Documento de metadatos

Es el mismo objeto en `POST /api/field`, en `GET .../meta` y en los eventos `state` y `listed`. Antes de `listed` no trae `grid`, `detectors`, `epochs`, `planes` ni `flags`.

```json
{
  "id": "f3a91c0e52d47b18",
  "pipeline": "1",
  "status": "ready",
  "rev": 1,
  "request": { "ra": 269.4463, "dec": 4.7683, "fov": 0.1667 },
  "grid": {
    "projection": "TAN",
    "crval": [269.4463, 4.7683],
    "crpix": [98.0, 98.0],
    "cdelt": [-0.000854167, 0.000854167],
    "shape": [195, 195],
    "fov": 0.1667,
    "pixel_scale_arcsec": 3.075,
    "native_pixel_scale_arcsec": 6.15
  },
  "detectors": [
    { "detector": 1, "wave_min_um": 0.75, "wave_max_um": 1.12,
      "display": { "vmin": -0.21, "vmax": 14.6, "median": 0.004, "sigma": 0.105 } }
  ],
  "epochs": [
    { "epoch": 1, "start": "2025-08-15", "end": "2025-10-01",
      "mjd_start": 60902.86, "mjd_end": 60949.31, "mjd_mean": 60914.9, "n_exposures": 118 }
  ],
  "planes": [
    { "epoch": 1, "detector": 1, "status": "ready", "rev": 1,
      "n_exposures": 24, "n_used": 24, "n_failed": 0, "mjd_mean": 60923.9988,
      "stats": { "min": -0.31, "max": 187.4, "median": 0.004, "sigma": 0.098,
                 "p01": -0.19, "p99": 3.4, "p997": 14.6,
                 "valid_fraction": 0.972, "saturated_fraction": 0.0045 },
      "saturated": [ { "x": 97.3, "y": 96.0, "radius_px": 4.6, "n_pixels": 67 } ],
      "cube_offset": 0 }
  ],
  "flags": [
    { "bit": 1, "name": "OVERFLOW", "description": "Overflow detected during SUR", "masked": true, "saturation": true }
  ],
  "progress": {
    "phase": "done", "queue_position": 0,
    "cutouts_total": 358, "cutouts_done": 358, "cutouts_failed": 0, "cutouts_cached": 0,
    "planes_total": 18, "planes_ready": 18, "elapsed_s": 155.4
  },
  "warnings": [
    { "code": "saturated_source", "ra": 269.44604, "dec": 4.76740, "radius_arcsec": 14.1,
      "epochs": [1, 2, 3], "detectors": [1, 2, 3, 4, 5, 6] }
  ],
  "preview": {
    "status": "ready", "survey": "WISE", "band": "W1", "wave_um": 3.4, "hips": "identificador HiPS usado",
    "display": { "vmin": 1.2, "vmax": 38.5, "median": 2.1, "sigma": 0.4 }
  },
  "provenance": {
    "source": "SPHEREx / IRSA", "collections": ["spherex_dr1", "spherex_qr3"],
    "listed_at": "2026-11-15T06:21:10Z", "list_stale": false,
    "download_mode": "truncated", "built_at": "2026-11-15T06:23:34Z"
  }
}
```

### Campos

| Campo | Significado |
|---|---|
| `status` | `queued`, `listing`, `downloading`, `ready`, `partial` o `failed`. `partial` es un trabajo terminado al que le faltaron recortes |
| `rev` | Revisión del campo. Vale 0 hasta que termina; sube cada vez que un plano cambia después |
| `request` | Pedido ya normalizado |
| `grid.shape` | `[ny, nx]` |
| `grid.crval`, `crpix`, `cdelt` | WCS de la grilla con las convenciones de FITS: `crpix` cuenta desde 1 y `cdelt[0]` es negativo |
| `detectors[].wave_*` | Rango real del detector según IRSA. La interfaz muestra este, no uno fijo |
| `detectors[].display` | Escala común a todas las épocas del detector, para que el parpadeo no cambie de brillo. Sale de los planos listos hasta ese momento y se actualiza con cada evento `plane` |
| `epochs[]` | Una entrada por pasada, con sus fechas y cantidad de exposiciones |
| `planes[]` | Una entrada por cada combinación de época y detector, ordenadas por época y después por detector. Siempre están todas, también las vacías |
| `flags[]` | Bits de FLAGS leídos del encabezado de los archivos. `masked` dice si el pipeline descarta los píxeles con ese bit; `saturation`, si cuenta como saturación |
| `progress` | Avance. `phase` es `queued`, `listing`, `downloading`, `finishing` o `done` |
| `preview` | Vista provisoria de WISE (sección 4.10). `status` es `pending`, `ready` o `unavailable`. `display` trae su propia escala, calculada como la de un detector. Está presente desde el primer `state` |
| `provenance.download_mode` | `truncated`, `full` o `mixed` (sección 9) |
| `provenance.list_stale` | `true` si IRSA no respondió y se usó una lista de exposiciones guardada |

### Plano

| Campo | Significado |
|---|---|
| `status` | `pending`: sin construir. `building`: provisional, con parte de sus exposiciones (sección 8). `ready`: completo. `partial`: definitivo, pero faltaron recortes. `empty`: sin exposiciones o sin ninguna usable; no tiene binario |
| `rev` | Revisión del plano. El binario de una revisión no cambia |
| `n_exposures`, `n_used`, `n_failed` | Exposiciones que cubren el campo, las que entraron al coadd y las que no se pudieron bajar |
| `mjd_mean` | Fecha media de las exposiciones usadas |
| `stats` | Sobre los píxeles finitos. `sigma` es 1,4826 × MAD. `valid_fraction` y `saturated_fraction` son fracciones del total de píxeles |
| `saturated[]` | Regiones saturadas de al menos 4 píxeles: centro, radio equivalente y cantidad de píxeles |
| `cube_offset` | Posición en bytes del plano dentro de `/cube`. `null` mientras el trabajo no termina y en planos `empty` |

`detector_display` se calcula así: con todos los píxeles finitos de los planos listos del detector, `median` y `sigma` robustos, `vmin = median − 2 sigma` y `vmax = max(p99,7; median + 10 sigma)`. El control de contraste se mueve entre esos dos valores.

### Avisos

Cada aviso es un objeto con `code` y parámetros. El frontend arma la frase en el idioma activo.

| `code` | Parámetros | Significado |
|---|---|---|
| `saturated_source` | `ra`, `dec`, `radius_arcsec`, `epochs`, `detectors` | Hay una fuente saturada; su centro no tiene medición válida |
| `plane_empty` | `epoch`, `detector` | Esa época no tiene exposiciones en ese detector |
| `few_exposures` | `epoch`, `detector`, `n` | El plano se armó con menos de 5 exposiciones; puede tener huecos y gradientes |
| `low_coverage` | `epoch`, `detector`, `valid_fraction` | Menos del 90 % del plano tiene datos |
| `cutouts_failed` | `n`, `planes` | Faltan recortes después de todos los reintentos |
| `stale_exposure_list` | `listed_at` | La lista de exposiciones es una copia guardada |
| `full_download` | `reason` | Se bajaron archivos completos porque no se pudo cortar la descarga |

## 6. Disposición binaria

Todo en little-endian, sin encabezado, fila por fila desde la fila 0 (sur) y dentro de cada fila desde la columna 0 (este).

| Recurso | Contenido | Bytes |
|---|---|---|
| `/plane/{e}/{d}` | `ny × nx` valores Float32 | `4 × ny × nx` |
| `/cube` | Los planos `ready` y `partial`, en el orden de `planes`, uno detrás de otro | `4 × ny × nx × cantidad` |
| `/aux/{e}/{d}` | `ny × nx` Uint32 de flags y, a continuación, `ny × nx` Uint16 de cobertura | `6 × ny × nx` |
| `/preview` | `ny × nx` valores Float32 de la vista de WISE, en unidades del relevamiento | `4 × ny × nx` |

- El plano `i` dentro de `/cube` empieza en `planes[i].cube_offset`. Los planos `empty` no ocupan lugar.
- `Content-Type: application/octet-stream`. El tamaño exacto sale de `grid.shape`; el frontend debe rechazar una respuesta de otro tamaño.
- Sin compresión obligatoria. gzip reduce el Float32 solo entre un 8 % y un 16 %, porque es ruido; el servidor puede aplicarlo como `Content-Encoding` si el cliente lo acepta. La capa auxiliar sí comprime bien (unas 8 veces).

### Valores de un plano

| Valor | Significado |
|---|---|
| Finito | Brillo superficial en MJy/sr, con el fondo restado: IMAGE − ZODI − mediana residual de cada recorte. Puede ser negativo |
| `NaN` | Sin datos: fuera de la huella de las exposiciones, borde del detector, o todos los píxeles descartados por flags que no son de saturación |
| `+Infinity` | Saturado: ninguna exposición dio un valor válido y la mayoría marca saturación |

No aparece `−Infinity`.

### Capas auxiliares

- **Flags** (Uint32): el bit `n` está encendido si al menos la mitad de las exposiciones que cubren ese píxel lo tienen encendido. Los bits son los de `flags[]`. Es la mayoría y no la unión para que un rayo cósmico en una exposición de veinte no marque el píxel del coadd.
- **Cobertura** (Uint16): cantidad de exposiciones que aportaron un valor válido a ese píxel. Vale 0 exactamente donde el plano es `NaN` o `+Infinity`.

## 7. Píxeles sin datos y fuentes saturadas

### Sin datos

Las esquinas dejan de ser un problema al pedir recortes más grandes (sección 9), pero siguen quedando píxeles sin datos: bordes del detector, exposiciones faltantes y píxeles descartados. Van como `NaN`. El frontend los dibuja en negro (`{colors.void}` de `DESIGN.md`) y la capa de flags los puede resaltar. `stats.valid_fraction` dice cuánto del plano tiene datos.

### Saturación

Medido sobre 358 recortes de Barnard (`spike/resultados/saturacion_barnard.txt`):

- En el núcleo (radio de 1,5 px) el 99,3 % de los píxeles está descartado. El 97,6 % tiene BLOOM y el 59,5 % OVERFLOW.
- Una cuarta parte de esos píxeles trae `NaN` en IMAGE. El resto trae valores unas 10 veces mayores que el máximo válido del recorte, sin garantía. No sirven como valor de relleno.
- RW Aurigae satura a medias: según la época y el detector, queda válido entre el 0 % y el 78 % del núcleo.

Regla: un píxel del plano es **saturado** si ninguna exposición aportó un valor válido y al menos la mitad de las que lo cubren tienen OVERFLOW o BLOOM. Esos píxeles van como `+Infinity`, y los flags con `saturation: true` en `flags[]` son esos dos.

Qué recibe el frontend:

1. El valor `+Infinity` en el plano, distinguible de `NaN` sin pedir la capa auxiliar.
2. `planes[].saturated[]`, con el centro y el radio de cada región, para dibujar un contorno.
3. Un aviso `saturated_source` por fuente, con las épocas y detectores afectados, para el panel de avisos de calidad.

Cómo se muestra:

| Modo | Píxel saturado |
|---|---|
| Parpadeo, mantener apretado y suma | Blanco máximo de la escala, que es como se vería una estrella que excede el rango. En suma alcanza con que esté saturado en una de las épocas |
| Diferencia y rojo/cian | Enmascarado: se dibuja como sin datos si está saturado en cualquiera de las dos épocas comparadas. Una resta contra un valor desconocido no significa nada |

En todos los modos la región lleva un contorno (`planes[].saturated[]`) y el panel de avisos muestra `saturated_source` con el icono `alert` y texto.

Límite conocido: la fotometría sobre un plano con píxeles saturados no es confiable. En RW Aurigae la suma de apertura en D6 varía de 160 a 1014 mJy entre épocas solo por cómo cae la máscara. La Etapa 2 mide sobre exposiciones individuales y tiene que informar los flags de cada punto.

## 8. Entrega progresiva

El backend ordena la descarga por plano, no por fecha:

1. Los planos de la banda pedida (`band`), repartiendo las conexiones entre sus épocas para que todas avancen a la vez y se pueda parpadear cuanto antes.
2. Las demás bandas, de la más cercana a la más lejana de la pedida.

`POST .../priority` cambia el orden de lo pendiente.

Cada plano se emite al menos dos veces:

- **Provisional**, con `status: "building"`, cuando ya entró la mitad de sus exposiciones. Es una imagen real, con más ruido y posibles huecos.
- **Definitivo**, con `status: "ready"` o `"partial"`, cuando terminaron todos sus recortes, con éxito o agotados los reintentos.

Hace falta el provisional porque un plano completo espera a su recorte más lento: con 20 recortes por plano casi siempre hay alguno que recibe varios 503, y el percentil 90 del tiempo por recorte fue de 14,5 s contra una mediana de 2,9 s. La segunda pasada por recortes fallidos produce otra revisión. El frontend se queda siempre con la `rev` más alta.

Obligaciones del visor con lo provisorio:

- Un plano en `building` se distingue a la vista de uno definitivo: rótulo sobre la imagen con la cantidad de exposiciones (`n_used` de `n_exposures`) y marca propia en la línea de tiempo.
- Los modos de comparación avisan si alguna de las épocas comparadas es provisoria.
- Mientras no haya ningún plano de SPHEREx de la banda actual, se muestra la vista de WISE (sección 4.10), rotulada como tal y con su banda. Se retira al llegar el primer plano, aunque sea provisorio.

Tiempos estimados en el escalón base, con 10 conexiones y sin otros trabajos. Salen de la corrida de WISE 0855 con campo de 10′ (0,8 s por recorte en promedio, con 44 % de reintentos); hay que confirmarlos en la fase B:

| Momento | Tiempo desde el `POST` |
|---|---|
| Evento `listed`: línea de tiempo y bandas reales | 2 a 12 s |
| Primera imagen provisional de la banda pedida | 10 a 25 s |
| Todas las épocas de la banda pedida, provisionales: ya se puede parpadear | 20 a 40 s |
| Banda pedida completa | cerca de 1 min |
| Campo completo | de 3,5 min (258 exposiciones) a 7 min (539) |

Dependen de la carga de IRSA: entre el 17 % y el 46 % de los recortes recibe al menos un 503.

## 9. Lo que el backend garantiza al construir

- **Lista de exposiciones:** SIA2, colecciones `spherex_dr1` y `spherex_qr3`. Si IRSA no responde y hay una lista guardada, se usa y se avisa con `stale_exposure_list`.
- **Recorte más grande que el campo:** lado `fov × √2 + 4 px`, para que la grilla quede cubierta con cualquier orientación del detector.
- **Lectura por HDU con camino alternativo:** el backend lee la respuesta de a un HDU y corta la conexión cuando ya tiene IMAGE, FLAGS, VARIANCE y ZODI, identificados por `EXTNAME` y no por posición. Con el orden actual eso ocurre antes de EPSF (0,4 MB en vez de 4,3 MB). Si IRSA cambia el orden, la misma regla sigue leyendo hasta juntar las cuatro, aunque tenga que atravesar EPSF. Si el flujo termina sin las cuatro o un encabezado no se puede interpretar, reintenta bajando la respuesta completa y abriéndola con astropy. `provenance.download_mode` y el aviso `full_download` dicen qué pasó.
- **Reintentos:** hasta 6 por recorte, respetando `Retry-After`, y una segunda pasada al final por los que falten.
- **Proceso:** resta de ZODI y de la mediana residual, máscara con los flags de `flags[].masked`, reproyección bilineal a la grilla, coadd por época y detector ponderado por inversa de la varianza.
- **Planos vacíos:** una época puede no tener exposiciones en un detector (Epsilon Indi B, época 4, D1 y D4). El plano existe en `planes[]` con `status: "empty"`.

## 10. Cola y límite hacia IRSA

| Límite | Valor | Alcance |
|---|---|---|
| Descargas simultáneas de recortes | 10 | Todo el backend, sumando todos los trabajos |
| Consultas SIA2 simultáneas | 2 | Todo el backend |
| Trabajos activos | 2 | Los demás esperan en cola, por orden de llegada |
| Trabajos en cola | 20 | Con la cola llena, `POST` responde `429 queue_full` |

- Dos pedidos del mismo campo comparten un único trabajo.
- Con dos trabajos activos, las 10 conexiones se reparten por turnos entre ambos, así uno grande no frena al otro.
- Un 503 de IRSA se reintenta después de lo que indique `Retry-After`; mientras tanto esa conexión queda libre para otro recorte.
- La posición en la cola llega por el evento `queued` y en `progress.queue_position`.

## 11. Caché y campos precalculados

| Qué | Clave | Vigencia |
|---|---|---|
| Nombre resuelto | Texto buscado | 30 días |
| Lista de exposiciones | Centro y colección | 24 horas; después se usa solo si IRSA no responde |
| Recorte | Exposición, centro y lado | Sin vencimiento; se borran los menos usados al pasar un tope de disco |
| Campo: metadatos, planos, capas auxiliares y vista provisoria | `id` | Sin vencimiento |

- Un campo en caché se sirve sin tocar IRSA. Abrirlo cuesta un `POST` (que ya trae los metadatos) y los planos de la banda actual: 3 o 4 pedidos de 152 kB. El resto llega con `/cube`. Objetivo: menos de 2 s desde el link hasta la primera imagen.
- Los cinco objetos de prueba se precalculan con un script y se guardan en el repositorio, en `backend/data/fields/`. El backend busca primero ahí y después en su caché; el borrado por tope de disco no los toca. `/cube` se arma concatenando los planos al servirlo, así no se guarda dos veces.
- Un campo en caché no se actualiza solo. `refresh: true` vuelve a listar y, si aparecieron exposiciones, reconstruye los planos afectados y sube `rev`. Mientras tanto se sigue sirviendo la revisión anterior.

## 12. Notas para el frontend

No son parte del contrato, pero evitan errores conocidos:

- Recorrer el plano en JavaScript al recibirlo: armar una máscara de un byte por píxel (0 válido, 1 sin datos, 2 saturado) y reemplazar los valores no finitos por 0 antes de subir la textura. El comportamiento de `NaN` e infinito dentro de un shader no está garantizado en todos los controladores.
- Textura `R32F` de WebGL2 con filtro `NEAREST`; el filtrado lineal de texturas de coma flotante necesita una extensión que no siempre está.
- La fila 0 es el sur: sin `UNPACK_FLIP_Y_WEBGL`, la textura queda con el norte arriba.
- Para pasar de píxel a cielo alcanza la proyección gnomónica con `crval`, `crpix` y `cdelt`; el campo es chico y no hay distorsión.

## 13. Fuera de este contrato

- El campo de 1°: son unos 4 GB de recortes por campo. Para contexto amplio está el mapa de la Etapa 3.
- El espectro y la curva de luz (Etapa 2) y los relevamientos de contexto con `/api/survey` (Etapa 3). La vista provisoria de WISE es una versión mínima y aparte.
- La actualización automática de un campo en caché.

## 14. Decisiones tomadas al aprobar

1. **Campo de visión.** Cubo base de 10′ que sirve a las vistas de 5′ y 10′, escalón amplio de 30′ más lento, sin 1°.
2. **Fuente saturada.** `+Infinity` en el plano, dibujada en blanco máximo con contorno y aviso. En diferencia y rojo/cian los píxeles saturados se enmascaran. Se descartó dejar el hueco negro y rellenar con los valores crudos, que son inconsistentes.
3. **Épocas.** Una por pasada, 3 o 4 por campo, como dan los datos. La maqueta dibujaba 8; `DESIGN.md` quedó corregido.
4. **Float32 sin compresión.** gzip casi no reduce.
5. **`id` por geometría**, con la trayectoria del objeto en un endpoint aparte.
6. **Flags por mayoría** en la capa auxiliar. En la Etapa 5 se revisa para los flags de fantasmas (GHOST, GHOST_FPA, GHOST_EXT), que pueden importar aunque aparezcan en pocas exposiciones.
7. **Nombres de banda.** La API usa `detector` de 1 a 6; la interfaz muestra B1 a B6 con los rangos de `detectors[]`. `DESIGN.md` quedó con los rangos de los datos.
8. **Campos precalculados** en el repositorio.
9. **Planos provisorios visibles como tales**, con aviso en los modos de comparación (sección 8).
10. **Vista provisoria de WISE** mientras carga un campo nuevo (sección 4.10).
