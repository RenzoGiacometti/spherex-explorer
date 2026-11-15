"""Contexto de otras misiones para un campo (Etapa 3): 2MASS, WISE y Gaia DR3.

Todo sale de IRSA y se precalcula con `scripts/precompute_context.py`; el
backend solo sirve lo guardado en `data/context`. Que servicio funciona, con su
URL exacta, esta en docs/contexto.md.

Modulos:

- `surveys`    que imagenes de 2MASS y de WISE cubren un campo (SIA2) y su
               recorte por coordenadas, con cache en disco.
- `reproject`  de un recorte de otra mision a la grilla del campo.
- `gaia`       fuentes de Gaia DR3 de un cono, por Gator.
- `store`      formato en disco y documento de contexto.
- `build`      arma el contexto de un campo con las piezas anteriores.
- `api`        rutas de solo lectura (`/api/context`, `/api/survey`).
- `devapp`     aplicacion minima para la pagina de prueba del frontend.
"""
