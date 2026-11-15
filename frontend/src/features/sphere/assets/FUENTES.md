# Textura del cielo de la esfera

## `cielo-nasa-svs-4k.jpg`

Mapa de todo el cielo en proyección equirrectangular (plate carrée), 4096 × 2048 px, sRGB.

- **Origen:** NASA Scientific Visualization Studio, "Deep Star Maps 2020", https://svs.gsfc.nasa.gov/4851/
- **Archivo original:** `starmap_2020_4k.exr` (4096 × 2048, OpenEXR de media precisión, color lineal), bajado el 15 de noviembre de 2026 de `https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_4k.exr`.
- **Contenido:** estrellas de Hipparcos-2, Tycho-2 y Gaia DR2 más el fondo de la Vía Láctea. Es luz visible, no infrarrojo: sirve de mapa para ubicarse, no es una imagen de SPHEREx.

### Licencia

El contenido de NASA no está sujeto a derechos de autor en Estados Unidos y se puede usar con fines educativos o informativos sin pedir permiso, incluidas páginas web, siempre que se nombre a NASA como fuente y no se sugiera que NASA avala un producto. Fuente: "Guidelines for using NASA Images and Media", https://www.nasa.gov/nasa-brand-center/images-and-media/ (consultada el 15 de noviembre de 2026).

La página del mapa pide este crédito, que la interfaz muestra al pie de la esfera:

> NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.

La página de SVS no declara una licencia propia: remite a esas pautas generales de NASA.

### Orientación

Según la página de SVS, el mapa en coordenadas celestes (ICRF/J2000) "is centered at 0h right ascension, and r.a. increases to the left", con el norte arriba. En píxeles:

```
x = (0,5 − RA / 360) × ancho      (módulo ancho)
y = (90 − Dec) / 180 × alto
```

Se comprobó sobre el EXR midiendo el brillo máximo en una ventana de 13 px alrededor de la posición esperada de diez estrellas brillantes (Sirius, Canopus, Arcturus, Vega, Capella, Rigel, Procyon, Betelgeuse, Achernar y Altair). Con esta convención las diez dan el máximo de la imagen (1,000). Con la ascensión recta creciendo hacia la derecha, o con el origen en el borde, dan valores de fondo (0,02 a 0,3) salvo coincidencias sueltas.

La misma convención está en `raDecToTextureUv` (`../skyMath.ts`), de donde salen tanto la malla de la esfera como la posición de los marcadores. La página de prueba la muestra con `/?dev=sphere&check=1`: cada anillo blanco tiene que rodear a su estrella.

### Conversión

El EXR se pasó a JPEG sin tocar los valores: recorte a [0, 1], curva de transferencia de sRGB (IEC 61966-2-1) y JPEG progresivo de calidad 82 con submuestreo 4:2:0. Con Python 3.12 y los paquetes `OpenEXR`, `numpy` y `pillow`:

```python
import numpy as np
import OpenEXR
from PIL import Image

with OpenEXR.File("starmap_2020_4k.exr") as exr:
    rgb = np.asarray(exr.channels()["RGB"].pixels, dtype=np.float32)

x = np.clip(rgb, 0.0, 1.0)
srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
image = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8), mode="RGB")
image.save("cielo-nasa-svs-4k.jpg", "JPEG", quality=82, optimize=True, progressive=True, subsampling="4:2:0")
```

SVS publica el mismo mapa en 8k, 16k, 32k y 64k.

## `cielo-nasa-svs-8k.jpg`

El mismo mapa en 8192 × 4096 px, sRGB, 8,7 MB. Es el segundo nivel de detalle de la esfera: no entra en la carga inicial. La escena lo pide cuando el campo de visión baja de 70 grados (`DETAIL_FOV` en `../SkyScene.ts`) y reemplaza al de 4k con un fundido de 0,9 segundos. Solo en escritorio: con puntero grueso (teléfonos y tabletas), con el ahorro de datos activado o si la tarjeta no admite texturas de 8192 px, la esfera se queda con el de 4k.

