# SkyBlink — especificación (NASA Space Apps 2026)

Documento de trabajo para construir con Claude Code. Equipo: 2 personas.
El nombre público de la herramienta es SkyBlink; "SPHEREx" nombra solo la misión y sus datos. El repositorio y algunos nombres internos conservan el nombre de trabajo, SPHEREx Explorer.
Estado: borrador v3, actualizado con la Etapa 0 y con el contrato de la Etapa 1 aprobado (15 de noviembre de 2026; mediciones en `spike/RESULTADOS.md`, contrato en `docs/contrato-cubo.md`). Lo marcado con **[VERIFICAR]** no está confirmado y hay que probarlo antes de depender de ello.

## 1. Objetivo

Herramienta web pública que, dadas coordenadas (RA, Dec) o un nombre de objeto, muestra imágenes de SPHEREx de esa zona a lo largo del tiempo, de forma que cualquier persona pueda detectar objetos que se mueven o cambian de brillo, y ver su espectro.

Objetos de prueba obligatorios: Barnard's Star, Epsilon Indi B, WISE 0855 (RA 08h55m10.831s, Dec -07d14m42.53s), RW Aurigae, R Draconis.

Las coordenadas de WISE 0855 son las de 2010. Se mueve 8,1" por año: en la época 2026,0 está en RA 133,7598°, Dec −7,2422°, a 126" de ahí. Igual que con Barnard, hay que resolverlo por nombre (`WISE J085510.83-071442.5`) y propagar la posición.

## 2. Hechos de los datos que condicionan el diseño

- SPHEREx usa un filtro variable lineal: en una exposición cada píxel ve una longitud de onda distinta. Un punto del cielo aparece en muchas exposiciones, cada una a otra longitud de onda. No existe "una imagen por fecha"; hay que construirla.
- 6 detectores (bandas), con los rangos que informa IRSA: 0,75–1,12 / 1,10–1,65 / 1,63–2,43 / 2,40–3,85 / 3,81–4,43 / 4,41–5,01 µm. 102 canales espectrales en total.
- Imagen nivel 2: 2040 × 2040 px, 6,15"/px (`s_pixel_scale`; el WCS de un archivo real da 6,13 × 6,15), campo de 3,485°. Proyección `TAN-SIP`. Cada archivo pesa 65 MB.
- Cada archivo (MEF) trae: IMAGE (MJy/sr), FLAGS (bitmap), VARIANCE, ZODI (modelo de luz zodiacal, no restado de IMAGE), EPSF (tabla de PSF, 3,9 MB), WCS-WAVE (longitud de onda por píxel).
- WCS-WAVE es una tabla de consulta por detector: resultó idéntica en todas las exposiciones de un mismo detector, y lo único que cambia por recorte son `CRPIX1W` y `CRPIX2W` en el encabezado de IMAGE. **[VERIFICAR]** que también vale entre versiones de procesamiento (se comprobó solo con `l2b-v27`).
- Bits de FLAGS documentados en el encabezado de la extensión FLAGS (`MSKNnnnn`, `MSKDnnnn`), 23 en total: TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA, HOT, COLD, FULLSAMPLE, PHANMISS, NONLINEAR, PERSIST, OUTLIER, CROSSTALK, SOURCE, GHOST, GHOST_FPA, GHOST_EXT, STREAK, BLOOM, SNOWBALL, HALO, SATELLITE_HALO. No todos los archivos declaran los mismos: sobre 2242 recortes, SNOWBALL (bit 27) falta en 87 y SATELLITE_HALO (bit 29) aparece solo en 6. El número de bit de cada nombre es el mismo en todos. Siempre leer el bit por nombre desde el encabezado de cada archivo.
- Máscara por defecto: los flags del aviso `CONTAINS_BAD_PIXEL` del suplemento explicativo, que es la lista del tutorial oficial de fotometría: todos menos FULLSAMPLE, PHANMISS, OUTLIER y SOURCE. SOURCE marca píxeles de fuentes conocidas: no enmascararlo.
- Las estrellas brillantes saturan. Barnard queda con el núcleo enmascarado (un hueco de 15" a 30") en los seis detectores; R Draconis, con uno de 40" a 90" en todas las épocas y detectores; RW Aurigae satura a medias de D2 a D6 y, en exposiciones individuales, también en D1: 37 de sus 56 exposiciones de D1 tienen la apertura saturada y otra está enmascarada, así que quedan 18 medidas válidas. Epsilon Indi B y WISE 0855 no saturan. Los flags que marcan el hueco son BLOOM (97,6 % del núcleo) y OVERFLOW (59,5 %); una cuarta parte de esos píxeles trae `NaN` en IMAGE.
- Restar ZODI no deja el fondo en cero: queda un residuo de 0,01 a 0,23 MJy/sr que varía entre exposiciones.
- Colecciones vigentes: `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`. Usar DR1 y QR3, no QR2. En los campos probados DR1 llega hasta mayo de 2026 y QR3 empieza en agosto de 2026, sin exposiciones repetidas entre ambas.
- Hay pocas épocas: una pasada cada 6 meses desde fines de abril de 2025. Cuatro de los objetos de prueba tienen 3 y Epsilon Indi B tiene 4, con 74 a 212 exposiciones por pasada. Una pasada dura de 2 a 7 semanas, y cerca del polo eclíptico casi 3 meses (R Draconis: 67 a 88 días, 539 exposiciones en total). Con un campo de 10′ una pasada puede quedar en menos de un día: la primera de WISE 0855 son 30 exposiciones en 0,8 días.
- Una pasada puede ser pobre o incompleta: WISE 0855 tiene 30 exposiciones en mayo de 2025, y en Epsilon Indi B la época 4 no tiene ninguna exposición en D1 ni en D4 y la época 1 tiene 3 y 4. Con menos de 5 exposiciones el coadd queda con parches y gradientes.
- Los flags no cubren todos los artefactos: cerca de Epsilon Indi A (a 7′) quedan anillos y rastros en D5 y D6.
- Movimiento medido en 12 meses: Barnard 10,3" (1,7 px), WISE 0855 7,7" (1,25 px). Entre épocas consecutivas, menos de 1 px.
- WISE 0855 se detecta en el coadd por época de D6 (S/R ≈ 10 con 21 exposiciones) y de D5. Tiene una estrella de fondo a 4" (mayo de 2026) que se ve en D1 a D4.
- Existe un cubo HiPS de todo el cielo (DR1, orden máximo 5, 102 planos): `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube`. Cada tile FITS pesa aprox. 300 MB: solo sirve procesado offline.

