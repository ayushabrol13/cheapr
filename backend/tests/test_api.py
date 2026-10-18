import uuid

import pytest
from conftest import NetClient as TestClient  # observation posts come from distinct networks

from app.main import app

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


def obs(price, **kw):
    return {**OBS, "price": price, "client_id": str(uuid.uuid4()), **kw}  # a fresh install per report


def test_history_dedupes_and_tracks_changes(c):
    for price in (1000, 1000, 900, 950):
        assert c.post("/api/v1/observations", json=obs(price)).status_code == 200
    h = c.get("/api/v1/products/amazon/B0TEST0001/history").json()
    assert [p["price"] for p in h["points"]] == [1000, 900, 950]  # repeated 1000 deduped
    assert h["stats"]["low"] == 900 and h["stats"]["high"] == 1000 and h["stats"]["current"] == 950
    assert h["verdict"] == "new"  # all observations are minutes apart: too little history to judge


def test_rejects_bad_urls_and_wild_prices(c):
    for url in ("http://www.amazon.in/dp/B0TEST0001", "https://x@www.amazon.in/dp/B0TEST0001",
                "https://evil.example\\@www.amazon.in/dp/B0TEST0001"):
        assert c.post("/api/v1/observations", json={**OBS, "url": url}).status_code == 422
    r = c.post("/api/v1/observations", json=obs(1))  # 1000x below: held as suspect, not shown
    assert r.status_code == 200 and r.json()["accepted"] is False
    assert 1 not in [p["price"] for p in c.get("/api/v1/products/amazon/B0TEST0001/history").json()["points"]]


def test_watch_triggers_on_drop(c):
    w = c.post("/api/v1/watches", json={"client_id": CID, "store": "amazon", "product_id": "B0TEST0001",
                                        "target_price": 800}).json()
    assert w["triggered_at"] is None
    for _ in range(2):
        c.post("/api/v1/observations", json=obs(799))
    [w] = c.get("/api/v1/watches", params={"client_id": CID}).json()
    assert w["triggered_at"] is None  # two networks aren't enough (a dual-stack host spans two)
    c.post("/api/v1/observations", json=obs(799))
    [w] = c.get("/api/v1/watches", params={"client_id": CID}).json()
    assert w["triggered_price"] == 799  # a third independent network confirms it
    assert c.delete(f"/api/v1/watches/{w['id']}", params={"client_id": "someone-else"}).status_code == 404
    assert c.delete(f"/api/v1/watches/{w['id']}", params={"client_id": CID}).status_code == 200


def test_coupons_rank_by_reports(c):
    assert c.post("/api/v1/coupons", json={"store": "shop.in", "code": "A1"}).status_code == 403
    for code in ("A1", "B2"):
        c.post("/api/v1/coupons", json={"store": "www.shop.in", "code": code}, headers={"X-Admin-Token": "secret"})
    rep = lambda code, ok: c.post("/api/v1/coupons/report", json={"client_id": CID, "store": "shop.in",  # noqa: E731
                                                                  "code": code, "worked": ok})
    rep("A1", False), rep("B2", True), rep("B2", True), rep("NEW9", True), rep("BAD0", False)
    listed = {x["code"]: x for x in c.get("/api/v1/coupons", params={"store": "shop.in"}).json()}
    assert list(listed) == ["B2", "A1"]  # NEW9 needs a second client; BAD0 never stored
    assert listed["B2"]["tries"] == 1  # duplicate vote from same client ignored


