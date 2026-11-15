"""Mide donde se va el tiempo de un recorte: espera del servidor o transferencia.

Etapa 0, descartable. Tambien prueba si el servicio de recortes respeta la
cabecera HTTP estandar `Range` y si comprime la respuesta.
"""

from __future__ import annotations

import sys
import time

import requests

BASE = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W21_2C/l2b-v27-2026-199/2/"
    "level2_2025W21_2C_0401_1D2_spx_l2b-v27-2026-199.fits"
)
CUTOUT = BASE + "?center=210.80227,54.34895d&size=0.1"


def timed_get(label: str, url: str, headers: dict[str, str] | None = None, stop_after: int | None = None) -> None:
    t0 = time.perf_counter()
    try:
        with requests.get(url, headers=headers, stream=True, timeout=(15, 120)) as resp:
            ttfb = time.perf_counter() - t0
            total = 0
            marks: list[tuple[int, float]] = []
            for chunk in resp.raw.stream(65536, decode_content=False):
                total += len(chunk)
                marks.append((total, time.perf_counter() - t0))
                if stop_after is not None and total >= stop_after:
                    break
            dt = time.perf_counter() - t0
            interesting = {
                k: v
                for k, v in resp.headers.items()
                if k.lower() in {"content-length", "content-encoding", "content-range", "accept-ranges", "content-type", "transfer-encoding", "content-disposition"}
            }
            print(f"[{label}] HTTP {resp.status_code}; primer byte a {ttfb:.2f} s; {total / 1e3:.0f} kB en {dt:.2f} s")
            print(f"    cabeceras: {interesting}")
            first_200k = next((t for n, t in marks if n >= 200_000), None)
            if first_200k is not None:
                print(f"    primeros 200 kB a los {first_200k:.2f} s")
            if dt > ttfb and total:
                print(f"    velocidad de transferencia: {total / 1e6 / max(dt - ttfb, 1e-6):.2f} MB/s")
    except requests.RequestException as exc:
        print(f"[{label}] ERROR en {time.perf_counter() - t0:.1f} s: {type(exc).__name__}: {exc}")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    timed_get("recorte completo, sin compresion", CUTOUT, {"Accept-Encoding": "identity"})
    timed_get("recorte completo, gzip", CUTOUT, {"Accept-Encoding": "gzip"})
    timed_get("recorte, Range 0-199999", CUTOUT, {"Accept-Encoding": "identity", "Range": "bytes=0-199999"})
    timed_get("recorte, cortando a los 200 kB", CUTOUT, {"Accept-Encoding": "identity"}, stop_after=200_000)
    timed_get("archivo completo, Range 0-199999", BASE, {"Accept-Encoding": "identity", "Range": "bytes=0-199999"})
    timed_get("archivo completo, primeros 8 MB", BASE, {"Accept-Encoding": "identity"}, stop_after=8_000_000)