### Acceso

- Buscar exposiciones que cubren un punto: SIA2 (`https://irsa.ipac.caltech.edu/SIA?COLLECTION=...&POS=circle+ra+dec+r`), una consulta por colección, con respuesta en VOTable. Columnas útiles: `access_url`, `t_min` y `t_max` (MJD), `energy_bandpassname` (`SPHEREx-D1` a `SPHEREx-D6`), `obs_id`, `obs_collection`, `em_min`, `em_max`. Tarda de 1 a 5 s por colección y devuelve HTTP 502 de forma intermitente; también puede quedar caído un rato largo: el 15 de noviembre de 2026 respondió `502 Proxy Error` a 27 pedidos seguidos, hasta las 11:14 UTC, mientras el servicio de recortes andaba normalmente, y a las 13:40 UTC ya respondía. Un campo nuevo sin lista guardada falla en ese caso con `upstream_unavailable`. Puede atrasarse un día respecto a TAP. No pedir CSV: la columna `cloud_access` contiene comas sin entrecomillar.
- Alternativa: TAP de IRSA (`https://irsa.ipac.caltech.edu/TAP`), tablas `spherex.artifact` y `spherex.plane` unidas por `planeid`, y `spherex.observation` (por `obsid`) para la colección; filtro `CONTAINS(POINT('ICRS', ra, dec), p.poly)`; columnas `a.uri`, `p.time_bounds_lower` (fecha) y `p.energy_bandpassname` (detector). Los nombres están confirmados en `TAP_SCHEMA`. **[VERIFICAR]** que la consulta responda: en la Etapa 0 agotó el tiempo de espera (más de 5 minutos) y el modo asíncrono dejó los trabajos en cola.
- Recorte: `<access_url>?center=<ra>,<dec>d&size=<lado>`. `size` sin unidad está en grados (admite `deg`, `arcmin`, `arcsec`, `px`, y `ancho,alto`). La unidad de `center` va una sola vez, al final. Con 0,1° salen 59 × 59 px. El recorte viene en la orientación del detector y trae todas las extensiones, EPSF entera incluida (4,0 MB en total). Fuera de la imagen responde HTTP 422.
- El servicio de recortes no comprime ni respeta `Range`. Como las extensiones de imagen vienen antes que EPSF, se puede leer el FITS de a un HDU y cortar la conexión al llegar a EPSF: 125 kB y 1,7 s por recorte en vez de 4,0 MB y 12,5 s.
- Cuando está cargado, IRSA responde HTTP 503 `Server busy, retry later.` con `Retry-After: 5`. Le pasó a entre el 17 % y el 46 % de los recortes, también con 3 conexiones. El backend respeta la espera pedida hasta un máximo de 60 s; si IRSA pide más, da el recorte por fallido en ese trabajo.
- Rendimiento medido (campo de 0,1°, 10 conexiones, descarga cortada): 258 a 539 exposiciones en 85 a 210 s, más 10 a 23 s de proceso. El tutorial oficial informa 84 imágenes en 20 s de consulta TAP y 13 s de descarga; no se reprodujo.
- El costo de un recorte crece con el área, porque el servicio siempre entrega píxeles nativos. Con lado `fov × √2 + 4 px`: 0,16 MB y 1,8 s para 5′; 0,40 MB y 2,3 s para 10′; 2,9 MB y 8,8 s para 30′; 11 MB y 31 s para 1°. Un campo de 10′ con recortes agrandados (WISE 0855, 258 exposiciones) tardó 207 s y quedó cubierto al 100 %.
- Tutoriales: https://caltech-ipac.github.io/irsa-tutorials/spherex/

