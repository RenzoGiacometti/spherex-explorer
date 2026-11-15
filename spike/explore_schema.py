"""Exploracion del esquema TAP de IRSA para SPHEREx (Etapa 0, descartable).

Fuente: TAP_SCHEMA de https://irsa.ipac.caltech.edu/TAP. No se asume ningun
nombre de tabla o columna: se listan los que el servicio declara.
"""

from __future__ import annotations

import sys
import time

import pyvo

TAP_URL = "https://irsa.ipac.caltech.edu/TAP"


def run(service: pyvo.dal.TAPService, adql: str):
    t0 = time.perf_counter()
    table = service.run_sync(adql).to_table()
    print(f"-- {time.perf_counter() - t0:.1f} s, {len(table)} filas", flush=True)
    return table


def main() -> None:
    service = pyvo.dal.TAPService(TAP_URL)

    print("== Tablas del esquema spherex ==")
    tables = run(
        service,
        "SELECT table_name, description FROM TAP_SCHEMA.tables "
        "WHERE schema_name = 'spherex' ORDER BY table_name",
    )
    for row in tables:
        print(f"{row['table_name']}: {row['description']}")

    for name in [str(n) for n in tables["table_name"]]:
        print(f"\n== Columnas de {name} ==")
        cols = run(
            service,
            "SELECT column_name, datatype, unit, description FROM TAP_SCHEMA.columns "
            f"WHERE table_name = '{name}' ORDER BY column_index",
        )
        for row in cols:
            print(f"  {row['column_name']} [{row['datatype']}, {row['unit']}]: {row['description']}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
