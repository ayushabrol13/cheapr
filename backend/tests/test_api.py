import os
import tempfile
import uuid

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ["ADMIN_TOKEN"] = "secret"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app, verdict  # noqa: E402

CID = str(uuid.uuid4())
OBS = {"store": "amazon", "product_id": "B0TEST0001", "url": "https://www.amazon.in/dp/B0TEST0001",
       "title": "Test Phone", "price": 1000}


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as client:
        yield client


def test_rejects_url_from_other_store(c):
    r = c.post("/api/v1/observations", json={**OBS, "url": "https://evil.example/dp/B0TEST0001"})
    assert r.status_code == 422


def test_history_dedupes_and_tracks_changes(c):
    for price in (1000, 1000, 900, 950):
        assert c.post("/api/v1/observations", json={**OBS, "price": price}).status_code == 200
    h = c.get("/api/v1/products/amazon/B0TEST0001/history").json()
    assert [p["price"] for p in h["points"]] == [1000, 900, 950]  # repeated 1000 deduped
    assert h["stats"] == {"min": 900, "max": 1000, "avg": 950.0, "count": 3}
    assert h["verdict"] == "fair"


def test_watch_triggers_on_drop(c):
    w = c.post("/api/v1/watches", json={"client_id": CID, "store": "amazon", "product_id": "B0TEST0001",
                                        "target_price": 800}).json()
    assert w["triggered_at"] is None
    c.post("/api/v1/observations", json={**OBS, "price": 799})
    [w] = c.get("/api/v1/watches", params={"client_id": CID}).json()
    assert w["triggered_price"] == 799
    assert c.delete(f"/api/v1/watches/{w['id']}", params={"client_id": "someone-else"}).status_code == 404
    assert c.delete(f"/api/v1/watches/{w['id']}", params={"client_id": CID}).status_code == 200


def test_coupons_rank_by_reports(c):
    assert c.post("/api/v1/coupons", json={"store": "shop.in", "code": "A1"}).status_code == 403
    for code in ("A1", "B2"):
        c.post("/api/v1/coupons", json={"store": "www.shop.in", "code": code}, headers={"X-Admin-Token": "secret"})
    rep = lambda code, ok: c.post("/api/v1/coupons/report", json={"client_id": CID, "store": "shop.in",  # noqa: E731
                                                                  "code": code, "worked": ok})
    rep("A1", False), rep("B2", True), rep("NEW9", True), rep("BAD0", False)
    codes = [x["code"] for x in c.get("/api/v1/coupons", params={"store": "shop.in"}).json()]
    assert codes[:2] in (["B2", "NEW9"], ["NEW9", "B2"]) and codes[-1] == "A1" and "BAD0" not in codes


def test_verdict():
    assert verdict([100, 100]) == "not-enough-data"
    assert verdict([100, 120, 100]) == "lowest"
    assert verdict([100, 200, 300, 150]) == "good"
    assert verdict([100, 100, 100, 130]) == "high"
