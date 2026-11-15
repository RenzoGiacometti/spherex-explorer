"""Curva de luz de un punto del cielo: `GET /api/lightcurve`.

Brillo contra fecha, por banda, a partir de las mismas medidas por exposicion
que el espectro (`app.spectrum`). Como cada exposicion ve otra longitud de onda,
la curva es de variacion relativa: cada medida se compara con las de su mismo
canal espectral.

    wings.py        fotometria sobre las alas, para fuentes saturadas
    normalize.py    normalizacion por canal y curva relativa (pulido de medianas)
    exposures.py    lee los recortes y mide cada exposicion (apertura y alas)
    calibration.py  error real de cada metodo, medido sobre estrellas que no varian
    service.py      de las medidas al documento de la curva
    lookup.py       precalculado o medido sobre los recortes en cache
    saved.py        curvas guardadas por campo precalculado
    router.py       ruta de FastAPI

La ruta esta sumada a la aplicacion real (`app/api/main.py`):

    uv run uvicorn app.api.main:app --port 8000
"""