## 3. Arquitectura

```
Navegador (React + Vite + TypeScript)
  ├─ Visor 2D: WebGL sobre el "cubo del campo"
  ├─ Esfera: three.js
  ├─ Mapa de contexto: Aladin Lite v3
  └─ Gráficos: SVG propio, sin biblioteca de gráficos (espectro, curva de luz)
        │  HTTP + SSE
Backend (Python, FastAPI)
  ├─ astropy, pyvo/astroquery, reproject, photutils, numpy
  ├─ Caché en disco por (ra, dec, fov, release) y por exposición
  └─ Objetos de prueba precalculados
        │
IRSA (SIA2, TAP, recortes) · CDS (Sesame, SIMBAD, hips2fits, SkyBoT) · Gaia DR3
```

Decisión central: el backend arma un **cubo del campo** y lo envía como datos crudos; el frontend hace todo el procesamiento visual en WebGL. Así contraste, RGB, diferencia, suma, cortina, lupa, rojo/cian y los gestos no vuelven al servidor.

### 3.1 Cubo del campo

Construcción en el backend. Los pasos están probados en `spike/field.py`, salvo los dos marcados como pendientes, que salen de sus resultados:
1. Listar por SIA2 las exposiciones de DR1 y QR3 que cubren el punto. Guardar la última lista buena y usarla si IRSA no responde.
2. Descargar recortes en paralelo (10 conexiones, caché por exposición), cortando la conexión antes de EPSF. Hasta 6 intentos, respetando `Retry-After`. Pendiente: una segunda pasada al final por los que falten. Pendiente: pedir el recorte con lado `fov × √2` más un par de píxeles; con el mismo lado que el campo, las esquinas de la grilla quedan sin datos (88 % de cobertura en WISE 0855).
3. Restar ZODI y después la mediana residual de cada recorte. Enmascarar píxeles según FLAGS (lista de la sección 2).
4. Reproyectar cada recorte a una grilla común centrada en (ra, dec), norte arriba: proyección TAN, 3,075"/px (dos píxeles de salida por píxel nativo), interpolación bilineal. Para objetos con movimiento propio, el centro es su posición en una época fija (2026,0), así la caché de recortes no cambia cuando aparecen exposiciones nuevas.
5. Agrupar por época (fechas separadas por más de 60 días = épocas distintas) y por detector.
6. Coadd por (época, detector): media ponderada por inversa de la varianza.

Resultado: arreglo `[épocas][6 detectores][ny][nx]` Float32 + capas de flags y cobertura + metadatos. `NaN` es sin datos y `+Infinity` es saturado.

Campos admitidos: un cubo base de 10′ (195 × 195 px a 3,075"/px), que sirve a las vistas de 5′ y 10′, y uno amplio de 30′ (293 × 293 px a 6,15"/px), más lento. El campo de 1° queda fuera: son unos 4 GB de recortes.