- **Origen, contenido, licencia y crédito:** los mismos que el de 4k (arriba).
- **Archivo original:** `starmap_2020_8k.exr` (8192 × 4096, 130 530 278 bytes), bajado el 15 de noviembre de 2026 de `https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k.exr`.
- **Orientación:** la misma convención que el de 4k. Se comprobó en la página de prueba (`/?dev=sphere&check=1&view=84,0,72`, acercando hasta que cambia el mapa): los anillos de Betelgeuse y Rigel rodean a sus estrellas antes y después del cambio.

### Conversión

La misma receta que el de 4k, con una diferencia: los valores se multiplican por 4 antes del recorte. El mapa guarda flujo por píxel, y un píxel del de 8k cubre un cuarto del cielo que cubre uno del de 4k: sin esa ganancia el de 8k sale cuatro veces más oscuro y la Vía Láctea se apaga cuando cambia el mapa. Medido en una región de 20° alrededor de RA 272°, Dec −6°, sobre los JPEG pasados a lineal: la mediana del de 4k es 0,0242; la del de 8k sin ganancia, 0,0061 (cociente 3,99), y con ganancia, 0,0232.

```python
import numpy as np
import OpenEXR
from PIL import Image

with OpenEXR.File("starmap_2020_8k.exr") as exr:
    rgb = np.asarray(exr.channels()["RGB"].pixels, dtype=np.float32)

x = np.clip(rgb * 4.0, 0.0, 1.0)
srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
image = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8), mode="RGB")
image.save("cielo-nasa-svs-8k.jpg", "JPEG", quality=82, optimize=True, progressive=True, subsampling="4:2:0")
```

Con `uv`, sin instalar nada en el proyecto: `uv run --no-project --with OpenEXR --with numpy --with pillow python convertir.py`.

### Carga

La imagen se decodifica fuera del hilo principal (`createImageBitmap`) y sube a la tarjeta de a franjas de 128 filas, unos 4 ms por cuadro, para no frenar el arrastre. Subida de una sola vez congelaba la página entre 0,3 y 0,4 segundos (medido en Chrome con una GeForce GTX 1070). Por franjas, durante un arrastre continuo de 4 segundos el cuadro más lento fue de 56 ms, una sola vez, cuando el navegador entrega la imagen decodificada.

# Parches de detalle

## `parches/*.png` y `parches/parches.json`

Tercer nivel de detalle: la imagen real de SPHEREx de cada campo precalculado, dibujada sobre la esfera en la posición del campo. Aparece con un fundido cuando su lado ocupa entre 32 y 96 px de pantalla, y el acercamiento a un campo precalculado termina sobre ella antes de abrir el visor.

- **Origen:** los planos guardados en `backend/data/fields` (el cubo de cada campo, armado con imágenes de SPHEREx bajadas de IRSA). No se baja nada.
- **Contenido:** un PNG en escala de grises de 195 × 195 px por campo, con los píxeles del plano tal cual (3,075 segundos de arco por píxel, 10 minutos de arco de lado). 14 archivos, 297 KB en total (de 12 a 28 KB cada uno). Cada uno se pide recién cuando la vista se acerca a su campo.
- **`parches.json`:** por campo, el archivo, el centro (`crval` de la grilla), el tamaño sobre el plano tangente en grados de la proyección TAN, la banda y la época elegidas.

### Regenerar

Desde la raíz del repositorio, después de cambiar los campos de `backend/data/fields` o la lista de `frontend/src/features/entry/featured.ts`:

```
uv run --no-project --with numpy --with pillow python frontend/src/features/sphere/assets/generar_parches.py
```

El script (`generar_parches.py`, en esta carpeta) borra los PNG anteriores y escribe los nuevos y el índice. Qué elige por campo:

- **Banda:** la de apertura del visor (`band` en `featured.ts`).
- **Época:** la del plano de esa banda con más píxeles válidos; si empatan, la de más exposiciones usadas y después la más antigua.
- **Estirado:** el del visor al abrir el campo, es decir asinh con a = 0,1 entre los cortes de `contrastCuts(display, 0,5)` (`src/viewer/stretch.ts`), con sin datos en negro y saturado en blanco. Una diferencia: si más del 3 % de los píxeles válidos queda sobre el corte alto, el corte sube al percentil 97 del plano. Cambia M 1, M 42 y M 82, que con los cortes del visor eran una mancha blanca; en los campos de estrellas el corte queda igual o casi igual.

