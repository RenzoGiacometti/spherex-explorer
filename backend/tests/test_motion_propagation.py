"""Propagacion por movimiento propio y paralaje, centro del campo y trayectoria (contrato, secciones 4.8 y 4.9).

Sin red ni descargas: conftest desactiva las tablas IERS, y la posicion de la
Tierra sale de la efemeride incluida en astropy. Los objetos son las respuestas
de Sesame guardadas; las trayectorias de referencia, las de las tres muestras
(tests/fixtures/fields), que salieron de la propagacion del spike.
"""

from __future__ import annotations

import json
import math
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import astropy.units as u
import pytest
from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
from astropy.time import Time
from erfa import ErfaWarning

from app import geometry
from app.config import FIELD_EPOCH
from app.contract import FieldMeta, TrackResponse
from app.domain import EpochSummary, Grid, ResolvedTarget
from app.resolve import motion
from app.resolve.sesame import parse_sesame

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIELDS_DIR = FIXTURES / "fields"

MJD_J2000 = 51544.5
MJD_2026 = MJD_J2000 + 26 * 365.25


def load_target(folder: str, filename: str, query: str) -> ResolvedTarget:
    target = parse_sesame((FIXTURES / folder / filename).read_text(encoding="utf-8"), query)
    assert target is not None
    return target


@pytest.fixture(scope="module")
def barnard() -> ResolvedTarget:
    return load_target("sesame", "barnard_s_star.xml", "Barnard's Star")


@pytest.fixture(scope="module")
def wise0855() -> ResolvedTarget:
    return load_target("sesame", "wise_j085510_83_071442_5.xml", "WISE J085510.83-071442.5")


@pytest.fixture(scope="module")
def eps_ind_b() -> ResolvedTarget:
    return load_target("sesame", "epsilon_indi_b.xml", "Epsilon Indi B")


def separation_arcsec(a: tuple[float, float], b: tuple[float, float]) -> float:
    return geometry.angular_separation_deg(a[0], a[1], b[0], b[1]) * 3600.0


def summary(epoch: int, mjd: float) -> EpochSummary:
    return EpochSummary(epoch=epoch, mjd_start=mjd - 1.0, mjd_end=mjd + 1.0, mjd_mean=mjd, n_exposures=10)


# ------------------------------------------------------------ centro del campo


def test_barnard_field_center_is_the_contract_example(barnard: ResolvedTarget) -> None:
    """Seccion 4.8: centro (269.4463, 4.7683) en 2026.0, a 270.4" de la posicion J2000 y 10.39"/anio."""
    ra, dec = motion.field_center(barnard)
    assert (round(ra, 4), round(dec, 4)) == (269.4463, 4.7683)
    assert round(motion.moved_arcsec(barnard), 1) == 270.4
    assert round(motion.per_year_arcsec(barnard), 2) == 10.39
    assert isinstance(ra, float) and isinstance(dec, float)


def test_wise0855_field_center(wise0855: ResolvedTarget) -> None:
    """SPEC.md, seccion 1: en la epoca 2026.0 esta en RA 133.7598, Dec -7.2422."""
    ra, dec = motion.field_center(wise0855, FIELD_EPOCH)
    assert (round(ra, 4), round(dec, 4)) == (133.7598, -7.2422)
    # 26 anios a 8.15"/anio, menos lo que pone la paralaje.
    assert motion.moved_arcsec(wise0855) == pytest.approx(26 * 8.1515, abs=0.6)


def test_missing_radial_velocity_is_propagated_as_zero(eps_ind_b: ResolvedTarget) -> None:
    """Epsilon Indi B no tiene velocidad radial en el catalogo: se propaga igual, con 0 km/s."""
    assert eps_ind_b.radial_velocity is None
    assert motion.field_center(eps_ind_b) == motion.field_center(replace(eps_ind_b, radial_velocity=0.0))
    assert motion.moved_arcsec(eps_ind_b) == pytest.approx(26 * 4.684, abs=0.5)


