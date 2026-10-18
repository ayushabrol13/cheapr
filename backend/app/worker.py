"""Background worker: re-checks watched products from the server (so alerts fire while browsers are closed)
and links Telegram chats. Run with `python -m app.worker`.
"""
import logging
import os
import random
import secrets
import time
from datetime import timedelta

import httpx
from sqlalchemy import select

from .alerts import send_alert, telegram_api
from .extract import extract_price
from .main import TG_CODE_TTL, host_ok, record_price, startup
from .models import Product, Session, TelegramLink, Watch, now

log = logging.getLogger("cheapr.worker")
REFRESH_EVERY = timedelta(hours=float(os.environ.get("REFRESH_HOURS", "6")))
MAX_PER_CYCLE = int(os.environ.get("REFRESH_MAX_PER_CYCLE", "200"))
HEADERS = {  # a normal desktop browser; stores serve bot-looking clients a captcha
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml",
}


MAX_BYTES = 6 * 1024 * 1024


def fetch_store_page(client: httpx.Client, store: str, url: str) -> str | None:
    """GET a product page, following at most 3 redirects and only to the same store's hosts (no SSRF via redirects)."""
    for _ in range(4):
        if not host_ok(store, url):
            return None
        with client.stream("GET", url, headers=HEADERS, timeout=20, follow_redirects=False) as r:
            if r.is_redirect:
                url = str(r.url.join(r.headers.get("location", "")))
                continue
            if r.status_code != 200:
                return None
            body = bytearray()
            for chunk in r.iter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    return None
            return body.decode(r.encoding or "utf-8", errors="replace")
    return None


def refresh_due(client: httpx.Client) -> int:
    """Re-check products that someone is watching and nobody has seen recently. Returns products refreshed."""
    with Session.begin() as db:
        due = db.scalars(select(Product).join(Watch, Watch.product_fk == Product.id)
                         .where(Watch.triggered_at.is_(None), Product.updated_at < now() - REFRESH_EVERY)
                         .distinct().order_by(Product.updated_at).limit(MAX_PER_CYCLE)).all()
        targets = [(p.id, p.store, p.url) for p in due]
    done = 0
    for pid, store, url in targets:
        try:
            html = fetch_store_page(client, store, url)
            got = extract_price(store, html) if html else None
        except httpx.HTTPError as e:
            log.warning("fetch failed %s: %s", url, type(e).__name__)
            got = None
        if got:
            with Session.begin() as db:
                p = db.get(Product, pid)
                if p.last_price * 0.2 <= got["price"] <= p.last_price * 5:  # same sanity band as crowd input
                    alerts = record_price(db, p, got["price"], got["mrp"], got["in_stock"])
                    done += 1
                else:
                    alerts = []
            for a in alerts:
                send_alert(a)  # never raises
        else:
            log.info("no price for %s (status/captcha?)", url)
        time.sleep(random.uniform(4, 9))  # polite pacing per store page
    return done


def poll_telegram(offset: int) -> int:
    """Long-poll Telegram for `/start <code>` messages and link chats. Returns the next update offset."""
    res = telegram_api("getUpdates", offset=offset, timeout=25, allowed_updates=["message"])
    for u in res.get("result", []):
        offset = u["update_id"] + 1
        msg = u.get("message") or {}
        text, chat = msg.get("text", ""), msg.get("chat", {}).get("id")
        if not chat or not text.startswith("/start"):
            continue
        code = text.partition(" ")[2].strip()
        with Session.begin() as db:
            link = db.scalar(select(TelegramLink).where(TelegramLink.code == code)) if code else None
            # single use and short-lived: a leaked or old link can't attach someone else's chat
            if link and (link.chat_id is not None or now() - link.created_at > TG_CODE_TTL):
                link = None
            if link:
                link.chat_id, link.code = chat, secrets.token_urlsafe(18)
        telegram_api("sendMessage", chat_id=chat, text=(
            "✅ Connected. Cheapr will message you here when a watched price drops." if link
            else "Open Cheapr → Settings → “Get alerts on Telegram” to connect this chat."))
    return offset


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    startup()
    offset, next_refresh = 0, 0.0
    with httpx.Client(http2=False) as client:
        while True:
            if time.monotonic() >= next_refresh:
                try:
                    log.info("refreshed %d products", refresh_due(client))
                except Exception:
                    log.exception("refresh cycle failed")
                next_refresh = time.monotonic() + 15 * 60
            if os.environ.get("TELEGRAM_BOT_TOKEN"):
                try:
                    offset = poll_telegram(offset)  # blocks up to 25s: doubles as the loop's sleep
                except Exception:
                    log.exception("telegram poll failed")
                    time.sleep(10)
            else:
                time.sleep(60)


if __name__ == "__main__":
    main()
