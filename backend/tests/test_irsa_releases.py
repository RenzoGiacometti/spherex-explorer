"""Colecciones descubiertas del listado del bucket, contra un servidor local. Sin red."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from test_irsa_support import IrsaStub, respond

from app.config import DEFAULT_COLLECTIONS, Settings
from app.irsa import releases
from app.irsa.releases import active_collections, collections_from_listing

# El listado real del bucket el 15 de noviembre de 2026, sin la entrada de `index.html`.
LISTING = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>nasa-irsa-spherex</Name>'
    b"<Prefix></Prefix><KeyCount>4</KeyCount><MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter>"
    b"<IsTruncated>false</IsTruncated>"
    b"<CommonPrefixes><Prefix>dr1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>qr2/</Prefix></CommonPrefixes>"
    b"<CommonPrefixes><Prefix>qr3/</Prefix></CommonPrefixes></ListBucketResult>"
)


def listing(*folders: str) -> bytes:
    body = "".join(f"<CommonPrefixes><Prefix>{folder}/</Prefix></CommonPrefixes>" for folder in folders)
    return f"<ListBucketResult>{body}</ListBucketResult>".encode()


@pytest.fixture(autouse=True)
def _fresh() -> Iterator[None]:
    releases.reset()
    yield
    releases.reset()


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    try:
        yield server
    finally:
        server.close()


def make_settings(tmp_path: Path, stub: IrsaStub, **changes: object) -> Settings:
    return Settings(cache_dir=tmp_path / "cache", release_list_url=stub.url("/bucket"), **changes)  # type: ignore[arg-type]


def test_real_listing_gives_dr1_and_the_newest_quick_release() -> None:
    assert collections_from_listing(LISTING) == ("spherex_dr1", "spherex_qr3")
    assert collections_from_listing(LISTING) == DEFAULT_COLLECTIONS


def test_every_data_release_newest_first_and_only_the_last_quick_release() -> None:
    names = collections_from_listing(listing("dr1", "dr2", "qr3", "qr4", "qr10", "otra", "level2"))
    assert names == ("spherex_dr2", "spherex_dr1", "spherex_qr10")


def test_deep_collections_follow_each_release() -> None:
    assert collections_from_listing(LISTING, deep=True) == (
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr3",
        "spherex_qr3_deep",
    )


def test_listing_without_releases_gives_nothing() -> None:
    assert collections_from_listing(b"<ListBucketResult></ListBucketResult>") == ()


def test_a_new_release_is_picked_up_and_remembered(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(200, listing("dr1", "dr2", "qr3", "qr4"))
    settings = make_settings(tmp_path, stub)

    assert active_collections(settings) == ("spherex_dr2", "spherex_dr1", "spherex_qr4")
    assert active_collections(settings) == ("spherex_dr2", "spherex_dr1", "spherex_qr4")
    assert len(stub.hits) == 1
    # Otro proceso lo encuentra en disco, sin preguntar.
    releases.reset()
    assert active_collections(settings) == ("spherex_dr2", "spherex_dr1", "spherex_qr4")
    assert len(stub.hits) == 1


def test_bucket_down_uses_the_fixed_list_and_does_not_insist(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(503, b"Slow Down")
    settings = make_settings(tmp_path, stub)

    assert active_collections(settings) == DEFAULT_COLLECTIONS
    assert active_collections(settings) == DEFAULT_COLLECTIONS
    assert len(stub.hits) == 1


def test_bucket_down_uses_the_saved_copy_even_if_old(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(503, b"Slow Down")
    settings = make_settings(tmp_path, stub)
    settings.cache_dir.mkdir(parents=True)
    saved = {"collections": ["spherex_dr2", "spherex_qr5"], "deep": False, "checked_at": 1.0}
    (settings.cache_dir / "releases.json").write_text(json.dumps(saved), encoding="utf-8")

    assert active_collections(settings) == ("spherex_dr2", "spherex_qr5")


def test_listing_that_is_not_a_listing_uses_the_fixed_list(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(200, b"<html>mantenimiento</html>")
    assert active_collections(make_settings(tmp_path, stub)) == DEFAULT_COLLECTIONS


def test_collections_chosen_by_hand_are_not_replaced(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(200, listing("dr1", "dr2", "qr4"))
    settings = make_settings(tmp_path, stub, collections=("spherex_qr2",))

    assert active_collections(settings) == ("spherex_qr2",)
    assert stub.hits == []


def test_discovery_can_be_turned_off(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes["/bucket"] = respond(200, listing("dr1", "dr2", "qr4"))
    settings = make_settings(tmp_path, stub, discover_releases=False)

    assert active_collections(settings) == DEFAULT_COLLECTIONS
    assert stub.hits == []