def test_rate_limit(c, monkeypatch):
    import app.main as m
    monkeypatch.setitem(m.LIMITS, "GET", 3)
    m._hits.clear()
    codes = [c.get("/api/v1/coupons", params={"store": "x.in"}).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    m._hits.clear()


def test_admin_endpoints(c):
    H = {"X-Admin-Token": "secret"}
    assert c.get("/api/v1/admin/stats").status_code == 403
    s = c.get("/api/v1/admin/stats", headers=H).json()
    assert s["products"] >= 1 and "recent_drops" in s
    rows = c.get("/api/v1/admin/products", params={"q": "test"}, headers=H).json()
    assert rows and rows[0]["product_id"] == "B0TEST0001" and rows[0]["points"] >= 3
    coupons = c.get("/api/v1/admin/coupons", params={"store": "shop.in"}, headers=H).json()
    pending = next(x for x in coupons if x["code"] == "NEW9")
    assert pending["listed"] is False
    assert c.delete(f"/api/v1/admin/coupons/{pending['id']}", headers=H).status_code == 200
    assert c.get("/admin").status_code == 200


def test_same_source_counts_once_per_hour(c):
    cid = str(uuid.uuid4())
    o = {**OBS, "product_id": "B0SPAM0001", "url": "https://www.amazon.in/dp/B0SPAM0001", "client_id": cid}
    assert c.post("/api/v1/observations", json={**o, "price": 500}).json()["accepted"] is True
    assert c.post("/api/v1/observations", json={**o, "price": 400}).json()["accepted"] is False


def test_out_of_band_price_needs_two_sources_then_unfreezes(c):
    o = lambda p: {**OBS, "product_id": "B0BAND0001", "url": "https://www.amazon.in/dp/B0BAND0001", "price": p,  # noqa: E731
                   "client_id": str(uuid.uuid4())}
    c.post("/api/v1/observations", json=o(100))  # wrong first price (say, an EMI amount)
    assert c.post("/api/v1/observations", json=o(9000)).json()["accepted"] is False
    assert c.post("/api/v1/observations", json=o(9050)).json()["accepted"] is False
    assert c.post("/api/v1/observations", json=o(9100)).json()["accepted"] is True  # third network agrees: accepted
    assert c.get("/api/v1/products/amazon/B0BAND0001/history").json()["product"]["price"] == 9100


def test_title_and_image_keep_first_sighting(c):
    o = {**OBS, "product_id": "B0TITLE001", "url": "https://www.amazon.in/dp/B0TITLE001", "title": "Real", "price": 10}
    c.post("/api/v1/observations", json={**o, "client_id": str(uuid.uuid4())})
    c.post("/api/v1/observations", json={**o, "title": "Click my scam", "image": "https://evil.example/x.png",
                                         "client_id": str(uuid.uuid4())})
    p = c.get("/api/v1/products/amazon/B0TITLE001/history").json()["product"]
    assert p["title"] == "Real" and "evil" not in p["image"]
    c.post("/api/v1/observations", json={**o, "image": "https://m.media-amazon.com/images/I/x.jpg", "client_id": str(uuid.uuid4())})
    assert c.get("/api/v1/products/amazon/B0TITLE001/history").json()["product"]["image"].startswith("https://m.media-amazon.com/")


def test_any_drop_alerts_rearm_on_each_new_low(c):
    cid = str(uuid.uuid4())
    o = lambda p: {**OBS, "product_id": "B0ANY00001", "url": "https://www.amazon.in/dp/B0ANY00001", "price": p,  # noqa: E731
                   "client_id": str(uuid.uuid4())}
    c.post("/api/v1/observations", json=o(1000))
    w = c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0ANY00001",
                                        "target_price": 1000, "mode": "any"}).json()
    assert w["target_price"] == 999 and w["triggered_at"] is None
    for _ in range(3):
        c.post("/api/v1/observations", json=o(950))
    [w] = c.get("/api/v1/watches", params={"client_id": cid}).json()
    assert w["triggered_price"] == 950 and w["target_price"] == 949  # re-armed below the new low


def test_delete_client_erases_alerts(c):
    cid = str(uuid.uuid4())
    c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0TEST0001", "target_price": 5})
    assert c.get("/api/v1/watches", params={"client_id": cid}).json()
    assert c.delete(f"/api/v1/clients/{cid}").status_code == 200
    assert c.get("/api/v1/watches", params={"client_id": cid}).json() == []


def test_failed_commit_is_not_reported_as_success(c):
    from fastapi import Depends
    from app.main import get_db
    from app.models import Coupon

    @app.post("/api/v1/_probe_commit")
    def probe(db=Depends(get_db)):
        db.add(Coupon(store="probe.in", code="DUP"))
        db.add(Coupon(store="probe.in", code="DUP"))  # unique violation at commit
        return {"ok": True}

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post("/api/v1/_probe_commit").status_code == 500


def test_same_network_installs_do_not_confirm_each_other(c):
    cid = str(uuid.uuid4())
    o = lambda: {**OBS, "product_id": "B0SYBIL001", "url": "https://www.amazon.in/dp/B0SYBIL001",  # noqa: E731
                 "client_id": str(uuid.uuid4())}
    c.post("/api/v1/observations", json={**o(), "price": 1000})
    c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0SYBIL001", "target_price": 900})
    same_net = {"X-Forwarded-For": "203.0.113.5"}
    for _ in range(5):  # many fake installs, one network
        c.post("/api/v1/observations", json={**o(), "price": 850}, headers=same_net)
    [w] = c.get("/api/v1/watches", params={"client_id": cid}).json()
    assert w["triggered_at"] is None


def test_image_urls_are_strictly_validated():
    from app.main import safe_image
    assert safe_image("amazon", "https://m.media-amazon.com/images/I/a.jpg") == "https://m.media-amazon.com/images/I/a.jpg"
    for bad in ["https://evil.example\\@m.media-amazon.com/x.jpg", "https://u:p@m.media-amazon.com/x.jpg",
                "http://m.media-amazon.com/x.jpg", "https://m.media-amazon.com.evil.example/x.jpg",
                "https://m.media-amazon.com:8443/x.jpg", "https://rukmini1.flixcart.com/x.jpg"]:
        assert safe_image("amazon", bad) == "", bad


def test_bulk_import_creates_watches_in_one_request(c):
    cid = str(uuid.uuid4())
    items = [{"store": "amazon", "product_id": f"B0BULK{i:04d}", "url": f"https://www.amazon.in/dp/B0BULK{i:04d}",
              "title": f"Item {i}", "price": 100 + i} for i in range(30)]
    items.append({"store": "amazon", "product_id": "B0EVIL0001", "url": "https://evil.example/dp/B0EVIL0001", "title": "x", "price": 5})
    r = c.post("/api/v1/watches/bulk", json={"client_id": cid, "items": items})
    assert r.status_code == 200 and r.json()["added"] == 30  # off-store URL skipped
    watches = c.get("/api/v1/watches", params={"client_id": cid}).json()
    assert len(watches) == 30 and all(w["mode"] == "any" and w["target_price"] == w["price"] - 1 for w in watches)