El formato exacto, la entrega progresiva, la cola y la caché están en `docs/contrato-cubo.md`, que manda sobre esta sección.

Cada exposición ve el objeto a otra longitud de onda y cada época muestrea longitudes de onda distintas. Por eso una fuente fija con color no se anula del todo al restar dos épocas del mismo detector.

Rehacer el cubo desde recortes en caché tardaba de 10 a 16 s en la Etapa 0. El pipeline del backend procesa una exposición en unos 25 ms (de 7 a 14 s para los campos de prueba, estimado) y da los mismos planos que el de la Etapa 0, con diferencias de redondeo. Igual hay que guardar el cubo armado.

### 3.2 API

| Endpoint | Devuelve |
|---|---|
| `GET /api/resolve?name=` | RA/Dec desde Sesame (salida XML `-ox`, con espejo en CfA por si CDS no responde), o las coordenadas si el texto lo es. Un nombre desconocido llega como HTTP 200 con un `Target` sin `Resolver`; movimiento propio, paralaje y velocidad radial aparecen solo si el catálogo los trae. Trae posición J2000, movimiento propio, paralaje y velocidad radial, y el centro del campo propagado a la época 2026,0 |
| `POST /api/field {ra, dec, fov, band}` | `id` del campo, estado y metadatos. Es idempotente: el `id` sale de la geometría |
| `GET /api/field/{id}/events` | SSE: `state`, `queued`, `preview`, `listed`, `progress`, `plane`, `warning`, `done`, `error` |
| `GET /api/field/{id}/meta` | JSON: grilla, detectores con su escala de contraste, épocas, planos con estado y estadísticas, flags, avisos, avance |
| `GET /api/field/{id}/plane/{época}/{detector}` | Un plano en Float32, apenas está listo (provisorio o definitivo) |
| `GET /api/field/{id}/cube` | Todos los planos en Float32, sin compresión, cuando el campo terminó |
| `GET /api/field/{id}/aux/{época}/{detector}` | Flags por mayoría (Uint32) y cobertura (Uint16) de un plano |
| `GET /api/field/{id}/preview` | Recorte de WISE W2 de la misma zona, pedido a IRSA, como vista provisoria mientras carga un campo nuevo |
| `GET /api/field/{id}/track?name=` | Posición esperada del objeto en cada época, con movimiento propio y paralaje |
| `POST /api/field/{id}/priority {band}` | Adelanta los planos de una banda |
| `GET /api/spectrum?ra=&dec=&field=` | Documento del espectro: puntos {longitud de onda, flujo, error, fecha, detector, flags}, promedios por tramo, épocas, detectores y avisos (`saturated_source`, con la forma del contrato del cubo, y `offset_source`). `pm_ra`, `pm_dec` y `epoch` opcionales para que la apertura siga a un objeto que se mueve. Con `field` de un campo precalculado el clic se ajusta a la fuente guardada más cercana dentro de 12″ (aviso `snapped_source`); si no hay ninguna responde 200 con `status: "no_source"`, `nearest` y `saved_sources`, sin puntos |
| `GET /api/context?ra=&dec=&fov=` | Documento de contexto del campo: capas de otras misiones con su fecha y resumen de Gaia. Solo lo precalculado; un campo sin contexto responde `404 not_found` |
| `GET /api/context/gaia?ra=&dec=&fov=` | Fuentes de Gaia DR3 del campo (posición en 2016,0, movimiento propio, paralaje, magnitud G) |
| `GET /api/context/index` | Campos que tienen contexto guardado |
| `GET /api/context/optical?ra=&dec=&fov=` | Capas ópticas del campo: placas del Digitized Sky Survey con su fecha, relevamiento, número de placa y titular |
| `GET /api/survey/optical?ra=&dec=&fov=&layer=` | Una placa (`dss1` o `dss2_red`) en Float32, en la grilla del campo. Son densidades de placa, no flujos |
| `GET /api/live/context`, `/api/live/context/gaia`, `/api/live/survey` | Lo mismo que las rutas de contexto, para cualquier campo: lo precalculado si existe y, si no, WISE W2 y Gaia pedidos a IRSA con un plazo corto. Con `SPHEREX_PRECOMPUTED_ONLY`, solo lo guardado |
| `GET /api/survey?ra=&dec=&fov=&layer=` | Una capa de otra misión (`twomass_ks`, `wise_w2`) en Float32, ya reproyectada a la grilla del campo. No usa hips2fits de CDS ni recibe `hips`: sirve capas precalculadas desde IRSA (`docs/contexto.md`, sección 5) |