def test_field_center_is_position_at_the_fixed_epoch(barnard: ResolvedTarget) -> None:
    center = motion.field_center(barnard, 2026.0)
    # 2026.0 en anios julianos es el MJD 61041.0 (en TT; la diferencia con UTC no mueve nada).
    assert separation_arcsec(center, motion.position_at(barnard, MJD_2026)) < 1e-3
    # Otra epoca da otro centro: un anio despues, 10.4" mas alla.
    assert separation_arcsec(center, motion.field_center(barnard, 2027.0)) == pytest.approx(10.39, abs=0.05)


# ------------------------------------------------------------------ propagacion


def test_object_without_motion_stays_at_its_catalog_position() -> None:
    target = ResolvedTarget(query="10 20", ra=10.0, dec=20.0)
    assert motion.position_at(target, 61000.0) == (10.0, 20.0)
    assert motion.field_center(target) == (10.0, 20.0)
    assert motion.moved_arcsec(target) == 0.0 and motion.per_year_arcsec(target) == 0.0

    cluster = load_target("sesame_extra", "abell_2218.xml", "Abell 2218")
    assert motion.field_center(cluster) == (cluster.ra, cluster.dec)
    assert motion.moved_arcsec(cluster) == 0.0


def test_parallax_alone_does_not_move_the_field_center() -> None:
    """Contrato, seccion 4.8: sin movimiento propio el centro del campo coincide con `j2000`.

    La paralaje sola si mueve la posicion aparente de una fecha, pero no el
    centro del campo ni la cuenta de cuanto se aparto el objeto.
    """
    for pm in (None, 0.0):
        target = ResolvedTarget(query="x", ra=10.0, dec=20.0, source="sesame", pm_ra=pm, pm_dec=pm, parallax=300.0)
        assert not target.has_proper_motion
        assert motion.field_center(target) == (10.0, 20.0) and motion.moved_arcsec(target) == 0.0
        assert 0.0 < separation_arcsec(motion.position_at(target, 61000.0), (10.0, 20.0)) < 0.31


def test_proper_motion_is_linear_without_parallax() -> None:
    """Solo movimiento propio: `pm_ra` incluye cos(dec) y se avanza en linea recta sobre el cielo."""
    target = ResolvedTarget(query="x", ra=150.0, dec=60.0, source="sesame", pm_ra=1000.0, pm_dec=-500.0)
    ra, dec = motion.position_at(target, MJD_J2000 + 10 * 365.25)
    assert (dec - 60.0) * 3600.0 == pytest.approx(-5.0, abs=1e-3)
    assert (ra - 150.0) * 3600.0 * math.cos(math.radians(60.0)) == pytest.approx(10.0, abs=2e-3)
    assert motion.per_year_arcsec(target) == pytest.approx(math.hypot(1.0, 0.5))


def test_proper_motion_without_parallax_does_not_warn() -> None:
    """M 87: `pm` sin `plx`. ERFA avisa que propaga con una distancia enorme; ese aviso no sale de aca."""
    m87 = load_target("sesame_extra", "m_87.xml", "M 87")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        center = motion.field_center(m87)
        moved = motion.moved_arcsec(m87)
    # 13.4 mas/anio durante 26 anios.
    assert moved == pytest.approx(0.3485, abs=2e-3)
    assert separation_arcsec(center, (m87.ra, m87.dec)) == pytest.approx(moved)


