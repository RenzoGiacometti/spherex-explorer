Leé `CLAUDE.md` y `SPEC.md` completos antes de empezar.

Tarea: Etapa 0 de `SPEC.md` (prueba técnica). Todo el código va en `spike/`.

1. Inicializá el repo si hace falta (git, .gitignore ya existe) y creá `spike/` con un proyecto uv (Python 3.12; astropy, astroquery o pyvo, reproject, numpy, matplotlib).
2. Verificá contra IRSA lo marcado [VERIFICAR] en `SPEC.md`: escala de píxel y formato exacto de la URL de recorte. Usá como referencia los tutoriales de https://caltech-ipac.github.io/irsa-tutorials/spherex/ (intro y cutouts).
3. Escribí `spike/field.py` que, dado nombre o RA/Dec y un campo de visión:
   - consulte qué exposiciones de DR1 y QR3 cubren el punto (fecha y detector de cada una);
   - descargue los recortes en paralelo con reintentos y caché en disco;
   - reste ZODI, enmascare según FLAGS, reproyecte a una grilla común;
   - agrupe por época (separación mayor a 60 días) y detector, y haga el coadd ponderado por inversa de la varianza;
   - guarde un PNG por (época, detector) y un JSON con: cantidad de exposiciones, fechas por época, tiempos de consulta y de descarga, recortes fallidos.
4. Corrélo para Barnard's Star y para WISE 0855, con campo de 0,1 grados.
5. Escribí `spike/RESULTADOS.md` con: tiempos medidos, cantidad de épocas reales, si Barnard se ve desplazarse entre la primera y la última época (medí el centroide), si WISE 0855 es detectable y en qué detector, y cualquier supuesto de `SPEC.md` que haya resultado falso.
6. Actualizá `SPEC.md` con lo verificado y quitá las marcas [VERIFICAR] resueltas.

No construyas backend ni frontend todavía. Si IRSA no responde o un paso no se puede verificar, decilo en `RESULTADOS.md` en vez de asumir.
