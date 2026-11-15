"""Espectro de un punto del cielo (Etapa 2): `GET /api/spectrum`.

Fotometria de apertura sobre cada exposicion individual de SPHEREx, con los
recortes que ya estan en la cache. Cada exposicion ve el objeto a otra longitud
de onda, asi que cada una aporta un punto del espectro.

    photometry.py   apertura, anillo de fondo y error (numpy puro)
    wavelength.py   longitud de onda del pixel a partir de la tabla WCS-WAVE
    cutouts.py      que recortes de la cache cubren un punto
    service.py      de (ra, dec) al documento del espectro
    precomputed.py  espectros de los objetos de prueba, guardados en data/spectra
    router.py       ruta de FastAPI
    server.py       aplicacion suelta para probar el modulo sin el resto del backend

Para sumarlo al backend: `app.include_router(spectrum_router)` en
`app/api/main.py`. Mientras tanto se puede correr solo:

    uv run uvicorn app.spectrum.server:app --port 8002
"""
