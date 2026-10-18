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
    assert c.post("/api/v1/observations", json=obs).status_code == 200
    c.post("/api/v1/watches", json={"client_id": cid, "store": "amazon", "product_id": "B0FC2YFSN4", "target_price": 900})
    with Session.begin() as db:  # pretend nobody has seen it for a day
        db.scalar(select(Product).where(Product.product_id == "B0FC2YFSN4")).updated_at = now() - timedelta(days=1)
    page = gzip.decompress(FIX.read_bytes()).decode()  # real Amazon page: price 867
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, text=page)))
    alerts = []
    monkeypatch.setattr(worker, "send_alert", alerts.append)
    monkeypatch.setattr(worker.time, "sleep", lambda s: None)
    assert worker.refresh_due(client) == 1
    assert alerts and alerts[0]["price"] == 867 and alerts[0]["target"] == 900
    with Session() as db:
        assert db.scalar(select(Product).where(Product.product_id == "B0FC2YFSN4")).last_price == 867
