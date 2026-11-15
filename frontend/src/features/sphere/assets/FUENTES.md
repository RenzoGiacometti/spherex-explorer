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

SVS publica el mismo mapa en 8k, 16k, 32k y 64k, por si hace falta más detalle.
