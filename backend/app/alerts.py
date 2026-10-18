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


class TelegramError(Exception):
    """Carries Telegram's status and description only: the request URL embeds the bot token and must not be logged."""


def telegram_api(method: str, **params) -> dict:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    try:
        r = httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=40)
    except httpx.HTTPError as e:
        raise TelegramError(f"{method}: {type(e).__name__}") from None
    if r.status_code != 200:
        desc = (r.json().get("description") if r.headers.get("content-type", "").startswith("application/json") else "")
        raise TelegramError(f"{method}: HTTP {r.status_code} {desc}") from None
    return r.json()


def clean(text, limit: int) -> str:
    """Strip control characters (header injection, odd rendering) from crowd-supplied text."""
    return "".join(ch for ch in str(text or "") if ch.isprintable())[:limit]


def send_alert(alert: dict) -> None:
    """alert: {title, url, price, target, email?, chat_id?}. Never raises: delivery failures are logged."""
    try:
        _send(alert)
    except Exception as e:  # a bad alert must never take down the worker or API background task
        log.error("alert delivery failed: %s", type(e).__name__)


def _send(alert: dict) -> None:
    title, price = clean(alert.get("title"), 120) or "A product you watch", _inr(alert["price"])
    body = f"{title}\nNow {price} (your target: {_inr(alert['target'])})\n{alert['url']}"
    if alert.get("chat_id") and os.environ.get("TELEGRAM_BOT_TOKEN"):
        try:
            telegram_api("sendMessage", chat_id=alert["chat_id"], text=f"📉 Price drop\n{body}", disable_web_page_preview=False)
        except TelegramError as e:
            log.error("telegram alert failed: %s", e)
    if alert.get("email") and os.environ.get("SMTP_HOST"):
        msg = EmailMessage()
        msg["Subject"] = f"Price drop: {title[:70]} is now {price}"
        msg["From"] = os.environ.get("SMTP_FROM", "cheapr@localhost")
        msg["To"] = alert["email"]
        msg.set_content(f"{body}\n\nYou set this alert in Cheapr. Remove it from the Cheapr popup → Alerts.")
        _smtp_send(msg)


def send_verification(email: str, link: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = "Confirm your email for Cheapr price alerts"
    msg["From"] = os.environ.get("SMTP_FROM", "cheapr@localhost")
    msg["To"] = email
    msg.set_content(f"Someone (hopefully you) asked Cheapr to send price-drop alerts to this address.\n\n"
                    f"Confirm: {link}\n\nIf this wasn't you, ignore this email and you won't hear from us again.")
    try:
        _smtp_send(msg)
    except (OSError, smtplib.SMTPException) as e:
        log.error("verification email failed: %s", type(e).__name__)


def _smtp_send(msg: EmailMessage) -> None:
    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")), timeout=15) as smtp:
        smtp.starttls()
        if os.environ.get("SMTP_USER"):
            smtp.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        smtp.send_message(msg)
