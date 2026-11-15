"""Genera los datos de constelaciones de la esfera (assets/constelaciones/).

Uso, desde la raiz del repositorio, con una carpeta que tenga los tres archivos
de origen (de donde sale cada uno esta en assets/FUENTES.md):

    uv run --no-project python frontend/src/features/sphere/assets/generar_constelaciones.py <carpeta>

Archivos de origen:

- constellation_data_roman87.dat  tabla de limites de Roman (1987), la copia
                                  que distribuye astropy
- constellations.json             nombres y posicion del nombre (d3-celestial)
- constellations.lines.json       lineas de las figuras (d3-celestial)
- stars.6.json                    estrellas hasta magnitud 6 (d3-celestial)
- starnames.json                  nombres de las estrellas (d3-celestial)

Escribe:

- limites.json  la tabla de Roman tal cual: [RA minima (horas), RA maxima
                (horas), Dec minima (grados), abreviatura], en el orden de la
                tabla, que es parte del metodo (equinoccio B1875).
- nombres.json  por abreviatura de la IAU, el nombre en latin, espanol e ingles.
- lineas.json   por figura, donde va el nombre y los tramos de la figura, con
                la ascension recta en grados de 0 a 360 (ICRS/J2000). Serpens
                son dos figuras (Ser1 y Ser2) con el mismo nombre.
- estrellas.json  las 200 estrellas mas brillantes que tienen nombre propio:
                [nombre, RA, Dec, magnitud], de la mas brillante a la mas debil.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "constelaciones"

# Decimales de las coordenadas de las figuras: 0,001 grados son 3,6 segundos de arco.
DECIMALS = 3

# Estrellas con nombre propio que se guardan, de la mas brillante a la mas debil.
STAR_COUNT = 200

# Correcciones propias a los nombres de d3-celestial, que salen de Wikipedia.
# Solo lo que esta mal: "Baston" no es Octans, "Conejo" no es una liebre, el
# Carro ("Big Dipper", "Little Dipper") es una parte de cada Osa y no la
# constelacion, y "Poop Deck" y "Cross" no son los nombres en ingles de la IAU
# (https://www.iau.org/public/themes/constellations/). En espanol, Can Mayor,
# Can Menor y Cabellera de Berenice son los nombres de uso corriente.
NAME_FIXES: dict[str, dict[str, str]] = {
    "Oct": {"es": "Octante"},
    "Lep": {"es": "Liebre"},
    "CMa": {"es": "Can Mayor"},
    "CMi": {"es": "Can Menor"},
    "Com": {"es": "Cabellera de Berenice"},
    "UMa": {"en": "Great Bear"},
    "UMi": {"en": "Little Bear"},
    "Cru": {"en": "Southern Cross"},
    "Pup": {"en": "Stern"},
    # Las dos mitades (Serpens Caput y Serpens Cauda) son una sola constelacion.
    "Ser": {"la": "Serpens"},
}


def clean(text: str) -> str:
    """d3-celestial separa las palabras con U+2005; aca van espacios comunes."""
    return " ".join(text.replace(" ", " ").split())


def separation(a: list[float], b: list[float]) -> float:
    """Distancia angular aproximada, en grados, para elegir la etiqueta mas cercana."""
    delta = (a[0] - b[0] + 180.0) % 360.0 - 180.0
    return math.hypot(delta * math.cos(math.radians((a[1] + b[1]) / 2)), a[1] - b[1])


def write_json(name: str, data: object) -> None:
    path = OUTPUT_DIR / name
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # Saltos de linea de Unix tambien en Windows.
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"{name}: {path.stat().st_size} bytes")


def ra_degrees(longitude: float) -> float:
    """d3-celestial escribe la ascension recta como longitud de -180 a 180."""
    return round(longitude % 360.0, DECIMALS)


def read_bounds(source: Path) -> list[list]:
    rows = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        ra_low, ra_up, dec_low, abbr = line.split()
        rows.append([float(ra_low), float(ra_up), float(dec_low), abbr])
    if len(rows) != 357:
        raise SystemExit(f"la tabla de Roman tiene 357 renglones, se leyeron {len(rows)}")
    return rows


def read_stars(sources: Path) -> list[list]:
    """Las estrellas mas brillantes con nombre propio: [nombre, RA, Dec, magnitud]."""
    stars = json.loads((sources / "stars.6.json").read_text(encoding="utf-8"))["features"]
    star_names = json.loads((sources / "starnames.json").read_text(encoding="utf-8"))
    named = []
    for star in stars:
        name = clean(star_names.get(str(star["id"]), {}).get("name", ""))
        if not name:
            continue
        longitude, latitude = star["geometry"]["coordinates"]
        named.append(
            [name, ra_degrees(longitude), round(latitude, DECIMALS), star["properties"]["mag"]]
        )
    named.sort(key=lambda row: (row[3], row[0]))
    if len(named) < STAR_COUNT:
        raise SystemExit(f"solo hay {len(named)} estrellas con nombre propio")
    return named[:STAR_COUNT]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    sources = Path(sys.argv[1])
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    bounds = read_bounds(sources / "constellation_data_roman87.dat")
    in_bounds = {row[3] for row in bounds}

    names_source = json.loads((sources / "constellations.json").read_text(encoding="utf-8"))
    names: dict[str, dict[str, str]] = {}
    # Serpens trae dos posiciones para el nombre, una por mitad.
    labels: dict[str, list[list[float]]] = {}
    for feature in names_source["features"]:
        properties = feature["properties"]
        abbr = feature["id"]
        for key in ("name", "es", "en"):
            if not properties.get(key):
                raise SystemExit(f"{abbr}: falta el nombre '{key}'")
        names[abbr] = {
            "la": clean(properties["name"]),
            "es": clean(properties["es"]),
            "en": clean(properties["en"]),
            **NAME_FIXES.get(abbr, {}),
        }
        longitude, latitude = feature["geometry"]["coordinates"]
        labels.setdefault(abbr, []).append([ra_degrees(longitude), round(latitude, DECIMALS)])
    if len(names) != 88:
        raise SystemExit(f"se esperaban 88 constelaciones con nombre, hay {len(names)}")
    if set(names) != in_bounds:
        raise SystemExit(f"abreviaturas distintas en las dos fuentes: {set(names) ^ in_bounds}")

    lines_source = json.loads((sources / "constellations.lines.json").read_text(encoding="utf-8"))
    figures = []
    points = 0
    seen: dict[str, int] = {}
    for feature in sorted(lines_source["features"], key=lambda item: item["id"]):
        abbr = feature["id"]
        if feature["geometry"]["type"] != "MultiLineString":
            raise SystemExit(f"{abbr}: geometria {feature['geometry']['type']}")
        if abbr not in labels:
            raise SystemExit(f"{abbr}: figura sin posicion para el nombre")
        seen[abbr] = seen.get(abbr, 0) + 1
        # El nombre va en la posicion mas cercana al primer punto de la figura.
        first = feature["geometry"]["coordinates"][0][0]
        start = [ra_degrees(first[0]), first[1]]
        label = min(labels[abbr], key=lambda position: separation(position, start))
        segments = []
        for segment in feature["geometry"]["coordinates"]:
            flat: list[float] = []
            for longitude, latitude in segment:
                flat += [ra_degrees(longitude), round(latitude, DECIMALS)]
            points += len(segment)
            segments.append(flat)
        figures.append(
            {
                # Unico por figura: Ser y Ser-2 son las dos mitades de Serpens.
                "id": abbr if seen[abbr] == 1 else f"{abbr}-{seen[abbr]}",
                "abbr": abbr,
                "label": label,
                "lines": segments,
            }
        )
    if {figure["abbr"] for figure in figures} != set(names):
        raise SystemExit("hay constelaciones sin figura")

    write_json("limites.json", bounds)
    write_json("nombres.json", dict(sorted(names.items())))
    write_json("lineas.json", figures)
    stars = read_stars(sources)
    write_json("estrellas.json", stars)
    print(f"{len(bounds)} limites, {len(names)} nombres, {len(figures)} figuras, {points} puntos")
    print(f"{len(stars)} estrellas, de {stars[0][0]} ({stars[0][3]}) a {stars[-1][0]} ({stars[-1][3]})")


if __name__ == "__main__":
    main()
