import gzip
import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

import app.worker as worker
from app.main import app
from app.models import Product, Session, TelegramLink, now

FIX = Path(__file__).parents[2] / "extension" / "test" / "fixtures" / "amazon-B0FC2YFSN4.html.gz"


@pytest.fixture(scope="module")
def c():
    with TestClient(app) as client:
        yield client


def test_telegram_link_requires_config(c, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    assert c.post("/api/v1/telegram/link", json={"client_id": str(uuid.uuid4())}).status_code == 503


def test_telegram_start_links_chat_and_alerts_use_it(c, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "CheaprBot")
    cid = str(uuid.uuid4())
    url = c.post("/api/v1/telegram/link", json={"client_id": cid}).json()["url"]
    code = url.split("start=")[1]
    sent = []
    updates = {"result": [{"update_id": 7, "message": {"text": f"/start {code}", "chat": {"id": 4242}}}]}
    monkeypatch.setattr(worker, "telegram_api", lambda m, **kw: updates if m == "getUpdates" else sent.append(kw) or {})
    assert worker.poll_telegram(0) == 8
    assert c.get("/api/v1/telegram/status", params={"client_id": cid}).json()["connected"] is True
    assert "Connected" in sent[0]["text"]


def test_worker_refresh_records_price_and_fires_alert(c, monkeypatch):
    cid = str(uuid.uuid4())
    obs = {"store": "amazon", "product_id": "B0FC2YFSN4", "url": "https://www.amazon.in/dp/B0FC2YFSN4", "title": "boAt", "price": 999}
    assert c.post("/api/v1/observations", json=obs).status_code == 200  # worker refresh is trusted: one source suffices
    c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0FC2YFSN4", "target_price": 900})
    with Session.begin() as db:  # pretend nobody has seen it for a day
        db.scalar(select(Product).where(Product.product_id == "B0FC2YFSN4")).updated_at = now() - timedelta(days=1)
    page = gzip.decompress(FIX.read_bytes()).decode()  # real Amazon page: price 867
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, text=page)))
    alerts = []
    monkeypatch.setattr(worker, "send_alert", alerts.append)
    monkeypatch.setattr(worker.time, "sleep", lambda s: None)
    with Session.begin() as db:  # only this product is due in this test
        for other in db.scalars(select(Product).where(Product.product_id != "B0FC2YFSN4")):
            other.needs_check, other.checked_at = False, now()
    assert worker.refresh_due(client) == 1
    assert alerts and alerts[0]["price"] == 867 and alerts[0]["target"] == 900
    with Session() as db:
        assert db.scalar(select(Product).where(Product.product_id == "B0FC2YFSN4")).last_price == 867


def test_email_alerts_need_double_opt_in(c, monkeypatch):
    import app.main as m
    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    sent = []
    monkeypatch.setattr(m, "send_verification", lambda email, link: sent.append(link))
    cid, email = str(uuid.uuid4()), "shopper@example.com"
    obs = {"store": "amazon", "product_id": "B0OPTIN001", "url": "https://www.amazon.in/dp/B0OPTIN001", "title": "X", "price": 1000}
    c.post("/api/v1/observations", json=obs)
    c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0OPTIN001", "target_price": 950, "email": email})
    status = lambda: c.get("/api/v1/email/status", params={"client_id": cid, "email": email}).json()["verified"]  # noqa: E731
    assert sent and status() is False
    token = sent[0].split("token=")[1]
    assert c.get("/api/v1/email/verify", params={"token": token}).status_code == 200 and status() is False  # GET never confirms
    assert c.post("/api/v1/email/verify", data={"token": token}).status_code == 200 and status() is True
    assert c.post("/api/v1/email/verify", data={"token": token}).status_code == 404  # single use
    other = str(uuid.uuid4())  # another install reusing the confirmed address gets no email
    assert c.get("/api/v1/email/status", params={"client_id": other, "email": email}).json()["verified"] is False
    alerts = []
    monkeypatch.setattr(m, "send_alert", alerts.append)
    for _ in range(2):  # two independent reports confirm the drop
        c.post("/api/v1/observations", json={**obs, "price": 940, "client_id": str(uuid.uuid4())})
    assert alerts and alerts[0]["email"] == email