Espectro: fotometría de apertura sobre cada exposición individual (no sobre el coadd), fondo en anillo, longitud de onda tomada de WCS-WAVE en el píxel del objeto, error desde VARIANCE. WCS-WAVE va después de EPSF y la descarga cortada no la trae: bajar un recorte completo por detector y reutilizar su tabla con el encabezado de IMAGE de cada recorte.

### 3.3 URL del frontend

`/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink` — todo el estado en la URL. `fov` es el lado de la vista en grados (5′, 10′ o 30′); `name` es opcional y sirve para la mira y el rastro. `&embed=1` oculta la interfaz alrededor del visor. El ejemplo es WISE 0855 en su posición de 2026.

- `mode`: `blink`, `difference`, `sum`, `redcyan`, `hold`, `journey` (viaje entre misiones) o `curtain` (cortina visible/infrarrojo). Sin contexto para el campo, o con `embed=1`, `journey` cae a `blink` sin reescribir la URL; `curtain` también, si el campo no tiene placa óptica.
- `ref`: época de referencia (la B de diferencia, rojo/cian y mantener apretado) elegida a mano. Sin `ref` es automática: entre las épocas que tienen, en la banda que se ve, al menos la mitad de las exposiciones de la mejor, la más lejana en fecha a la actual. Con esa regla y estirado lineal, WISE 0855 en B6 pasa de 2,5 a 7,6 sigmas en la diferencia. `ref` es del campo: se borra al cambiar de campo.
- `stretch`: `linear`, `log` o `asinh`, si se eligió a mano. Sin `stretch`, diferencia y rojo/cian abren en lineal y los demás modos en asinh.

## 4. Alcance

Entran (numeración del Whiteboard): 1–20, 23–26, 28–34, 37, 39–43, 47, 49.
Fuera: 21, 22, 27, 35, 36, 38, 44, 45, 46, 48, 50.

## 5. Etapas

Cada etapa termina en algo que se puede mostrar.

### Etapa 0 — Prueba técnica (hecha el 15 de noviembre de 2026)
- Script Python que, para Barnard y WISE 0855: lista exposiciones, baja recortes, arma el cubo y guarda PNG por época y detector. Código en `spike/`, resultados en `spike/RESULTADOS.md`.
- Medido: 358 y 258 exposiciones, 3 épocas cada uno; de 105 a 185 s por campo nuevo; de 0 % a 7 % de recortes fallidos con 4 intentos y de 0 % a 1 % con 6.
- **Resultado:** Barnard se desplaza 10,3" entre la primera y la última época (esperado 10,3"). WISE 0855 es detectable en el detector 6 con coadd por época (S/R ≈ 10), y también en el 5.

### Etapa 1 — Visor (ideas 1, 2, 3, 4, 5, 6, 11, 12, 19, 42, 43)
- Contrato entre backend y frontend: `docs/contrato-cubo.md`.
- Backend: `/resolve`, `/field` con SSE y entrega progresiva por plano, cola con límite global hacia IRSA, caché del cubo armado, precálculo de los 5 objetos (guardados en el repositorio).
- Frontend: buscador, visor WebGL con escala (lineal, log, asinh) y contraste, selector de detector, reproductor con línea de tiempo, selector de campo de visión (5′, 10′, 30′), estado en URL, modo embed.
- Modos de comparación como shaders: diferencia, suma, rojo/cian, mantener apretado. En diferencia y rojo/cian los píxeles saturados se enmascaran.
- Capa de flags, panel de metadatos y aviso visible cuando una fuente está saturada.
- Un plano provisorio se distingue a la vista de uno definitivo, y los modos de comparación avisan si alguna de las épocas comparadas es provisoria.
- Vista provisoria mientras carga un campo nuevo: recorte de WISE W2 de la misma zona, pedido a IRSA desde el backend y rotulado como tal.
- Tests del backend sin red, con recortes guardados como fixtures.
- **Hecho cuando:** un link con coordenadas abre el visor; los cinco objetos de prueba abren en menos de 2 s; en un campo nuevo la primera imagen aparece apenas llega y el resto se completa con barra de progreso.