def test_parallax_matches_the_geometry_of_the_earth_orbit() -> None:
    """El desplazamiento paralactico, contra la cuenta vectorial directa: estrella menos Tierra.

    Un objeto casi sin movimiento propio a 2 pc (paralaje de 0.5"), cerca del
    polo de la ecliptica: describe en un anio un circulo de 0.5" de radio.
    """
    target = ResolvedTarget(query="x", ra=270.0, dec=66.0, source="sesame", pm_ra=1e-6, pm_dec=0.0, parallax=500.0)
    distance_au = 206264.80624709636 / 0.5  # 1 / paralaje, en unidades astronomicas
    a, d = math.radians(target.ra), math.radians(target.dec)
    star = [distance_au * math.cos(d) * math.cos(a), distance_au * math.cos(d) * math.sin(a), distance_au * math.sin(d)]

    offsets: list[tuple[float, float]] = []
    for mjd in (61041.0, 61041.0 + 91.3, 61041.0 + 182.6, 61041.0 + 273.9):
        earth = get_body_barycentric("earth", Time(mjd, format="mjd")).xyz.to_value(u.au)
        x, y, z = (star[i] - float(earth[i]) for i in range(3))
        expected = (math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.atan2(z, math.hypot(x, y))))
        got = motion.position_at(target, mjd)
        assert separation_arcsec(got, expected) < 1e-4
        offsets.append(((got[0] - target.ra) * 3600.0 * math.cos(d), (got[1] - target.dec) * 3600.0))

    # Nunca mas que la paralaje (la Tierra esta a 1 UA del baricentro, mas o menos un 2 %)...
    assert all(0.44 < math.hypot(*offset) < 0.52 for offset in offsets)
    # ...y medio anio despues, del lado opuesto.
    for first, second in ((offsets[0], offsets[2]), (offsets[1], offsets[3])):
        assert math.hypot(first[0] + second[0], first[1] + second[1]) < 0.05


def test_radial_velocity_changes_the_propagation(barnard: ResolvedTarget) -> None:
    """Con paralaje, la velocidad radial entra en la cuenta: Barnard se acerca y su movimiento propio crece."""
    without = replace(barnard, radial_velocity=None)
    shift = separation_arcsec(motion.field_center(barnard), motion.field_center(without))
    # Aceleracion de perspectiva de Barnard: 1.2 mas/anio2, 0.4" en 26 anios.
    assert shift == pytest.approx(0.42, abs=0.05)


def test_position_at_the_reference_epoch_is_the_catalog_position_plus_parallax(barnard: ResolvedTarget) -> None:
    assert separation_arcsec(motion.position_at(barnard, MJD_J2000), (barnard.ra, barnard.dec)) < 0.56
    no_parallax = replace(barnard, parallax=None)
    assert separation_arcsec(motion.position_at(no_parallax, MJD_J2000), (barnard.ra, barnard.dec)) < 1e-3


def test_right_ascension_stays_in_range() -> None:
    target = ResolvedTarget(query="x", ra=0.0005, dec=10.0, source="sesame", pm_ra=-3000.0, pm_dec=0.0)
    ra, dec = motion.field_center(target)
    assert 359.9 < ra < 360.0 and dec == pytest.approx(10.0, abs=1e-4)
    back = ResolvedTarget(query="x", ra=359.9995, dec=10.0, source="sesame", pm_ra=3000.0, pm_dec=0.0)
    assert 0.0 <= motion.field_center(back)[0] < 0.1


def spike_position(target: ResolvedTarget, when: Time) -> tuple[float, float]:
    """`Target.position_at` de spike/field.py: `apply_space_motion` de astropy mas el desplazamiento paralactico.

    Es el camino ya probado contra los datos, y la referencia de `motion`, que
    hace la misma cuenta llamando a ERFA directamente.
    """
    parallax = target.parallax if target.parallax is not None and target.parallax > 0 else 0.0
    kwargs: dict[str, object] = {
        "ra": target.ra * u.deg,
        "dec": target.dec * u.deg,
        "pm_ra_cosdec": (target.pm_ra or 0.0) * u.mas / u.yr,
        "pm_dec": (target.pm_dec or 0.0) * u.mas / u.yr,
        "obstime": Time(target.ref_epoch, format="jyear"),
        "frame": "icrs",
    }
    if parallax > 0:
        kwargs["distance"] = Distance(parallax=parallax * u.mas)
        kwargs["radial_velocity"] = (target.radial_velocity or 0.0) * u.km / u.s
    with warnings.catch_warnings():  # un solo hilo: aca si se puede
        warnings.simplefilter("ignore", ErfaWarning)
        moved = SkyCoord(**kwargs).apply_space_motion(new_obstime=when)
    ra, dec = float(moved.ra.deg), float(moved.dec.deg)
    if parallax > 0:
        x, y, z = get_body_barycentric("earth", when).xyz.to_value(u.au)
        a, d = math.radians(ra), math.radians(dec)
        east = parallax * (x * math.sin(a) - y * math.cos(a))
        north = parallax * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))
        ra += float(east) / 3.6e6 / math.cos(d)
        dec += float(north) / 3.6e6
    return ra % 360.0, dec


