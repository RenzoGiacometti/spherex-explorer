"""Resolucion de nombres con Sesame (CDS), con espejo en CfA.

Referencia probada contra el servicio: `resolve_name` en spike/field.py (salida
XML `-ox`, elementos `jradeg`, `jdedeg`, `pm/pmRA`, `pm/pmDE`, `plx/v`, `Vel/v`
y `oname` dentro de `Target/Resolver`). No inventar otros elementos: los que
hagan falta se confirman contra una respuesta guardada.

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from app.config import Settings
from app.domain import ResolvedTarget

# Sesame en CDS y su espejo en CfA, salida XML (las mismas URL que usa el spike).
SESAME_URLS: tuple[str, ...] = (
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/S?",
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/S?",
)


def parse_sesame(text: str, query: str) -> ResolvedTarget | None:
    """Interpreta la respuesta XML de Sesame.

    Devuelve la posicion ICRS en la epoca J2000.0, el nombre principal, el tipo
    de objeto y, si el catalogo los trae, movimiento propio, paralaje y
    velocidad radial (`None` los que falten). Devuelve `None` si la respuesta
    no trae posicion, es decir, si Sesame no conoce el nombre.
    """
    raise NotImplementedError


def resolve_name(name: str, settings: Settings) -> ResolvedTarget:
    """Resuelve un nombre de objeto.

    - Busca primero en la cache de disco (`settings.sesame_cache_dir`, clave: el
      texto buscado, vigencia `settings.resolve_cache_days`).
    - Si no esta, consulta Sesame en CDS y, si no responde, el espejo de CfA,
      con timeout y reintentos. Guarda la respuesta.
    - Lanza `ApiError` `not_resolved` si Sesame no conoce el nombre, y
      `upstream_unavailable` si ningun servidor responde y no hay copia en cache.
    """
    raise NotImplementedError
