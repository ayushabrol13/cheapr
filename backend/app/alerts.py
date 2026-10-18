"""Price-drop alert delivery: email (SMTP) and Telegram. Both are optional and configured by env vars."""
import logging
import os
import smtplib
from email.message import EmailMessage

import httpx

log = logging.getLogger("cheapr.alerts")


def _inr(n: float) -> str:
    """Indian digit grouping: 1234567 -> 12,34,567."""
    s = f"{round(n):d}"
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    return "₹" + ",".join(([head] if head else []) + groups + [tail]) if len(s) > 3 else "₹" + s


def telegram_api(method: str, **params) -> dict:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    r = httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=40)
    r.raise_for_status()
    return r.json()


def send_alert(alert: dict) -> None:
    """alert: {title, url, price, target, email?, chat_id?}. Never raises: delivery failures are logged."""
    title, price = alert["title"][:120], _inr(alert["price"])
    body = f"{title}\nNow {price} (your target: {_inr(alert['target'])})\n{alert['url']}"
    if alert.get("chat_id") and os.environ.get("TELEGRAM_BOT_TOKEN"):
        try:
            telegram_api("sendMessage", chat_id=alert["chat_id"], text=f"📉 Price drop\n{body}", disable_web_page_preview=False)
        except Exception:
            log.exception("telegram alert failed")
    if alert.get("email") and os.environ.get("SMTP_HOST"):
        msg = EmailMessage()
        msg["Subject"] = f"Price drop: {title[:70]} is now {price}"
        msg["From"] = os.environ.get("SMTP_FROM", "cheapr@localhost")
        msg["To"] = alert["email"]
        msg.set_content(f"{body}\n\nYou set this alert in Cheapr. Remove it from the Cheapr popup → Alerts.")
        try:
            with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
                s.starttls()
                if os.environ.get("SMTP_USER"):
                    s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
                s.send_message(msg)
        except Exception:
            log.exception("alert email failed")