def moving_targets() -> list[ResolvedTarget]:
    """Los objetos guardados que se mueven y otros armados para cubrir cada combinacion de datos de catalogo."""
    saved = [
        load_target("sesame", "barnard_s_star.xml", "Barnard's Star"),
        load_target("sesame", "epsilon_indi_b.xml", "Epsilon Indi B"),
        load_target("sesame", "wise_j085510_83_071442_5.xml", "WISE J085510.83-071442.5"),
        load_target("sesame", "r_draconis.xml", "R Draconis"),
        load_target("sesame", "rw_aurigae.xml", "RW Aurigae"),
        load_target("sesame_extra", "m_87.xml", "M 87"),  # movimiento propio sin paralaje
    ]

    def made(ra: float, dec: float, **catalog: float | None) -> ResolvedTarget:
        return ResolvedTarget(query="armado", ra=ra, dec=dec, source="sesame", **catalog)

    return [
        *saved,
        made(150.0, 60.0, pm_ra=1000.0, pm_dec=-500.0),
        made(0.0005, 10.0, pm_ra=-3000.0, pm_dec=0.0),  # cruza el meridiano de RA 0
        made(40.0, 89.99, pm_ra=9000.0, pm_dec=4000.0, parallax=300.0, radial_velocity=-90.0),  # junto al polo
        made(200.0, -89.999, pm_ra=-50.0, pm_dec=80.0),
        made(10.0, 20.0, pm_ra=None, pm_dec=7000.0, parallax=250.0),  # con paralaje y sin velocidad radial
        made(10.0, 20.0, pm_ra=5000.0, pm_dec=None, parallax=-3.0, radial_velocity=40.0),  # paralaje negativa: sin uso
        made(10.0, 20.0, pm_ra=5000.0, pm_dec=10.0, parallax=1e-4),  # paralaje minima: ERFA la reemplaza
        made(300.0, -45.0, pm_ra=0.0, pm_dec=0.0, parallax=700.0),  # solo paralaje
    ]


@pytest.mark.parametrize("target", moving_targets(), ids=lambda target: target.query.split()[0])
def test_position_is_the_one_of_astropy_apply_space_motion(target: ResolvedTarget) -> None:
    """`motion` llama a ERFA directamente: tiene que dar lo mismo que el camino de astropy que uso el spike."""
    for mjd in (MJD_J2000, 60902.864715, MJD_2026, 61400.3):
        got = motion.position_at(target, mjd)
        expected = spike_position(target, Time(mjd, format="mjd", scale="utc"))
        assert separation_arcsec(got, expected) < 1e-7, mjd  # 0.1 microsegundos de arco: solo redondeo
    if target.has_proper_motion:
        expected = spike_position(target, Time(FIELD_EPOCH, format="jyear"))
        assert separation_arcsec(motion.field_center(target), expected) < 1e-7