### Etapa 2 — Espectro (8, 9, 10, 7, 13, 30, 31, 32, 41)
- `/spectrum` y panel de espectro al hacer clic, con barras de error. Un clic o toque corto sobre la imagen pide el espectro de ese punto; sobre la mira del objeto con nombre se piden su posición y su movimiento propio. Arrastrar, pellizcar, la rueda, el doble clic y mantener apretado no lo piden (el clic espera 350 ms para distinguirse del doble clic). Los avisos de fuente saturada y de fuente corrida van arriba del gráfico.
- Marcas de H2O, CO2, CO, CH4 y plantillas (enana T, enana Y, estrella M). **[VERIFICAR]** Los límites de las bandas de `frontend/src/features/spectrum/molecules.ts` salen de la bibliografía que cita ese archivo (Cushing, Rayner y Vacca 2005; Yamamura, Tsuji y Tanabe 2010), redondeados a la resolución del instrumento. No se contrastaron con espectros de SPHEREx ni con las tablas de bandas de la misión.
- El gráfico del espectro es SVG propio (`SpectrumChart`), no uPlot: son a lo sumo unos cientos de puntos y así las barras de error, las bandas moleculares y los tokens de color quedan bajo control del sistema de diseño.
- RGB eligiendo tres detectores. Curva de luz por detector.
- Estado de la curva de luz: `GET /api/lightcurve` (mismos parámetros que el espectro) da la variación relativa por banda, con fotometría sobre las alas para las fuentes saturadas. El panel que abre el clic tiene dos pestañas, Espectro y Curva de luz, sobre la misma fuente. Arriba del gráfico se avisa cuando la curva es de variación relativa medida en las alas y, si no hay curva, por qué (serie insuficiente, inestable o mezclada, o no hay curva guardada para ese punto). En los campos de R Draconis y RW Aurigae, las variables del desafío, la curva se ofrece al abrir el campo. Las curvas de las fuentes con espectro guardado están en `backend/data/lightcurves/fields/` (279 fuentes, 1,4 MB).
- Regla del clic sobre la imagen: por defecto abre espectro y curva; una herramienta activa (medir, recorrido guiado) lo toma mientras dura (`frontend/src/features/viewer/imageClick.ts`).
- Huella química (rotulada como "indicio"), lupa espectral, sonificación con WebAudio.
- Slider de longitud de onda y arrastre en dos ejes (con botón de modo para no chocar con el paneo).
- Espectros guardados por campo: la imagen pública no lleva los recortes, así que cada campo precalculado guarda el espectro de su objeto con nombre y de sus fuentes más brillantes (hasta 20, detectadas sobre el coadd: 279 en los 14 campos) en `backend/data/spectra/fields/<id>.json.gz` (2,6 MB en total). Se generan con `uv run python scripts/precompute_field_spectra.py --workers 4` desde `backend/`, sin red, a partir de los recortes de `backend/cache/cutouts`; hay que volver a correrlo cuando se agrega o se rearma un campo precalculado. En esos campos el archivo manda aunque los recortes estén en disco; en un campo armado en vivo el espectro se mide sobre los recortes. Con `SPHEREX_PRECOMPUTED_ONLY=1` nunca se mide: lo que no está guardado responde `404 not_found`.
- Investigación: fotometría sobre las alas para fuentes saturadas, con R Draconis y Barnard como casos de prueba. R Draconis no tiene ningún píxel válido sobre la estrella en ninguna exposición.
- **Hecho cuando:** clic en RW Aurigae muestra espectro y curva de luz coherentes en D1. RW Aurigae también satura en D1 en exposiciones individuales (37 de 56): el criterio se cumple con sus 18 puntos válidos, todos de D1.