### Orientación

Norte arriba y este a la izquierda, como el visor. El plano se guarda con la fila 0 en el sur y la columna 0 en el este (`docs/contrato-cubo.md`, sección 6); el script invierte las filas porque un PNG empieza por arriba. La escena pega cada imagen en un rectángulo tangente a la esfera, con su esquina superior izquierda hacia el noreste (`buildPatchGeometry` en `../SkyScene.ts`); visto desde el centro de la esfera, ese rectángulo es la proyección TAN del campo.

Comprobado el 15 de noviembre de 2026 de dos maneras:

- Sobre los PNG, proyectando posiciones de catálogo con la TAN de cada campo. En Barnard's Star, 28 estrellas de Gaia DR3 más brillantes que G = 14,5 (`backend/data/context/269.4463_+4.7683_0.1667/gaia.json`, llevadas de 2016,0 a 2026,2 con su movimiento propio) caen cada una sobre una estrella de la imagen. En M 51, el núcleo de NGC 5195 (RA 202,4983°, Dec +47,2661°) cae sobre la compañera, arriba y a la izquierda del centro (columna 74, fila 14 de 195).
- En pantalla, con `/?dev=sphere&check=1`: los anillos blancos de tres de esas estrellas de Gaia y el de NGC 5195 son marcadores, que la escena ubica por sus coordenadas sin pasar por la imagen. Acercando a Barnard's Star y a M 51 (`&random=0.81` y "Lugar al azar"), cada anillo queda sobre su objeto.

# Constelaciones

Datos en `constelaciones/`, generados con `generar_constelaciones.py` (en esta carpeta). Ninguno se baja al usar la aplicación: van dentro del código de la esfera.

## `limites.json`: a qué constelación pertenece un punto

La tabla de Nancy Roman (1987), "Identification of a constellation from a position", PASP 99, 695, que es el catálogo VI/42 del CDS: 357 renglones con ascensión recta mínima y máxima (horas), declinación mínima (grados) y abreviatura de la IAU, en el equinoccio B1875 y ordenados de norte a sur. `../constellations.ts` lleva el punto a B1875 y toma el primer renglón que lo contiene.

- **Archivo de origen:** `astropy/coordinates/data/constellation_data_roman87.dat`, de astropy 8.0.2, cuyo encabezado dice "This data file is from Roman et al. 1987: https://cdsarc.cds.unistra.fr/viz-bin/Cat?VI/42". Se tomó de ahí porque el 15 de noviembre de 2026 el servidor del CDS no respondía (tiempo de conexión agotado), así que no se comparó renglón por renglón con el original.
- **Licencia:** astropy se distribuye con la licencia BSD de 3 cláusulas (`License-Expression: BSD-3-Clause` en los metadatos del paquete); el texto está en `constelaciones/LICENCIA-astropy.rst`. Los límites en sí los definió la IAU en 1930.
- **Comprobación:** `constelaciones/comprobacion.json` tiene 674 puntos (600 al azar en todo el cielo, 60 a menos de 6° de los polos y los 14 centros de los campos precalculados) con la constelación que da `astropy.coordinates.get_constellation` (astropy 8.0.2). `../constellations.test.ts` exige que `constellationAt` dé lo mismo en todos. Ese archivo solo lo usa el test.

## `nombres.json`: nombres en latín, español e inglés