def test_position_at_from_many_threads_leaves_the_warning_filters_alone() -> None:
    """`warnings.catch_warnings` no es seguro entre hilos: usado aca, dejaba un filtro de mas en el proceso."""
    with_parallax = load_target("sesame", "barnard_s_star.xml", "Barnard's Star")
    without_parallax = load_target("sesame_extra", "m_87.xml", "M 87")
    jobs = [(target, 61000.0 + i) for i in range(40) for target in (with_parallax, without_parallax)]
    serial = [motion.position_at(*job) for job in jobs]

    before = list(warnings.filters)
    with ThreadPoolExecutor(max_workers=8) as pool:
        threaded = list(pool.map(lambda job: motion.position_at(*job), jobs * 5))
    assert warnings.filters == before
    assert threaded == serial * 5

    # Los avisos del proceso siguen funcionando: uno de ERFA emitido despues se ve.
    with pytest.warns(ErfaWarning, match="de prueba"):
        warnings.warn("de prueba", ErfaWarning, stacklevel=1)


def test_catalog_data_that_erfa_cannot_use_is_logged_not_warned(caplog: pytest.LogCaptureFixture) -> None:
    """Velocidad radial mayor que la mitad de la de la luz: ERFA la descarta y lo dice con el estado, sin excepcion."""
    absurd = ResolvedTarget(
        query="absurdo", ra=10.0, dec=20.0, source="sesame", pm_ra=100.0, pm_dec=50.0, parallax=100.0,
        radial_velocity=200_000.0,
    )  # fmt: skip
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        with caplog.at_level("WARNING", logger="app.resolve.motion"):
            ra, dec = motion.position_at(absurd, MJD_2026)
    assert math.isfinite(ra) and math.isfinite(dec)
    assert [record.levelname for record in caplog.records] == ["WARNING"]
    assert "pmsafe" in caplog.text and "absurdo" in caplog.text
    # Lo normal no deja nada en el log: ni con paralaje ni sin ella.
    caplog.clear()
    with caplog.at_level("WARNING", logger="app.resolve.motion"):
        motion.position_at(replace(absurd, radial_velocity=20.0), MJD_2026)
        motion.position_at(replace(absurd, parallax=None), MJD_2026)
    assert caplog.records == []


# ------------------------------------------------------------------ trayectoria


def load_sample(folder: str) -> tuple[Grid, FieldMeta, TrackResponse]:
    root = FIELDS_DIR / folder
    meta = FieldMeta.model_validate_json((root / "meta.json").read_text(encoding="utf-8"))
    assert meta.grid is not None
    (track_file,) = root.glob("track_*.json")
    saved = TrackResponse.model_validate(json.loads(track_file.read_text(encoding="utf-8")))
    return geometry.grid_from_info(meta.grid), meta, saved


@pytest.mark.parametrize(
    ("folder", "filename", "query"),
    [
        ("4a2e877f8ee4efd2", "barnard_s_star.xml", "Barnard's Star"),
        ("4022da836c5a1505", "wise_j085510_83_071442_5.xml", "WISE J085510.83-071442.5"),
        ("02a1d503e540822b", "epsilon_indi_b.xml", "Epsilon Indi B"),
    ],
)
def test_track_matches_the_one_saved_with_each_sample(folder: str, filename: str, query: str) -> None:
    """Con la fecha de cada punto guardado, la propagacion da el mismo pixel a centesimas."""
    grid, _meta, saved = load_sample(folder)
    target = load_target("sesame", filename, query)
    assert saved.name == target.name and len(saved.positions) >= 3

    points = motion.track(target, [summary(item.epoch, item.mjd) for item in saved.positions], grid)

    assert [point.epoch for point in points] == [item.epoch for item in saved.positions]
    for point, expected in zip(points, saved.positions, strict=True):
        assert point.mjd == expected.mjd
        assert point.x == pytest.approx(expected.x, abs=0.01)
        assert point.y == pytest.approx(expected.y, abs=0.01)
        assert separation_arcsec((point.ra, point.dec), (expected.ra, expected.dec)) < 0.02
        assert point.in_field is expected.in_field is True


