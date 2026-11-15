"""Estado del TAP de IRSA para SPHEREx: repite la consulta del tutorial oficial.

Etapa 0. Sirve para saber si TAP volvio a ser una via practica para listar
exposiciones. La consulta es la del tutorial de cutouts (M101, detector 2), que
alli tarda unos 20 s:
https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/

Uso: uv run python check_tap.py [ra dec]
"""

from __future__ import annotations

import sys
import time

import requests

TAP = "https://irsa.ipac.caltech.edu/TAP"


def sync(label: str, adql: str, timeout: float) -> None:
    for attempt in range(1, 6):
        t0 = time.perf_counter()
        try:
            resp = requests.post(f"{TAP}/sync", data={"QUERY": adql, "FORMAT": "CSV"}, timeout=(15, timeout))
        except requests.RequestException as exc:
            print(f"[{label}] intento {attempt}: {type(exc).__name__} a los {time.perf_counter() - t0:.0f} s", flush=True)
            return
        dt = time.perf_counter() - t0
        rows = max(len(resp.text.splitlines()) - 1, 0)
        print(f"[{label}] intento {attempt}: HTTP {resp.status_code} en {dt:.1f} s, {rows} filas", flush=True)
        # Un 502 inmediato del proxy es transitorio; uno lento es un timeout del servidor.
        if resp.status_code not in (502, 503, 504) or dt > 30:
            return
        time.sleep(3 * attempt)


def async_trivial(wait: float) -> None:
    resp = requests.post(
        f"{TAP}/async",
        data={"QUERY": "SELECT TOP 1 table_name FROM TAP_SCHEMA.tables", "FORMAT": "CSV", "PHASE": "RUN"},
        timeout=(15, 60),
        allow_redirects=False,
    )
    job = resp.headers.get("Location", "").replace("http://", "https://", 1)
    print(f"[async] crear: HTTP {resp.status_code}, trabajo {job or 'no creado'}", flush=True)
    if not job:
        return
    t0 = time.perf_counter()
    phase = "?"
    while time.perf_counter() - t0 < wait:
        try:
            answer = requests.get(f"{job}/phase", timeout=(15, 30))
        except requests.RequestException:
            time.sleep(5)
            continue
        if answer.status_code == 200:
            phase = answer.text.strip()
            if phase in ("COMPLETED", "ERROR", "ABORTED", "ABORT"):
                break
        time.sleep(5)
    print(f"[async] fase {phase} a los {time.perf_counter() - t0:.0f} s", flush=True)
    if phase not in ("COMPLETED", "ERROR", "ABORTED", "ABORT"):
        requests.post(f"{job}/phase", data={"PHASE": "ABORT"}, timeout=(15, 30), allow_redirects=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ra, dec = (float(sys.argv[1]), float(sys.argv[2])) if len(sys.argv) > 2 else (210.80227, 54.34895)
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    sync("sync trivial", "SELECT TOP 1 table_name FROM TAP_SCHEMA.tables", 60)
    sync(
        "sync tutorial (D2)",
        f"""SELECT a.uri, p.time_bounds_lower FROM spherex.artifact a
            JOIN spherex.plane p ON a.planeid = p.planeid
            WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
              AND p.energy_bandpassname = 'SPHEREx-D2'
            ORDER BY p.time_bounds_lower""",
        310,
    )
    async_trivial(90)