### Etapa 3 — Contexto (16, 17, 18, 47, 29, 33)
- Aladin Lite como mapa base con WISE, 2MASS, DSS.
- Overlay de Gaia con flechas de movimiento propio; objetos del sistema solar con SkyBoT.
- Ficha del objeto (SIMBAD + Gaia) en lenguaje llano.
- Cortina visible/infrarrojo y viaje en el tiempo entre misiones con `/survey`.
- Estado: el contexto (2MASS Ks, WISE W2, Gaia DR3 y placas del Digitized Sky Survey) se precalcula con `backend/scripts/precompute_context.py`, `precompute_context_fields.py` y `precompute_optical.py`, y queda en `backend/data/context/` para los 14 campos precalculados (`docs/contexto-2.md`); las rutas solo leen lo guardado, así que valen igual con `SPHEREX_PRECOMPUTED_ONLY`. SIMBAD y SkyBoT no están (son de CDS e IMCCE y no se probaron). "Viaje entre misiones" es un modo más del visor y la capa de Gaia se prende junto a la de flags; los 14 campos precalculados tienen contexto, así que las dos cosas están habilitadas en todos. El viaje empieza por la placa más antigua del Digitized Sky Survey (Wolf 359: de 1953 a 2026), muestra siempre el crédito de la placa debajo de la imagen y avisa cuando el objeto estaba fuera del campo en una placa vieja (Barnard en 1950 y 1991). La cortina visible/infrarrojo es otro modo: la placa del DSS de un lado y SPHEREx del otro. La ficha del objeto (distancia, movimiento y magnitud según Gaia, en lenguaje llano) va arriba de las pestañas del panel que abre el clic. Un campo nuevo pide WISE W2 y Gaia en vivo por `/api/live`: ahí el viaje no tiene placas ni 2MASS y la cortina queda deshabilitada. La entrada tiene dos accesos directos: "Viaje en el tiempo" (Wolf 359) y "Visible contra infrarrojo" (M 51 con SPHEREx B3). El detalle está en `docs/contexto.md` y `docs/contexto-2.md`.
- **Hecho cuando:** el slider de misiones muestra a Barnard moviéndose a lo largo de décadas.

### Etapa 4 — Esfera (28, 23, 37)
- Esfera three.js con textura de todo el cielo: el mapa estelar "Deep Star Maps 2020" de NASA Scientific Visualization Studio (estrellas de Hipparcos-2, Tycho-2 y Gaia DR2 más la Vía Láctea), equirrectangular de 4096 × 2048 px. Es luz visible, no infrarrojo: sirve de mapa para ubicarse y no es una imagen de SPHEREx. Origen, licencia, crédito y orientación, en `frontend/src/features/sphere/assets/FUENTES.md`. Una textura infrarroja (WISE, 2MASS o SPHEREx) queda para después, si el procesamiento offline del HiPS resulta viable.
- Niveles de detalle al acercarse: el mismo mapa en 8192 × 4096 px, que se pide recién cuando el campo de visión baja de 70 grados (solo en escritorio), y un parche con la imagen real de SPHEREx de cada campo precalculado, dibujado en su lugar sobre la esfera. El acercamiento a un campo precalculado termina sobre su parche y recién ahí abre el visor, que muestra esa misma imagen. Los parches se regeneran con `frontend/src/features/sphere/assets/generar_parches.py` cuando cambian los campos.
- La esfera es la pantalla de entrada, con un solo buscador (ejemplo en grados decimales: `Barnard's Star · 269.4463 +4.7683`). Sin WebGL quedan el buscador, "Lugar al azar" y los cinco destacados como links.
- Marcadores de los 5 objetos, clic → zoom → visor. Botón de lugar al azar, que elige entre todos los campos precalculados (`PRECOMPUTED_FIELDS`), no solo entre los cinco.
- Modo celular como ventana: DeviceOrientation + geolocalización + hora para pasar de altitud/azimut a RA/Dec. Requiere HTTPS y permiso explícito en iOS.

### Etapa 5 — Medir y participar (14, 49, 20, 34)
- Estado: el medidor de movimiento propio está en el visor como la herramienta "Medir" (`frontend/src/features/measure`, solo frontend): un conmutador en la columna derecha (una tira en celular; no se ofrece en `embed`). Prendida, el clic sobre la imagen marca el objeto en la época que se ve (toma el clic con el id `measure`), el visor pasa a parpadeo en pausa y cambiar de modo la apaga. El clic se ajusta al centroide o, si la fuente satura, al centro de sus alas (`docs/alas-saturadas.md`). Con dos marcas da el desplazamiento y con tres descuenta el vaivén de seis meses; sobre Barnard, con tres épocas, dio 10,31 ± 0,44 ″/año contra 10,45 de catálogo. Avisa arriba del panel cuando las dos marcas son de estaciones opuestas y cuando hay una fuente vecina a menos de 12″ de la marca (criterio de simetría: un píxel supera a su opuesto en el 25 % del pico y 5 sigmas; solo en marcas de centroide, y no ve vecinas a menos de unos 5″).
- Estado: el recorrido guiado "Encontrá a WISE 0855" (`frontend/src/features/guide`) se inicia desde la entrada y maneja el visor haciendo clic en sus controles. Son seis pasos: elegir B6 (pasa el estirado a lineal), reproducir el parpadeo, rojo/cian, marcar el objeto (toma el clic con el id `guide`), verlo señalado y abrir su espectro. El último paso explica que la luz por debajo de 3,8 µm es de la estrella de fondo que entra en la apertura y la del objeto es la subida entre 4 y 5 µm.
- Marcar un objeto por época → movimiento propio, trayectoria y predicción, comparado con Gaia.
- Reportar candidato (base de datos simple, link compartible).
- Clasificación por deslizamiento sobre un lote precalculado que incluye objetos conocidos.
- Revisar la capa de flags para los fantasmas (GHOST, GHOST_FPA, GHOST_EXT). En la Etapa 1 un flag se enciende en el coadd si lo tiene al menos la mitad de las exposiciones; un fantasma puede aparecer en pocas y aun así confundirse con un candidato.

