# Contexto de otras misiones, segunda tanda

Continúa `docs/contexto.md`. Agrega cuatro cosas: contexto para todos los campos precalculados, contexto en vivo para un campo nuevo, la ficha del objeto y una capa óptica más antigua (Digitized Sky Survey) con su cortina visible/infrarrojo.

Todo se probó contra los servicios reales el 15 de noviembre de 2026, entre las 17:30 y las 18:10 UTC, con los pedidos a IRSA de a uno.

Esta tanda agregó solo archivos nuevos. Lo que hace falta tocar en archivos existentes para enchufarla está en la sección 5.

## 1. Contexto para todos los campos precalculados

Los 14 campos de `backend/data/fields` tienen contexto en `backend/data/context`: 2MASS Ks, WISE W2 y Gaia DR3, más las placas del DSS de la sección 4.

| Objeto | Carpeta | DSS, primera generación | DSS, segunda generación | 2MASS | WISE | Fuentes de Gaia |
|---|---|---|---|---|---|---|
| WISE 0855 | `133.7598_-7.2422_0.1667` | 1953 (POSS-I, R) | 1992 (SERC-ER, R) | 1998 | 2010 | 242 |
| M 82 | `148.9685_+69.6797_0.1667` | 1953 (POSS-I, R) | 1998 (POSS-II, R) | 1999 | 2010 | 401 |
| Luhman 16 | `162.2955_-53.3170_0.1667` | 1987 (SERC Quick-V, V) | 1992 (AAO-SES, R) | 1999 | 2010 | 3588 |
| Wolf 359 | `164.0925_+6.9952_0.1667` | 1953 (POSS-I, R) | 1995 (POSS-II, R) | 2000 | 2010 | 103 |
| M 51 | `202.4696_+47.1953_0.1667` | 1956 (POSS-I, R) | 1994 (POSS-II, R) | 1998 | 2010 | 779 |
| Proxima Centauri | `217.3698_-62.6739_0.1667` | 1976 (SERC-J, Bj) | 1997 (AAO-GR, R) | 2000 | 2010 | 11729 |
| R Draconis | `248.1672_+66.7550_0.1667` | 1955 (POSS-I, R) | 1993 (POSS-II, R) | 1999 | 2010 | 160 |
| Barnard's Star | `269.4463_+4.7683_0.1667` | 1950 (POSS-I, R) | 1991 (POSS-II, R) | 2000 | 2010 | 2159 |
| Epsilon Indi B | `331.0966_-56.8006_0.1667` | 1978 (SERC-J, Bj) | 1993 (AAO-SES, R) | 2000 | 2010 | 212 |
| Teegarden's Star | `43.2795_+16.8538_0.1667` | 1951 (POSS-I, R) | 1989 (POSS-II, R) | 1999 | 2010 | 103 |
| RW Aurigae | `76.9566_+30.4013_0.1667` | 1954 (POSS-I, R) | fecha no fiable | 1999 | 2010 | 998 |
| Kapteyn (HD 33793) | `77.9853_-45.0596_0.1667` | 1975 (SERC-J, Bj) | 1990 (AAO-SES, R) | 1999 | 2010 | 170 |
| M 1 | `83.6324_+22.0174_0.1667` | 1951 (POSS-I, R) | no hay | 1997 | 2010 | 1001 |
| M 42 | `83.8201_-5.3876_0.1667` | 1955 (POSS-I, R) | 1990 (SERC-ER, R) | 2000 | 2010 | 913 |

Son 9,9 MB en total. El campo de Proxima pesa 1,2 MB porque cae sobre el plano de la galaxia y su `gaia.json` trae 11 729 fuentes.

### Sin Sesame

`scripts/precompute_context_fields.py` no resuelve nombres. De cada campo toma:

- el centro y el lado, de `meta.json` (`request`);
- el nombre del objeto, de su trayectoria guardada (`track_<nombre>.json`);
- la posición del objeto en la fecha de cada capa, de esa misma trayectoria.

La trayectoria trae la posición en cada época de SPHEREx, con paralaje incluida. Para llevarla 16 a 75 años atrás se estima un movimiento lineal con dos épocas separadas casi exactamente un año (la primera y la tercera pasada): en esas dos fechas la Tierra está en el mismo lugar de su órbita y la paralaje se cancela al restar. Con dos pasadas a seis meses no se estima nada.

Exactitud medida:

- Contra las posiciones calculadas con el movimiento propio del catálogo, en los cinco objetos de prueba: hasta 1,8" a 26 años (Barnard en 2MASS).
- Contra el centroide real del objeto en cada imagen: Wolf 359 a 0,1" (2MASS), 0,2" (1995) y 0,9" (1953); Proxima a 1,3" (2MASS) y 1,5" (placas de 1976 y 1997); Teegarden a 0,5" (2MASS) y 6" en la placa de 1951, a 75 años.

Alcanza para una mira. En las placas de los años 50 puede quedar a dos pixeles de la estrella.

```powershell
# desde backend/
uv run python scripts/precompute_context_fields.py --list   # qué hay y qué falta, sin red
uv run python scripts/precompute_context_fields.py          # los que faltan
```

Un campo que ya tiene contexto no se vuelve a armar. `data/context/index.json` no se reescribe: quedó con los cinco campos originales. No hace falta para nada, porque la API arma el índice leyendo las carpetas.

## 2. Contexto en vivo para un campo nuevo

`backend/app/context/live.py` da, para cualquier centro, el recorte de WISE W2 ya en la grilla del campo y las fuentes de Gaia. Usa los mismos servicios de IRSA que el precálculo, con otra paciencia: un solo intento por pedido, pedidos en serie y un plazo total de 12 s por parte.

| Qué | Primera vez | Desde la caché |
|---|---|---|
| WISE W2 en la grilla | 6,6 s | 0,1 s |
| Fuentes de Gaia | 2,2 s | 0,01 s |
| IRSA inalcanzable | "no disponible" en 3 a 4 s | 0 s durante el minuto siguiente |

Medido con el campo de Kapteyn antes de que estuviera precalculado. El recorte de WISE tardó entre 2 y 7 s en las pruebas, según el mosaico.

Si IRSA no responde, las funciones lanzan `LiveUnavailable` (o `PreviewUnavailable`) y ninguna otra excepción. Se probó apuntando a una dirección que no contesta y a una que responde 404.

### Como vista provisoria

`live.fetch_preview(grid, band, settings)` tiene la firma de `app.preview.hips2fits.fetch_preview`. Para reemplazar al de hips2fits, que estuvo caído todo el día, alcanza con pasarlo en `JobDeps`:

```python
from app.context import live
deps = JobDeps(fetch_preview=live.fetch_preview)
```

- Devuelve siempre W2, sea cual sea el detector pedido. `live.fetch_preview_by_band` sigue la regla del contrato (W1, o W2 con los detectores 5 y 6).
- La imagen viene en MJy/sr y con el fondo restado, no en las unidades del relevamiento como dice la sección 4.10 del contrato.
- `PreviewImage.hips` trae el identificador del mosaico de AllWISE (`IRSA/allwise_p3am_cdd/<mosaico>/w2`), no un HiPS.

### Rutas

`backend/app/context/api_live.py` repite las tres rutas de contexto bajo `/api/live`, para cualquier campo:

| Ruta | Devuelve |
|---|---|
| `GET /api/live/context?ra=&dec=&fov=` | Documento de contexto: el precalculado si existe; si no, lo armado en vivo |
| `GET /api/live/survey?ra=&dec=&fov=&layer=` | Una capa en Float32 (`wise_w2` por defecto) |
| `GET /api/live/context/gaia?ra=&dec=&fov=` | Fuentes de Gaia del campo |

- Lo armado en vivo queda en `cache/context/live`, con el formato del precalculado.
- IRSA sin responder: `503 upstream_unavailable` con `Retry-After`. Durante ese lapso la ruta contesta lo mismo sin volver a pedir.
- Una capa que no se arma en vivo (las de 2MASS: un campo toca cuatro o cinco imágenes y no entra en el plazo): `404 not_found`.
- El frontend usa el mismo cliente con otro prefijo: `createContextApi({ baseUrl: "/api/live" })`.

## 3. Ficha del objeto

`ObjectCard` (en `frontend/src/features/context/`) recibe las fuentes de Gaia del campo, el pixel del clic y la fecha de la imagen, y muestra para la fuente más cercana:

- la distancia en años luz, a partir de la paralaje;
- "esta luz salió hace unos N años";
- cuánto se mueve por año y hacia dónde, con una vara: cuánto tarda en recorrer el ancho de la Luna llena;
- la velocidad a través del cielo, si la distancia está bien medida;
- con qué se la puede ver, según su magnitud;
- los valores de catálogo, para copiar.

Para Barnard: 5,96 años luz, 10" por año hacia el norte, 170 años para cruzar la Luna, 90 km/s.

Reglas que conviene conocer:

- **Radio de búsqueda: 3,1" (un pixel de la grilla).** Con 6" la ficha de WISE 0855 mostraba una fuente de fondo de magnitud 21 que está a 6,1" y no tiene nada que ver. Si no hay fuente en el punto pero sí una a menos de 9", la ficha lo dice y ofrece verla con un botón.
- **Sin fuente de Gaia.** Lo dice y explica por qué: Gaia mide en luz visible y un objeto muy frío no emite ahí. Es lo que pasa sobre WISE 0855 en todas las fechas: la fuente de Gaia más cercana está a 6,2" en WISE y a 11,4", 8,2" y 4,3" en las tres épocas de SPHEREx. Esa última es la estrella de fondo de magnitud 16,3 que `SPEC.md` ubica a 4" en mayo de 2026.
- **Distancia según la calidad de la paralaje.** `gaia.json` no trae el error de cada fuente, así que se usa el error típico de Gaia para su magnitud (0,03 mas hasta G = 15; 0,07 en 17; 0,5 en 20; 1,3 en 21). Con la paralaje a más de 5 veces ese error se dice la distancia; entre 3 y 5, "a grandes rasgos"; por debajo, solo un piso ("a más de N años luz").
- **Movimiento.** Si no llega a 3 veces el error típico, la ficha dice que Gaia no le encuentra movimiento.

Página de prueba: `/?dev=ficha`. Con `center=ra,dec` en la URL prueba un campo cualquiera por las rutas en vivo.

## 4. Capa óptica: Digitized Sky Survey

### Servicio

El archivo de STScI respondió en el primer intento, en 1 a 5 s:

```
https://archive.stsci.edu/cgi-bin/dss_search?v=poss2ukstu_red&r=269.446300&d=4.768300&e=J2000&h=14.55&w=14.55&f=fits&c=none&fov=NONE&v3=
```

- Parámetros y valores de `v`: formulario oficial, https://archive.stsci.edu/cgi-bin/dss_form. `r` y `d` en grados, `h` y `w` en minutos de arco (máximo 60).
- Devuelve un FITS de una sola placa, con su fecha (`DATE-OBS`), su número (`PLTLABEL`), el relevamiento (`SURVEY`), la emulsión, el filtro, el titular (`COPYRGHT`) y un WCS que astropy lee tal cual.
- SkyView de NASA también respondió (3,0 s) y entrega la imagen ya en la grilla pedida, pero su encabezado no trae la fecha de la placa. Por eso no se usa.

Qué da cada valor de `v`:

| `v` | Qué devuelve |
|---|---|
| `poss2ukstu_red` | Segunda generación en rojo: POSS-II al norte, UK Schmidt al sur. 1989 a 1998 en los 12 campos que la tienen con fecha fiable. 1" por pixel |
| `poss1_red` | Primera generación en rojo: POSS-I, 1950 a 1956. 1,7" por pixel. No llega al sur |
| `phase2_gsc1` | Las placas del primer Guide Star Catalog: SERC-J azul (1975 a 1978) o Quick-V (1987) al sur. Al norte no da POSS-I sino Quick-V de 1982 |

La capa `dss1` prueba `poss1_red` y, si no hay, `phase2_gsc1`. La capa `dss2_red` usa `poss2ukstu_red`.

Cosas que salieron al probar:

- **Un error llega con HTTP 200.** Si el relevamiento no cubre el punto, la respuesta es una página HTML de título "ERROR". Hay que mirar el contenido.
- **La hora de `DATE-OBS` no sirve.** Viene con minutos imposibles (`1991-06-16T07:80:00`). Se lee solo el día.
- **Una fecha equivocada.** La placa POSS-II de RW Aurigae (SF07095) dice `1952-08-22`, 35 años antes de que empezara ese relevamiento. La capa se guarda con `date_reliable: false`: sirve como imagen y no entra en el viaje.
- **M 1 no tiene segunda generación.** El servicio responde "Something went wrong; the image file was not created" para ese punto, también con `phase2_gsc2`. Queda con la placa de 1951.

### Qué se guarda

Al lado del contexto de cada campo, `optical.json` y una capa por placa (`dss1.f32`, `dss2_red.f32`), con el formato de un plano del cubo.

- Los valores son densidades de la placa digitalizada con el fondo restado, no flujos. La respuesta de una emulsión no es lineal: no se pueden pasar a MJy/sr ni comparar con las otras capas.
- Astrometría: contra Gaia llevado a la fecha de cada placa, las estrellas del campo de Barnard quedan a 0,4" (1991) y 0,6" (1950) de mediana.
- Cada capa trae `target`, la posición esperada del objeto. En una placa vieja una estrella rápida puede haber estado fuera del campo: Barnard estaba 6' al sur en 1991 y 13' en 1950, así que no aparece en ninguna de las dos.