def test_track_uses_the_mean_date_of_each_epoch(barnard: ResolvedTarget) -> None:
    grid, meta, saved = load_sample("4a2e877f8ee4efd2")
    assert meta.epochs is not None
    epochs = [
        EpochSummary(
            epoch=item.epoch,
            mjd_start=item.mjd_start,
            mjd_end=item.mjd_end,
            mjd_mean=item.mjd_mean,
            n_exposures=item.n_exposures,
        )
        for item in meta.epochs
    ]
    points = motion.track(barnard, epochs, grid)
    assert [point.mjd for point in points] == [item.mjd_mean for item in meta.epochs]
    for point in points:
        ra, dec = motion.position_at(barnard, point.mjd)
        assert (point.ra, point.dec) == (ra, dec)
        assert (point.x, point.y) == geometry.sky_to_pixel(grid, ra, dec)
    # Las fechas medias del documento difieren en un dia de las de la trayectoria guardada: centesimas de pixel.
    for point, expected in zip(points, saved.positions, strict=True):
        assert math.hypot(point.x - expected.x, point.y - expected.y) < 0.05
    # Barnard sube 10.4" por anio: con 3.075"/px, mas de 3 px entre la primera y la ultima epoca.
    assert points[-1].y - points[0].y == pytest.approx(3.33, abs=0.15)


def test_track_is_empty_without_proper_motion() -> None:
    grid = geometry.make_grid(248.975, 66.2167, 0.1667, 3.075)
    epochs = [summary(1, 60900.0), summary(2, 61100.0)]
    assert motion.track(load_target("sesame_extra", "abell_2218.xml", "Abell 2218"), epochs, grid) == []
    assert motion.track(ResolvedTarget(query="248.975 66.2167", ra=248.975, dec=66.2167), epochs, grid) == []
    # Paralaje sin movimiento propio tampoco da trayectoria: el contrato la define por el movimiento propio.
    only_parallax = ResolvedTarget(query="x", ra=248.975, dec=66.2167, source="sesame", parallax=100.0)
    assert motion.track(only_parallax, epochs, grid) == []
    assert motion.track(load_target("sesame", "barnard_s_star.xml", "Barnard's Star"), [], grid) == []


def test_track_marks_points_outside_the_field(barnard: ResolvedTarget) -> None:
    """Un campo de 6 minutos centrado en la posicion J2000 de Barnard: en 2026 la estrella ya salio por el norte."""
    grid = geometry.make_grid(round(barnard.ra, 4), round(barnard.dec, 4), 0.1, 3.075)
    assert grid.shape == (117, 117)
    (point,) = motion.track(barnard, [summary(1, MJD_2026)], grid)
    assert not point.in_field
    assert point.y == pytest.approx(58.0 + 270.4 / 3.075, abs=1.0)  # 270" al norte del centro
    assert point.y > grid.shape[0]
    # En el escalon base (10 minutos) todavia entra, cerca del borde norte.
    (inside,) = motion.track(
        barnard, [summary(1, MJD_2026)], geometry.make_grid(barnard.ra, barnard.dec, 0.1667, 3.075)
    )
    assert inside.in_field and inside.y == pytest.approx(97.0 + 270.4 / 3.075, abs=1.0)


def test_track_skips_points_the_projection_cannot_represent(barnard: ResolvedTarget) -> None:
    """Un campo del otro lado del cielo: el objeto no tiene pixel en esa grilla (seria NaN, que no entra en JSON)."""
    grid = geometry.make_grid((barnard.ra + 180.0) % 360.0, -barnard.dec, 0.1667, 3.075)
    assert motion.track(barnard, [summary(1, 60900.0), summary(2, 61100.0)], grid) == []
    # A 60 grados, del mismo lado del cielo, el punto sale, lejos y fuera del campo.
    (far,) = motion.track(barnard, [summary(1, 60900.0)], geometry.make_grid(barnard.ra, -55.0, 0.1667, 3.075))
    assert not far.in_field and math.isfinite(far.x) and math.isfinite(far.y)