### Etapa 6 — Si sobra tiempo (26, 40, 24, 25+39, 15)
- Exportar GIF/MP4, recorrido automático, clasificador por plantillas, modo 3D con vuelo al objeto, candidatos automáticos.

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| IRSA lento o con fallos durante la demo (confirmado: 502 en SIA2 y TAP, 503 en recortes, TAP sin responder) | Caché y precálculo; la demo corre sobre objetos en caché. Un campo nuevo tarda de 2 a 3 minutos: barra de progreso obligatoria. Si SIA2 rechaza el listado, el trabajo reintenta con pausas crecientes durante 5 minutos antes de fallar, y el visor avisa que el archivo de datos está lento (contrato, sección 4.11). El 15 de noviembre de 2026 a las 17:55 SIA2 respondía `502` en 0,6 s a las dos colecciones |
| WISE 0855 mezclado con una estrella de fondo (a 4" en mayo de 2026, acercándose) | Se detecta en D6, donde la estrella aporta poco; marcar la posición esperada y mostrar la diferencia entre épocas |
| Estrellas brillantes saturadas (Barnard: hueco en el centro) | El núcleo se dibuja en blanco máximo con contorno y aviso, y se enmascara en diferencia y rojo/cian; las posiciones se miden ajustando las alas |
| R Draconis satura por completo: no hay píxeles válidos sobre la estrella en ninguna exposición | El criterio de la Etapa 2 pasó a RW Aurigae en D1, que tampoco está libre de saturación: 37 de 56 exposiciones, y el criterio se cumple con los 18 puntos válidos. La fotometría sobre las alas queda como investigación |
| El campo de 1° de la maqueta no es viable con recortes (4 GB por campo) | Campos de 5′, 10′ y 30′; para contexto amplio, el mapa de la Etapa 3 |
| hips2fits de CDS sin responder (pasó todo el 15 de noviembre de 2026: 404 con la página "Page unavailable") | La vista provisoria ya no depende de CDS: sale de WISE W2 en IRSA (`app.context.live`), probada contra el servicio (5,8 s). Es opcional: si IRSA no responde en el plazo, el campo carga igual sin vista. `/api/survey` tampoco usa hips2fits |
| Pocas épocas, movimiento subpíxel | Rojo/cian, diferencia y viaje entre misiones. La diferencia entre épocas ya muestra un dipolo claro en Barnard y en WISE 0855 |
| CDS (Sesame, SIMBAD, VizieR) sin responder | Espejo de Sesame en CfA y caché de nombres resueltos |
| CORS de servicios externos | Todo pasa por el backend |
| Alcance excesivo | Las etapas 1 a 3 son el producto; el resto es opcional |

## 7. Stack y convenciones

- Frontend: React + Vite + TypeScript en modo estricto, pnpm, Biome, Husky, dependencias fijadas.
- Textos de interfaz solo vía i18next (español e inglés). Colores solo vía tokens semánticos. Sin emojis. Sin violeta ni púrpura.
- Backend: Python 3.12, FastAPI, gestionado con uv.
- Commits: Conventional Commits, asunto de 72 caracteres o menos.

## 8. Pendiente de decidir

- Hosting (necesita HTTPS para la etapa 4).
- Si conviene leer los archivos desde AWS S3 (SIA2 devuelve la columna `cloud_access`, bucket `nasa-irsa-spherex`) en vez de usar el servicio de recortes. No probado.
