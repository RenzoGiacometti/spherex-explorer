"""Interpretacion de un texto como coordenadas (contrato, seccion 4.8).

`GET /api/resolve?name=` acepta un nombre o unas coordenadas; si el texto son
coordenadas no se consulta Sesame.

Solo expresiones regulares y aritmetica: no usa astropy ni la red. Lo usan el
backend real y el servidor falso (`app.fake`).
"""

from __future__ import annotations

import re

from app.api.errors import invalid_request

_NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
_UNSIGNED = r"(?:\d+(?:\.\d*)?|\.\d+)"
# Separador entre RA y Dec: espacios, o una coma con espacios opcionales.
_GAP = r"(?:\s*,\s*|\s+)"

# Dos numeros en grados: `269.4463 4.7683`, `269.4463, +4.7683`.
_DECIMAL = re.compile(rf"^({_NUMBER}){_GAP}({_NUMBER})$")
# Coma decimal: una coma pegada a un digito de cada lado (`269,4463`).
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d)")
# Signo menos tipografico (U+2212), que algunos teclados y paginas ponen en vez del guion.
_MINUS_SIGN = chr(0x2212)

# RA en horas y Dec en grados, con letras: `08h55m10.831s -07d14m42.53s`.
# Para Dec se aceptan tambien los signos de grado (U+00B0), minuto (apostrofo o
# U+2032) y segundo de arco (comillas o U+2033). Van como escapes de `re`.
_DEGREE_SIGN = r"[d\u00b0]"
_ARCMIN_SIGN = r"[m'\u2032]"
_ARCSEC_SIGN = r"(?:s|\x22|\u2033)"
_LETTERS = re.compile(
    rf"^(\d{{1,2}})\s*h\s*(\d{{1,2}})\s*m\s*({_UNSIGNED})\s*s?"
    rf"{_GAP}"
    rf"([+-]?)(\d{{1,2}})\s*{_DEGREE_SIGN}\s*(\d{{1,2}})\s*{_ARCMIN_SIGN}\s*({_UNSIGNED})\s*{_ARCSEC_SIGN}?$",
    re.IGNORECASE,
)

# Con dos puntos (`08:55:10.83 -07:14:42.5`) o con espacios (`08 55 10.83 -07 14 42.5`).
_COLONS = re.compile(rf"^(\d{{1,2}}):(\d{{1,2}}):({_UNSIGNED}){_GAP}([+-]?)(\d{{1,2}}):(\d{{1,2}}):({_UNSIGNED})$")
_SPACES = re.compile(
    rf"^(\d{{1,2}})\s+(\d{{1,2}})\s+({_UNSIGNED}){_GAP}([+-]?)(\d{{1,2}})\s+(\d{{1,2}})\s+({_UNSIGNED})$"
)


def parse_coordinates(text: str) -> tuple[float, float] | None:
    """Si el texto son coordenadas, devuelve `(ra, dec)` en grados ICRS; si no, `None`.

    Formatos que reconoce:
    - Grados decimales: `269.4463 4.7683`, `269.4463, +4.7683`, `133.7598 -7.2422`.
    - Sexagesimal, con RA en horas: `08h55m10.831s -07d14m42.53s`,
      `08:55:10.83 -07:14:42.5`, `08 55 10.83 -07 14 42.5`.

    Los decimales pueden venir con coma (`269,4463 +4,7683`,
    `08h55m10,831s -07d14m42,53s`) y el signo menos puede ser el tipografico
    (U+2212). Una coma entre dos numeros con punto sigue siendo el separador
    (`269.4463,4.7683`); `10,20` tambien se lee como dos valores.

    `ra` queda en [0, 360). Si el texto tiene forma de coordenadas pero esta
    fuera de rango (`dec` mayor que 90, `ra` de 400 grados o de 25 horas), lanza
    `ApiError` `invalid_request` en vez de devolver `None`, para no mandarlo a
    Sesame: `ra` no se envuelve.
    """
    cleaned = text.strip().replace(_MINUS_SIGN, "-")
    if not cleaned:
        return None
    found = _parse(cleaned)
    if found is None and "," in cleaned:
        # Coma decimal: solo si con la coma como separador no era una coordenada. Las comas
        # entre dos digitos pasan a punto; la que separa RA de Dec, si la hay, queda.
        found = _parse(_DECIMAL_COMMA.sub(".", cleaned))
    return found


def _parse(cleaned: str) -> tuple[float, float] | None:
    match = _DECIMAL.match(cleaned)
    if match:
        ra, dec = float(match.group(1)), float(match.group(2))
        _check_dec(dec)
        return _check_ra(ra), dec

    for pattern in (_LETTERS, _COLONS, _SPACES):
        match = pattern.match(cleaned)
        if match:
            hours, ra_minutes, ra_seconds = int(match.group(1)), int(match.group(2)), float(match.group(3))
            sign = -1.0 if match.group(4) == "-" else 1.0
            degrees, dec_minutes, dec_seconds = int(match.group(5)), int(match.group(6)), float(match.group(7))
            if hours >= 24:
                raise invalid_request(f"ra con {hours} horas fuera de rango: se admite de 0 a 24 horas")
            for name, value in (("ra", ra_minutes), ("ra", ra_seconds), ("dec", dec_minutes), ("dec", dec_seconds)):
                if value >= 60:
                    raise invalid_request(f"{name} fuera de rango: los minutos y los segundos van de 0 a 60")
            ra = 15.0 * (hours + ra_minutes / 60.0 + ra_seconds / 3600.0)
            dec = sign * (degrees + dec_minutes / 60.0 + dec_seconds / 3600.0)
            _check_dec(dec)
            return _wrap_ra(ra), dec
    return None


def _check_dec(dec: float) -> None:
    if not -90.0 <= dec <= 90.0:
        raise invalid_request(f"dec={dec!r} fuera de rango: se admite de -90 a 90 grados")


def _check_ra(ra: float) -> float:
    """`ra` en grados decimales tiene que estar en [0, 360): fuera de eso es un error, no se envuelve."""
    if not 0.0 <= ra < 360.0:
        raise invalid_request(f"ra={ra!r} fuera de rango: se admite de 0 a 360 grados")
    return ra + 0.0  # `-0.0` pasa a `0.0`


def _wrap_ra(ra: float) -> float:
    """`ra` sexagesimal, ya con horas, minutos y segundos en rango: 360.0 por redondeo se lleva a 0."""
    wrapped = ra % 360.0
    return 0.0 if wrapped >= 360.0 else wrapped
