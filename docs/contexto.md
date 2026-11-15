# Contexto de otras misiones (Etapa 3)

Qué servicios dan imágenes de 2MASS y de WISE y fuentes de Gaia DR3 para un campo, qué quedó guardado para los cinco objetos de prueba y cómo se usa desde el backend y el frontend.

Todo lo que sigue se probó contra los servicios reales el 15 de noviembre de 2026, entre las 16:20 y las 17:00 UTC. Ese día hips2fits y SIMBAD de CDS estaban caídos, así que nada de esto pasa por CDS: sale todo de IRSA.

## 1. Qué funciona

| Para qué | Servicio | Resultado |
|---|---|---|
| Recorte de WISE por coordenadas | Recortes del IBE de IRSA sobre las imágenes Atlas de AllWISE | Funciona: 1,7 MB en 4,7 s (0,25°) |
| Recorte de 2MASS por coordenadas | Recortes del IBE de IRSA sobre las imágenes Atlas de 2MASS | Funciona: 0,5 MB en 3,0 s |
| Qué imágenes de 2MASS cubren un punto | Servicio de imágenes de 2MASS (`nph-im_sia`) | Funciona: 0,8 a 1,9 s |
| Qué mosaicos de WISE cubren un punto | Gator sobre la tabla `allwise_p3am_cdd` | Funciona: 1,7 s |
| Lo mismo, con una sola interfaz | SIA2 de IRSA (`twomass_allsky`, `wise_allwise`) | Intermitente: 21 s cuando respondió (2 de 4 pedidos); los otros dos se colgaron más de 90 s |
| Gaia DR3 por cono | Gator sobre `gaia_dr3_source` | Funciona: 3524 fuentes en 4,7 s (radio de 430") |
| Gaia DR3 por cono | TAP de IRSA (`/TAP/sync`) | No respondió en 90 s |
| Gaia DR3 por cono | Cono simple de IRSA (`/SCS`) | No respondió en 100 s |
| Gaia DR3 por cono | Archivo de ESA (`gea.esac.esa.int`) | No aceptó la conexión (21 s) |
| Buscar imágenes | Buscador del IBE (`/ibe/search/...`) | No respondió en 60 s, ni para WISE ni para 2MASS |
| Buscar imágenes | SIA v1 (`/ibe/sia/...`) | `502 Proxy Error` |

Conclusión: IRSA alcanza para las tres cosas. No hizo falta el archivo de ESA, que además no conectó.

### URL exactas

Las de ejemplo son las del campo de Barnard (centro 269,4463°, +4,7683°).

**Recorte por coordenadas** (2MASS y WISE). Se agrega una consulta a la URL de la imagen entera:

```
<url de la imagen>?center=<ra>,<dec>deg&size=<lado>deg&gzip=false
```

```
https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/26/2688/2688p045_ac51/2688p045_ac51-w2-int-3.fits?center=269.446300,4.768300deg&size=0.24258deg&gzip=false
https://irsa.ipac.caltech.edu/ibe/data/twomass/allsky/allsky/000528n/s101/image/ki1010220.fits.gz?center=269.446300,4.768300deg&size=0.24258deg&gzip=false
```

- Documentación: https://irsa.ipac.caltech.edu/ibe/cutouts.html. Sirve para toda imagen servida desde `/ibe/data/`.
- Sin `gzip=false` el recorte llega comprimido.
- El recorte viene en la proyección de la imagen de origen (SIN, norte arriba), no en la grilla del campo: hay que reproyectarlo.
- Si se sale de la imagen llega cortado al borde. Si no la toca en absoluto, responde 500.

**Imágenes de 2MASS que cubren un punto**:

```
https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?POS=269.446300,4.768300&SIZE=0.23556&FORMAT=image/fits&band=K&ds=asky&type=at
```

- Documentación: https://irsa.ipac.caltech.edu/applications/2MASS/IM/docs/siahelp.html. `band` es `J`, `H` o `K`; `ds=asky` es el All-Sky Release y `type=at`, las imágenes Atlas.
- Devuelve un VOTable. De cada fila se usan `date`, `hem`, `scan`, `image`, `center_ra`, `center_dec` y el nombre del archivo, que viene en el parámetro `name` de la columna `download`.
- La URL de la imagen se arma como indica https://irsa.ipac.caltech.edu/ibe/docs/twomass/allsky/allsky/: `https://irsa.ipac.caltech.edu/ibe/data/twomass/allsky/allsky/{date}{hem}/s{scan:03d}/image/{nombre}.gz`.

**Mosaicos Atlas de AllWISE que cubren un punto**:

```
https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?catalog=allwise_p3am_cdd&spatial=None&outfmt=1&selcols=coadd_id,band,crval1,crval2,naxis1,naxis2,pxscal1,date_obs1,mid_obs,date_obs2&constraints=band=2 and crval2>3.86849 and crval2<5.66811 and crval1>268.54207 and crval1<270.35053
```

- Columnas según su diccionario: https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-dd?catalog=allwise_p3am_cdd&mode=ascii. `crval1` y `crval2` son el centro del mosaico.
- Va con `spatial=None` y una caja en `constraints`, no con cono: Gator rechaza un radio de 4000" (`Radius for cone/ellipse search exceeds the limit`) y medio mosaico mide 2815".
- La URL de la imagen se arma como indica https://irsa.ipac.caltech.edu/ibe/docs/wise/allwise/p3am_cdd/: `https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/{coadd_id[:2]}/{coadd_id[:4]}/{coadd_id}/{coadd_id}-w{banda}-int-3.fits`.

**SIA2**, de respaldo:

```
https://irsa.ipac.caltech.edu/SIA?COLLECTION=wise_allwise&POS=circle+269.446300+4.768300+0.11778
https://irsa.ipac.caltech.edu/SIA?COLLECTION=twomass_allsky&POS=circle+269.446300+4.768300+0.11778
```

- Los nombres de las colecciones salen de https://irsa.ipac.caltech.edu/include/SIA2_collection_info.tsv (enlazada desde https://irsa.ipac.caltech.edu/ibe/sia.html).
- La imagen de ciencia es la fila con `dataproduct_subtype = science`; las demás son mapas de cobertura, de incertidumbre y tablas de artefactos. `energy_bandpassname` vale `J`, `H`, `K` en 2MASS y `W1` a `W4` en WISE. `access_url` ya es la URL de la imagen.
- El código prueba primero el servicio de cada misión y usa SIA2 solo si ese falla, con 45 s de tope por intento.

**Gaia DR3 por cono**:

```
https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query?catalog=gaia_dr3_source&spatial=cone&objstr=269.446300+%2B4.768300&radius=430.0&radunits=arcsec&outfmt=1&selcols=source_id,ra,dec,ref_epoch,pmra,pmdec,parallax,phot_g_mean_mag
```

- Documentación de Gator: https://irsa.ipac.caltech.edu/applications/Gator/GatorAid/irsa/catsearch.html.
- `outfmt=1` es una tabla IPAC en texto. El encabezado de la respuesta trae la descripción y la unidad de cada columna: `ra` y `dec` en grados, `ref_epoch` en años (2016,0), `pmra` y `pmdec` en mas/año, `parallax` en mas.
- `pmra` ya incluye el coseno de la declinación. Un valor ausente llega como `null` (fuentes sin movimiento propio medido).
- Un error llega con HTTP 200 y el texto `[struct stat="ERROR", msg="..."]`.

## 2. Qué quedó guardado

En `backend/data/context/`, una carpeta por campo. El nombre es la geometría del campo (`<ra>_<dec>_<fov>` con los decimales del contrato), no su `id`, porque el contexto no depende de la versión del pipeline de SPHEREx.

```
backend/data/context/
  index.json
  269.4463_+4.7683_0.1667/
    context.json      documento de contexto
    twomass_ks.f32    2MASS Ks en la grilla del campo
    wise_w2.f32       WISE W2 en la grilla del campo
    gaia.json         fuentes de Gaia DR3, por columnas
```

| Objeto | Carpeta | 2MASS Ks | WISE W2 | Fuentes de Gaia |
|---|---|---|---|---|
| Barnard's Star | `269.4463_+4.7683_0.1667` | 2000-05-28 | 2010-09-14 (suma de 2010-03-18 a 2010-09-19) | 2159 |
| Epsilon Indi B | `331.0966_-56.8006_0.1667` | 2000-07-17 | 2010-10-27 (2010-04-26 a 2010-10-30) | 212 |
| WISE 0855 | `133.7598_-7.2422_0.1667` | 1998-12-28 | 2010-05-06 (2010-05-03 a 2010-11-13) | 242 |
| RW Aurigae | `76.9566_+30.4013_0.1667` | 1999-11-27 | 2010-09-10 (2010-03-03 a 2010-09-12) | 998 |
| R Draconis | `248.1672_+66.7550_0.1667` | 1999-05-26 | 2010-06-09 (2010-05-28 a 2010-12-27) | 160 |

Son 1,8 MB en total. Las diez capas cubren el 100 % de su campo.

### Capas

- Mismo formato que un plano del cubo (`docs/contrato-cubo.md`, sección 6): 195 × 195 Float32 little-endian, fila 0 al sur y columna 0 al este, `NaN` sin datos. No traen `+Infinity`: no marcan saturación.
- Cada pixel de la grilla (3,075") es el promedio del área que cubre en la imagen de origen (9 muestras en 2MASS, que tiene pixeles de 1", y 4 en WISE, de 1,375"), no el valor interpolado en su centro. Conserva el brillo superficial y baja el ruido.
- Tienen el fondo restado (la mediana) y están en MJy/sr, como los planos de SPHEREx. La conversión usa el `MAGZP` del encabezado y el flujo de magnitud cero de la banda (666,7 Jy en Ks, 171,787 Jy en W2).
- Si el campo cae sobre varias imágenes se arma un mosaico: cada pixel toma el valor de la que más cubre el campo y las demás rellenan lo que falta. No se promedian, porque pueden ser de noches distintas.
- Se guarda una banda por misión: Ks, que cae dentro de B3 de SPHEREx, y W2, porque es donde se ve WISE 0855 (en W1 no se detecta). `--layers` del script guarda otras: `twomass_j`, `twomass_h`, `wise_w1`.

### Fechas

- 2MASS: una imagen Atlas es de una sola noche. La fecha sale de `UT_DATE` y `UT` del encabezado del recorte.
- WISE: un mosaico Atlas suma todas las pasadas de 2010 sobre esa zona, que son dos, separadas por seis meses. `date` es la fecha media de las exposiciones (`MIDOBS`); `date_start` y `date_end`, el intervalo. Para un objeto rápido eso importa: Barnard se movió 5" entre las dos pasadas y el mosaico lo muestra apenas estirado.
- `year` es el año juliano con decimales, para ordenar y para propagar posiciones.
- Cada capa trae además `target`: dónde estaba el objeto en esa fecha, con movimiento propio y paralaje, en coordenadas y en pixeles de la grilla. Es la misma cuenta que `/track`.

### Gaia

`gaia.json` va por columnas: `source_id`, `ra`, `dec`, `pmra`, `pmdec`, `parallax` y `g_mag` son listas, y la fuente `i` es el elemento `i` de cada una. `source_id` va como texto, porque no entra en un número de JavaScript. Están ordenadas de la más brillante a la más débil. Se guardan las fuentes que caen dentro del campo en 1998, 2010, 2016 o 2026, para no perder una estrella rápida que entra o sale.

### Comprobaciones hechas

- **Posición.** En cada capa, el centroide del objeto queda donde lo predice su movimiento propio: Barnard a 0,2" en 2MASS y a 1,8" en WISE (la diferencia es el estirado entre las dos pasadas); Epsilon Indi B a 0,8" y 0,7"; RW Aurigae a 0,5" y 0,3"; R Draconis a 0,1" en 2MASS. WISE 0855 se detecta en W2 a 1,6" de lo esperado, con señal sobre ruido cercana a 26, y no se ve en 2MASS, como corresponde.
- **Astrometría.** En los recortes reales, las estrellas aisladas más brillantes (G menor que 14,5) quedan a menos de 0,08 pixeles (0,25") de la posición de Gaia llevada a la fecha de cada imagen, y las de G menor que 15, a menos de 0,35 pixeles. Es uno de los tests.
- **Unidades.** El flujo de cinco estrellas aisladas del campo de Barnard, medido en la capa Ks y en el plano B3 real de SPHEREx, coincide dentro del 3 % al 13 %; entre W2 y B6, dentro del 2 % al 8 %.

### Límites conocidos

- R Draconis satura en WISE: el núcleo queda en `NaN` (0,01 % del campo).
- Barnard, RW Aurigae y R Draconis saturan en las dos misiones. Las capas sirven para mirar y ubicar, no para fotometría.
- En el mosaico de 2MASS de Epsilon Indi B hay imágenes de dos noches (1999-11-08 y 2000-07-17). La fecha informada es la de la imagen que más cubre el campo, que es la que contiene al objeto.
- La posición de Gaia en otra fecha se calcula con movimiento lineal y sin paralaje. Para dibujar alcanza.

## 3. Backend

Módulo `backend/app/context/`:

| Archivo | Qué hace |
|---|---|
| `surveys.py` | Lista las imágenes que cubren un campo y baja sus recortes, con caché |
| `reproject.py` | Lleva un recorte a la grilla del campo. Es lo que tiene tests |
| `gaia.py` | Consulta de cono a Gator y lectura de la tabla |
| `build.py` | Arma el contexto de un campo con las piezas anteriores |
| `store.py` | Formato en disco y documento de contexto |
| `api.py` | Rutas de solo lectura |
| `devapp.py` | Aplicación mínima para la página de prueba |
| `http.py` | Un GET con timeout, plazo total, reintentos y `Retry-After` |

Los pedidos a IRSA usan el mismo límite global de conexiones que los recortes de SPHEREx y quedan en `backend/cache/context/`, que git ignora.

### Precalcular

Desde `backend/`:

```powershell
uv run python scripts/precompute_context.py                   # los cinco objetos
uv run python scripts/precompute_context.py barnard wise0855  # algunos
uv run python scripts/precompute_context.py --offline-names   # sin consultar Sesame
uv run python scripts/precompute_context.py --layers twomass_ks wise_w1 wise_w2
```

Los cinco objetos tardaron 57 s en total con la caché vacía. El centro de cada campo se resuelve igual que en `/api/resolve`; si Sesame no responde usa la respuesta real guardada en `tests/fixtures/sesame`. Los cinco centros coinciden con los de los campos precalculados de SPHEREx (el de Barnard da el `id` `95d4d56e51048aa4`).

### Rutas

| Ruta | Devuelve |
|---|---|
| `GET /api/context?ra=&dec=&fov=` | Documento de contexto: capas con su fecha y resumen de Gaia |
| `GET /api/context/gaia?ra=&dec=&fov=` | `gaia.json` |
| `GET /api/context/index` | Campos con contexto guardado |
| `GET /api/survey?ra=&dec=&fov=&layer=` | Una capa en Float32 (`layer` es `twomass_ks` o `wise_w2`) |

`ra`, `dec` y `fov` se normalizan igual que en `POST /api/field`. Un campo sin contexto guardado responde `404 not_found` con el cuerpo de error del contrato.

Ya están montadas en `app/api/main.py` (`create_app`), con esta línea:

```python
from app.context.api import router as context_router
app.include_router(context_router)
```

### Tests

`backend/tests/test_context_reproject.py`, 17 casos, sin red: con imágenes sintéticas (la fuente cae en su pixel, norte arriba y este a la izquierda, entrada rotada, brillo conservado, ruido, bordes y huecos, mosaico, unidades) y con dos recortes reales guardados en `tests/fixtures/context/` contra las posiciones de Gaia.

## 4. Frontend

En `frontend/src/features/context/`. Están montados en el visor (`frontend/src/features/viewer`): "Viaje entre misiones" es el modo `journey`, con `MissionJourney` en el muelle de abajo, y la capa de Gaia se prende en el panel Imagen, junto a la de flags. En un campo sin contexto guardado las dos cosas quedan deshabilitadas con una explicación. Los textos están en `src/i18n/locales/<idioma>/context.json`.

| Pieza | Qué hace |
|---|---|
| `MissionJourney` | Control del viaje entre misiones: recorre 2MASS, WISE y las épocas de SPHEREx en orden de fecha, con el año en grande, una marca por imagen sobre la línea de tiempo y el transporte |
| `FrameCanvas` | Dibuja la imagen del cuadro actual y deja poner capas encima |
| `GaiaLayer` | Un anillo por fuente de Gaia, en la posición que tenía en la fecha del cuadro, y su flecha de movimiento propio |
| `GaiaControls` | Prender la capa, largo de las flechas (de 1 a 10 000 años de movimiento) y magnitud límite |
| `contextApi` | Cliente de las rutas de contexto, con validación |

El largo de las flechas va de a saltos de más o menos el triple porque los movimientos propios cubren cuatro órdenes de magnitud: Barnard hace 10" por año y una estrella común del campo, 0,005".

### Página de prueba

```powershell
# desde backend/
uv run uvicorn app.context.devapp:app --port 8000
# desde frontend/
pnpm dev
```

y abrir `http://localhost:5173/?dev=context`. El estado inicial se puede fijar en la URL (`object`, `frame`, `band`, `gaia`, `arrow`, `mag`, `contrast`, `lang`; la lista está en el encabezado de `context.devpage.tsx`).

`devapp` sirve las rutas de contexto y, para las épocas de SPHEREx, los campos ya armados que encuentre en `data/fields`, en `cache/fields`, en las carpetas de `SPHEREX_CONTEXT_DEV_FIELDS` y en los campos de muestra de los tests. Si no encuentra el campo de un objeto, el viaje muestra solo 2MASS y WISE y lo avisa.

### Para integrar

- **Textos.** Están en `context.es.json` y `context.en.json`, al lado de los componentes, y se registran solos con el namespace `context`. No figuran en `src/i18n/resources.ts`. Al integrar conviene moverlos a `src/i18n/locales/` y reemplazar `useContextTexts()` por `useTranslation("context")`; las claves no cambian. El detalle está en `texts.ts`.
- **Datos.** `MissionJourney` recibe una lista de cuadros (`JourneyFrame`). `surveyFrame` arma uno a partir de una capa del contexto y `spherexFrame`, a partir de una época y su plano. `context.devpage.tsx` muestra cómo se juntan.
- **Imagen.** `FrameCanvas` dibuja en CPU con el mismo estirado y los mismos cortes que el visor. Para mostrar el viaje dentro del visor WebGL alcanza con pasarle el plano del cuadro actual: las capas tienen el formato de un plano.

## 5. Diferencias con SPEC.md

`SPEC.md` no se tocó. Lo que cambia respecto de su sección 3.2:

- `/api/survey` no usa hips2fits de CDS ni recibe `hips`: sirve capas precalculadas desde IRSA y recibe `layer`.
- `/api/context` devuelve el documento de contexto, y las fuentes de Gaia van aparte, en `/api/context/gaia`. SIMBAD y SkyBoT no están: son de CDS e IMCCE y no se probaron.
- Solo hay contexto de los campos precalculados. Un campo nuevo no lo arma.