Va en un documento aparte y no en `context.json` porque el modelo de ese archivo solo admite 2MASS y WISE.

```powershell
uv run python scripts/precompute_optical.py --list
uv run python scripts/precompute_optical.py            # los campos que no tienen capa óptica
```

### Derechos

Las placas tienen titular (Caltech/Palomar, AAO/ROE, STScI/AURA según la placa). Según la página de uso de datos de MAST, https://archive.stsci.edu/publishing/data-use, se pueden usar libremente con fines científicos, educativos y sin fines de lucro, citando el relevamiento. Cada capa guarda la placa y el titular, y el componente `OpticalCredit` los muestra debajo de la imagen. Conviene mantenerlo visible cada vez que se muestre una placa.

### Rutas

| Ruta | Devuelve |
|---|---|
| `GET /api/context/optical?ra=&dec=&fov=` | Documento de capas ópticas del campo |
| `GET /api/survey/optical?ra=&dec=&fov=&layer=` | Una capa en Float32 (`dss2_red` o `dss1`) |

### En el frontend

- **Viaje.** `opticalFrame` convierte una placa en un cuadro del viaje y `journeyLayers` deja las que tienen fecha fiable. Con ellas el viaje de Wolf 359 va de 1953 a 2026: 73 años.
- **Cortina.** `Curtain` pone dos imágenes del mismo campo una sobre otra y las separa con un divisor. Arrastrar o tocar en cualquier lugar lleva el divisor ahí; con el teclado, las flechas lo mueven de a 2 % (10 % con Mayús) y funcionan Inicio, Fin y Av/Re Pág.

Página de prueba: `/?dev=cortina`, con las dos vistas. Vale la pena mirar M 51 con SPHEREx B3 del lado infrarrojo.

## 5. Para integrar

**Actualización:** todo lo de esta sección ya está montado en `etapa-1` (rutas en `app/api/main.py`, `live.fetch_preview` en `JobDeps`, `"DSS"` en `MISSIONS`, textos en `src/i18n/locales/`, contrato 4.10 y `SPEC.md` 3.2). Queda la lista original como registro de lo que se integró:

| Dónde | Qué |
|---|---|
| `backend/app/api/main.py` | `app.include_router(...)` para `app.context.api_live.router` y `app.context.api_optical.router` (y `app.context.api.router`, de la tanda anterior) |
| Donde se arma `JobDeps` | `fetch_preview=live.fetch_preview`, para que la vista provisoria salga de IRSA |
| `frontend/src/features/context/journey.ts` | Sumar `"DSS"` a `MISSIONS`. Hoy `opticalFrame` lo mete con una conversión de tipo |
| `frontend/src/i18n/resources.ts` | Los textos nuevos (`objectCard`, `curtain`) se registran solos, igual que `context`; el traspaso está explicado en `texts.ts` |
| `docs/contrato-cubo.md`, sección 4.10 | Si la vista provisoria pasa a IRSA: unidades (MJy/sr), banda (siempre W2) y qué trae `preview.hips` |
| `SPEC.md`, sección 3.2 | `/api/survey` y `/api/context` no son como dice la tabla: ver la sección 5 de `docs/contexto.md` |

Para probar todo junto sin montar nada:

```powershell
# desde backend/
uv run uvicorn app.context.devapp2:app --port 8000
# desde frontend/
pnpm dev
```

y abrir `/?dev=ficha` o `/?dev=cortina`. `devapp2` trae todas las rutas de contexto y sirve las épocas de SPHEREx de los campos que encuentre en `data/fields`.

## 6. Tests

Solo lo numérico, sin red.

| Archivo | Qué cubre |
|---|---|
| `backend/tests/test_context_fields.py` | Movimiento estimado de la trayectoria: cancelación de la paralaje, elección del par de épocas, cruce del meridiano 0 y comparación con el movimiento propio del catálogo |
| `backend/tests/test_context_optical.py` | Fechas y bandas de placa, fechas imposibles, y una placa real reproyectada contra Gaia |
| `frontend/.../objectFacts.test.ts` | Distancia, error típico, rumbo, cruce de la Luna, velocidad, redondeo y fuente más cercana |
| `frontend/.../optical.test.ts` | Qué placas entran al viaje y en qué orden, lado visible de la cortina y posición del divisor |

El proveedor en vivo y las rutas no tienen tests: se probaron a mano contra IRSA y con IRSA inalcanzable.