- **Origen:** d3-celestial, de Olaf Frohn, https://github.com/ofrohn/d3-celestial, archivo `data/constellations.json` de la rama `master` (commit `7e720a3de062059d4c5400a379146a601d9010e0`, del 5 de julio de 2022), bajado el 15 de noviembre de 2026. Según su `readme.md`, los datos salen de la página de constelaciones de la IAU, con la posición de los nombres y algunas líneas modificadas por el autor, y los nombres en otros idiomas, de Wikipedia.
- **Licencia:** BSD de 3 cláusulas, "Copyright (c) 2015, Olaf Frohn" (archivo `LICENSE` del repositorio, leído el 15 de noviembre de 2026). La licencia pide conservar el aviso de copyright y sus condiciones al redistribuir: van completos en `constelaciones/LICENCIA-d3-celestial.txt`.
- **Correcciones propias**, todas en `NAME_FIXES` del script: Octans es "Octante" (la fuente dice "Bastón"), Lepus es "Liebre" (decía "Conejo"), Canis Major y Minor son "Can Mayor" y "Can Menor", Coma Berenices es "Cabellera de Berenice"; en inglés, Ursa Major y Minor son "Great Bear" y "Little Bear" (decía "Big Dipper" y "Little Dipper", que son una parte de cada una), Crux es "Southern Cross" y Puppis, "Stern", como en la lista de la IAU. Las dos mitades de Serpens llevan el nombre "Serpens". El resto de los nombres va como está en la fuente: son traducciones del significado ("Carnero", "Ram") y no se revisaron uno por uno.

## `lineas.json`: las figuras

Las líneas de las 88 constelaciones (89 figuras, porque Serpens son dos; 893 puntos) y la posición de cada nombre. Es la capa "Constelaciones" de la esfera: se pide recién al prenderla (`?const=1` en la URL) y se dibuja con líneas de un píxel en el gris `text-dim` de DESIGN.md.

- **Origen y licencia:** d3-celestial, el mismo repositorio y commit que los nombres, archivos `data/constellations.lines.json` (figuras) y `data/constellations.json` (posición de los nombres). BSD de 3 cláusulas; el texto va en `constelaciones/LICENCIA-d3-celestial.txt`.
- **Coordenadas:** la fuente escribe la ascensión recta como longitud de −180° a 180°; el script la pasa a grados de 0 a 360 (ICRS/J2000) y redondea a 0,001°.
- **Comprobación:** en la página de prueba (`/?dev=sphere&const=1&view=84,0,60`), la figura de Orión pasa por Betelgeuse, Rigel y las tres estrellas del cinturón del mapa de fondo.

## `estrellas.json`: nombres de las estrellas brillantes

Las 200 estrellas más brillantes que tienen nombre propio, de Sirius (magnitud −1,44) a Minelauva (3,39): nombre, ascensión recta y declinación en grados (ICRS/J2000) y magnitud visual. Son los rótulos de estrellas de la capa "Constelaciones": con la vista abierta se nombran las 50 más brillantes y al acercarse se llega a las 200 (`starLabelLimit` en `../SkySphere.tsx`), en el gris `text-mute` de DESIGN.md con un halo fino en negro (en `text-dim` no se leían sobre la Vía Láctea) y sin encimarse con marcadores, nombres de constelaciones ni otros rótulos.

- **Origen y licencia:** d3-celestial, el mismo repositorio y commit que las figuras, archivos `data/stars.6.json` (posición y magnitud) y `data/starnames.json` (nombres), bajados el 15 de noviembre de 2026. BSD de 3 cláusulas; el texto va en `constelaciones/LICENCIA-d3-celestial.txt`.
- **De dónde los toma d3-celestial**, según su `readme.md`: las estrellas, de XHIP, "An Extended Hipparcos Compilation" (Anderson y Francis, 2012; VizieR V/137D); los nombres, de los índices cruzados HD-DM-GC-HR-HIP-Bayer-Flamsteed (Kostjuk, 2002; VizieR IV/27A) y FK5-SAO-HD-Common Name (Smith, 1996; VizieR IV/22).
- **Qué se guarda:** de cada estrella con el campo `name` no vacío, el nombre tal cual (sin traducir: son nombres propios). Las posiciones no llevan movimiento propio; para un rótulo no hace falta.

## Regenerar

Con los archivos de origen en una carpeta (`constellation_data_roman87.dat`, `constellations.json`, `constellations.lines.json`, `stars.6.json` y `starnames.json`), desde la raíz del repositorio:

```
uv run --no-project python frontend/src/features/sphere/assets/generar_constelaciones.py <carpeta>
cd frontend
pnpm exec biome format --write src/features/sphere/assets/constelaciones
```

El segundo paso deja los JSON con el formato que exige el control previo al commit.