def test_telegram_code_is_single_use(c, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "CheaprBot")
    code = c.post("/api/v1/telegram/link", json={"client_id": str(uuid.uuid4())}).json()["url"].split("start=")[1]
    replies = []
    def fake(method, **kw):
        if method == "getUpdates":
            return {"result": [{"update_id": 1, "message": {"text": f"/start {code}", "chat": {"id": 1}}},
                               {"update_id": 2, "message": {"text": f"/start {code}", "chat": {"id": 666}}}]}
        replies.append((kw["chat_id"], kw["text"]))
        return {}
    monkeypatch.setattr(worker, "telegram_api", fake)
    worker.poll_telegram(0)
    with Session() as db:
        assert db.scalar(select(TelegramLink.chat_id).where(TelegramLink.chat_id.in_([1, 666]))) == 1
    assert "Connected" in replies[0][1] and "Connected" not in replies[1][1]


def test_fetch_refuses_offsite_redirect():
    def handler(req):
        if req.url.host == "www.amazon.in":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})
        raise AssertionError("followed an off-site redirect")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert worker.fetch_store_page(client, "amazon", "https://www.amazon.in/dp/B0FC2YFSN4") is None


def test_verification_mail_capped_per_address_across_installs(c, monkeypatch):
    import app.main as m
    monkeypatch.setenv("SMTP_HOST", "smtp.test")
    sent = []
    monkeypatch.setattr(m, "send_verification", lambda email, link: sent.append(email))
    obs = {"store": "amazon", "product_id": "B0BOMB0001", "url": "https://www.amazon.in/dp/B0BOMB0001", "title": "X", "price": 500}
    c.post("/api/v1/observations", json=obs)
    for _ in range(10):  # attacker rotates install IDs
        c.post("/api/v1/watches", json={"client_id": str(uuid.uuid4()), "store": "amazon", "product_id": "B0BOMB0001",
                                        "target_price": 400, "email": "victim@example.com"})
    assert sent == ["victim@example.com"]  # one an hour, whoever asks


class Clock:
    def __init__(self, m, monkeypatch):
        self.t = m.now()
        monkeypatch.setattr(m, "now", lambda: self.t)

    def advance(self, **kw):
        self.t += timedelta(**kw)


def test_alert_cap_is_rolling_24h(c, monkeypatch):
    import app.main as m
    clock = Clock(m, monkeypatch)
    with Session.begin() as db:
        got = [m.take_alert_slot(db, "inst", "roll@example.com") for _ in range(m.ALERTS_PER_DAY + 1)]
        assert got[-2:] == [True, False]
        clock.advance(hours=23)
        assert m.take_alert_slot(db, "inst", "roll@example.com") is False  # still inside the window
        clock.advance(hours=2)
        assert m.take_alert_slot(db, "inst", "roll@example.com") is True  # oldest sends aged out


def test_verify_budget_per_address_rolls(c, monkeypatch):
    import app.main as m
    clock = Clock(m, monkeypatch)
    with Session.begin() as db:
        assert m.take_verify_slot(db, "a", "v@example.com") is True
        assert m.take_verify_slot(db, "b", "v@example.com") is False  # another install, same hour
        for _ in range(2):
            clock.advance(minutes=61)
            assert m.take_verify_slot(db, "b", "v@example.com") is True
        clock.advance(minutes=61)
        assert m.take_verify_slot(db, "c", "v@example.com") is False  # 3 per address per rolling day
        clock.advance(hours=22)
        assert m.take_verify_slot(db, "c", "v@example.com") is True  # first send aged out


def test_saving_a_watch_spends_no_alert_budget(c, monkeypatch):
    import app.main as m
    cid, email = str(uuid.uuid4()), "budget@example.com"
    obs = {"store": "amazon", "product_id": "B0BUDGET01", "url": "https://www.amazon.in/dp/B0BUDGET01", "title": "X", "price": 500}
    c.post("/api/v1/observations", json=obs)
    with Session.begin() as db:
        db.add(m.EmailAddress(client_id=cid, email=email, token=uuid.uuid4().hex, verified_at=m.now()))
    for _ in range(3):  # target already met: flagged on save, nothing sent
        c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0BUDGET01", "target_price": 600, "email": email})
    with Session() as db:
        assert m.sends_since(db, email, "alert", m.now() - timedelta(days=1)) == 0
