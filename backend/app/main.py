import hashlib
import html
import ipaddress
import json
from contextlib import asynccontextmanager
import logging
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote_plus, urlparse

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .insights import Point, analyze
from .migrate import upgrade
from .alerts import clean, send_alert, send_verification
from .models import Coupon, CouponReport, Price, Product, Session, Sighting, TelegramLink, Watch, EmailAddress, EmailSend, EmailThrottle, engine, now

log = logging.getLogger("cheapr")

# Store key -> hostnames its product URLs must live on (stops observations for one store polluting another).
STORES = {"amazon": ("amazon.in",), "flipkart": ("flipkart.com",), "myntra": ("myntra.com",), "ajio": ("ajio.com",)}
# Product images are only accepted from each store's own image CDN (the popup and alerts load them for everyone).
IMAGE_HOSTS = {"amazon": ("media-amazon.com", "ssl-images-amazon.com"), "flipkart": ("flixcart.com",),
               "myntra": ("myntassets.com",), "ajio": ("ajio.com", "sheinindia.in")}
DEDUPE_WINDOW = timedelta(hours=6)
MAX_SWING = (0.2, 5.0)  # an observation outside 20%..500% of the last price is treated as bogus
MIN_CONFIRMATIONS = 2  # distinct clients before a user-submitted coupon is listed
ALERTS_PER_DAY = 20  # per address, rolling 24h: a runaway price feed can't spam anyone
VERIFY_PER_ADDRESS = (timedelta(hours=1), 3)  # confirmation mails per address, any install: 1 an hour, 3 a day
TG_CODE_TTL = timedelta(minutes=30)
UUID = r"^[0-9a-fA-F-]{36}$"
CODE = r"^[A-Za-z0-9_-]{2,40}$"
EMAIL = r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]+$"

def startup() -> None:
    upgrade()  # Alembic migrations: schema changes reach existing databases (create_all never alters tables)
    seed = Path(os.environ.get("COUPON_SEED", Path(__file__).parent.parent / "seed_coupons.json"))
    if seed.exists():
        with Session.begin() as db:
            for c in json.loads(seed.read_text()):
                if not db.scalar(select(Coupon).where(Coupon.store == c["store"], Coupon.code == c["code"])):
                    db.add(Coupon(store=c["store"], code=c["code"], description=c.get("description", "")))


@asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app = FastAPI(title="Cheapr API", version="0.2.0", lifespan=lifespan)

# Per-IP sliding-window limits. shortcut: in-process memory, so limits are per worker; move to Redis when scaling out.
LIMITS = {"POST": int(os.environ.get("RATE_LIMIT_WRITE", "60")), "DELETE": 60, "GET": int(os.environ.get("RATE_LIMIT_READ", "600"))}
_hits: dict[tuple[str, str], deque] = defaultdict(deque)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    limit = LIMITS.get(request.method)
    if limit and request.url.path.startswith("/api/"):
        ip = client_ip(request)  # right-most X-Forwarded-For entry when TRUST_PROXY: added by our proxy
        t = time.monotonic()
        if len(_hits) > 50_000:  # bound memory under key churn: drop idle keys before touching ours
            for k in [k for k, v in _hits.items() if not v or t - v[-1] > 60]:
                del _hits[k]
        q = _hits[(ip, request.method)]
        while q and t - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return JSONResponse({"detail": "rate limited"}, status_code=429, headers={"Retry-After": "60"})
        q.append(t)
    return await call_next(request)


@app.middleware("http")
async def db_session(request: Request, call_next):
    """One session per API request, committed BEFORE the response is returned: a failed commit becomes a 500
    instead of a 200 for data that was never saved (yield-dependency teardown runs after the response is sent)."""
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    with Session() as db:
        request.state.db = db
        response = await call_next(request)
        if response.status_code >= 400:
            db.rollback()
            return response
        try:
            db.commit()
        except Exception:
            db.rollback()
            log.exception("commit failed")
            return JSONResponse({"detail": "could not save, please retry"}, status_code=500)
        return response


def charge(request: Request, n: int) -> None:
    """Count n extra writes against this client's per-IP limit (bulk endpoints mustn't be a limiter bypass)."""
    q, t = _hits[(client_ip(request), "POST")], time.monotonic()
    if len(q) + n > LIMITS["POST"]:
        raise HTTPException(429, "rate limited", headers={"Retry-After": "60"})
    q.extend([t] * n)


def get_db(request: Request):
    return request.state.db


# ---------- price history ----------

class Observation(BaseModel):
    store: str = Field(max_length=32)
    product_id: str = Field(min_length=1, max_length=64)
    url: str = Field(max_length=2048)
    title: str = Field("", max_length=512)
    image: str = Field("", max_length=2048)
    currency: str = Field("INR", max_length=8)
    price: float = Field(gt=0, lt=1e8)
    mrp: float | None = Field(None, gt=0, lt=1e8)
    in_stock: bool = True
    client_id: str | None = Field(None, pattern=UUID)


def host_ok(store: str, url: str) -> bool:
    u = urlparse(url)
    if u.scheme != "https" or u.username or u.password or "\\" in url or any(ord(ch) < 33 for ch in url):
        return False
    host = (u.hostname or "").lower()
    return store in STORES and any(host == h or host.endswith("." + h) for h in STORES[store])


def safe_image(store: str, url: str) -> str:
    """Store-CDN https image, re-serialised from the validated parts (no parser differentials)."""
    url = url or ""
    u = urlparse(url)
    if u.scheme != "https" or u.username or u.password or u.port or "\\" in url or any(ord(ch) < 33 for ch in url):
        return ""
    host = (u.hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in IMAGE_HOSTS.get(store, ())):
        return ""
    return f"https://{host}{u.path}" + (f"?{u.query}" if u.query else "")


def find_product(db, store: str, product_id: str) -> Product | None:
    return db.scalar(select(Product).where(Product.store == store, Product.product_id == product_id))


def client_ip(request: Request) -> str:
    ip = request.client.host if request.client else "?"
    if os.environ.get("TRUST_PROXY") and request.headers.get("x-forwarded-for"):
        ip = request.headers["x-forwarded-for"].split(",")[-1].strip()
    return ip


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def source_of(client_id: str | None, request: Request) -> tuple[str, str]:
    """(source, net): hashed install id (else IP) and hashed network. Install ids are self-chosen, so confirmations
    must also come from a different network (/24 IPv4, /48 IPv6) to count as independent. Never stored raw."""
    ip = client_ip(request)
    try:
        addr = ipaddress.ip_address(ip)
        net = str(ipaddress.ip_network(f"{ip}/{24 if addr.version == 4 else 48}", strict=False))
    except ValueError:
        net = ip
    return digest(client_id or "ip:" + ip), digest("net:" + net)


@app.post("/api/v1/observations")
def observe(o: Observation, request: Request, bg: BackgroundTasks, db=Depends(get_db)):
    if not host_ok(o.store, o.url):
        raise HTTPException(422, "url does not belong to store")
    p = find_product(db, o.store, o.product_id)
    if p is None:
        p = Product(store=o.store, product_id=o.product_id, url=o.url, last_price=o.price,
                    title=clean(o.title, 512), image=safe_image(o.store, o.image), currency=o.currency)
        db.add(p)
        db.flush()
    # Title/image are kept from the first sighting: a later client can't rewrite what alerts and the popup show.
    p.title = p.title or clean(o.title, 512)
    p.image = p.image or safe_image(o.store, o.image)
    source, net = source_of(o.client_id, request)
    result = record_price(db, p, o.price, o.mrp, o.in_stock, source, net)
    for alert in result["alerts"]:
        bg.add_task(send_alert, alert)
    return {"ok": True, "accepted": result["accepted"]}


SOURCE_GAP = timedelta(hours=1)  # one counted observation per source per product per hour
CONFIRM_WINDOW = timedelta(hours=24)
CONFIRM_NETS = 3  # distinct client networks (incl. this one) that must agree; a dual-stack host spans only two


def record_price(db, p: Product, price: float, mrp: float | None, in_stock: bool, source: str, net: str = "") -> dict:
    """Store a price point and fire watches; shared by the API (crowd) and the worker (source="worker").

    Crowd input is untrusted: prices outside the sanity band are held as suspect until a second, different source
    agrees (this also unfreezes a product whose first price was wrong), and a crowd price that would fire alerts
    needs a second source or a worker re-check first. Returns {"accepted": bool, "alerts": [...]}."""
    trusted, t = source == "worker", now()
    if mrp is not None and not (price <= mrp <= price * 20):
        mrp = None  # implausible MRP: keep the price, drop the MRP
    if not trusted and db.scalar(select(Price.id).where(Price.product_fk == p.id, Price.source == source,
                                                        Price.observed_at >= t - SOURCE_GAP).limit(1)):
        return {"accepted": False, "alerts": []}  # same source again within the hour: ignore
    in_band = p.last_price * MAX_SWING[0] <= price <= p.last_price * MAX_SWING[1]
    if not in_band:
        agree = db.scalars(select(Price).where(Price.product_fk == p.id, Price.suspect.is_(True), Price.source != source,
                                               Price.net != net,
                                               Price.observed_at >= t - CONFIRM_WINDOW,
                                               Price.price.between(price * 0.95, price * 1.05))).all()
        if not (trusted or len({r.net for r in agree}) + 1 >= CONFIRM_NETS):
            db.add(Price(product_fk=p.id, price=price, mrp=mrp, in_stock=in_stock, source=source, net=net, suspect=True, observed_at=t))
            return {"accepted": False, "alerts": []}
        for row in agree:
            row.suspect = False
    last = db.scalar(select(Price).where(Price.product_fk == p.id, Price.suspect.is_(False))
                     .order_by(Price.observed_at.desc()).limit(1))
    if not (last and last.price == price and last.in_stock == in_stock and t - last.observed_at < DEDUPE_WINDOW):
        db.add(Price(product_fk=p.id, price=price, mrp=mrp, in_stock=in_stock, source=source, net=net, observed_at=t))
    p.last_price, p.updated_at = price, t
    if not trusted and net:
        db.add(Sighting(product_fk=p.id, net=net, price=price, seen_at=t))
        db.flush()
    if not in_stock:
        return {"accepted": True, "alerts": []}
    if trusted:
        p.needs_check = False
        return {"accepted": True, "alerts": trigger_watches(db, p)}
    crossing = db.scalar(select(Watch.id).where(Watch.product_fk == p.id, Watch.target_price >= price,
                                                Watch.triggered_at.is_(None) | (Watch.mode == "any")).limit(1))
    if not crossing:
        return {"accepted": True, "alerts": []}
    worker_saw = db.scalar(select(Price.id).where(Price.product_fk == p.id, Price.source == "worker", Price.suspect.is_(False),
                                                  Price.observed_at >= t - CONFIRM_WINDOW, Price.price <= price * 1.02).limit(1))
    nets = set(db.scalars(select(Sighting.net).where(Sighting.product_fk == p.id, Sighting.seen_at >= t - CONFIRM_WINDOW,
                                                     Sighting.price <= price * 1.02)))
    if worker_saw or len(nets) >= CONFIRM_NETS:
        return {"accepted": True, "alerts": trigger_watches(db, p)}
    p.needs_check = True  # one unconfirmed report: the worker re-checks it before anyone is alerted
    return {"accepted": True, "alerts": []}


def find_consent(db, client_id: str, email: str) -> EmailAddress | None:
    return db.scalar(select(EmailAddress).where(EmailAddress.client_id == client_id, EmailAddress.email == email.lower()))


def mail_key(email: str) -> str:
    return hashlib.sha256(email.lower().encode()).hexdigest()


def lock_address(db, email: str) -> None:
    """Serialise budget checks for one address: upsert its lock row, then row-lock it (FOR UPDATE on Postgres;
    SQLite serialises writers anyway). Callers lock several addresses in sorted order to avoid deadlocks."""
    ins = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    db.execute(ins(EmailThrottle).values(email=mail_key(email)).on_conflict_do_nothing())
    db.execute(select(EmailThrottle).where(EmailThrottle.email == mail_key(email)).with_for_update())


def sends_since(db, email: str, kind: str, since: datetime, client_id: str | None = None) -> int:
    q = select(func.count(EmailSend.id)).where(EmailSend.email == mail_key(email), EmailSend.kind == kind, EmailSend.sent_at >= since)
    if client_id:
        q = q.where(EmailSend.client_id == client_id)
    return db.scalar(q) or 0


def take_alert_slot(db, client_id: str, email: str) -> bool:
    """Count one alert against the address's rolling-24h cap; False when the cap is reached."""
    lock_address(db, email)
    if sends_since(db, email, "alert", now() - timedelta(days=1)) >= ALERTS_PER_DAY:
        return False
    db.add(EmailSend(email=mail_key(email), client_id=client_id, kind="alert", sent_at=now()))
    return True


def take_verify_slot(db, client_id: str, email: str) -> bool:
    """Reserve a confirmation mail: at most 1/hour and 3/rolling-day per address, whichever install asks.
    Trade-off (deliberate): never mailing non-consenting inboxes beats guaranteed opt-in, so a stranger who keeps
    requesting confirmations for an address can stall its owner; per-IP rate limits and Telegram mitigate that."""
    lock_address(db, email)
    t, (gap, per_day) = now(), VERIFY_PER_ADDRESS
    if sends_since(db, email, "verify", t - gap) or sends_since(db, email, "verify", t - timedelta(days=1)) >= per_day:
        return False
    db.add(EmailSend(email=mail_key(email), client_id=client_id, kind="verify", sent_at=t))
    return True


def email_allowed(db, client_id: str, email: str) -> bool:
    """This install confirmed this address (double opt-in) and the address is under today's cap."""
    e = find_consent(db, client_id, email)
    return bool(e and e.verified_at) and take_alert_slot(db, client_id, e.email)


def request_verification(db, client_id: str, email: str, bg: BackgroundTasks) -> None:
    email = email.lower()
    e = find_consent(db, client_id, email)
    if e is None:
        e = EmailAddress(client_id=client_id, email=email, token=secrets.token_urlsafe(32))
        db.add(e)
    base = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
    if not e.verified_at and os.environ.get("SMTP_HOST") and take_verify_slot(db, client_id, email):
        e.verify_sent_at, e.token = now(), secrets.token_urlsafe(32)  # fresh token per mail
        bg.add_task(send_verification, email, f"{base}/api/v1/email/verify?token={e.token}")


def trigger_watches(db, p: Product, notify: bool = True) -> list[dict]:
    """Fire watches at/below target. "any" watches re-arm just under each new low so every further drop alerts.
    notify=False (saving a watch) flags without spending mail budget."""
    alerts = []
    hits = db.scalars(select(Watch).where(Watch.product_fk == p.id, Watch.target_price >= p.last_price,
                                          Watch.triggered_at.is_(None) | (Watch.mode == "any"))
                      .order_by(func.lower(func.coalesce(Watch.email, "")), Watch.id)).all()  # fixed lock order
    for w in hits:
        w.triggered_at, w.triggered_price = now(), p.last_price
        if w.mode == "any":
            w.target_price = max(round(p.last_price - 1, 2), 0.01)  # next alert needs a strictly lower price
        if not notify:
            continue
        link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == w.client_id, TelegramLink.chat_id.is_not(None)))
        alerts.append({"title": p.title, "url": p.url, "price": p.last_price, "target": w.target_price,
                       "email": w.email if w.email and email_allowed(db, w.client_id, w.email) else None,
                       "chat_id": link.chat_id if link else None})
    return alerts


MAX_POINTS = 400


def chart_points(rows: list[Price]) -> list[dict]:
    """Points for the chart; long histories are reduced to each day's lowest price (insights use every row)."""
    pts = [{"t": r.observed_at.isoformat() + "Z", "price": r.price, "in_stock": r.in_stock} for r in rows]
    if len(pts) <= MAX_POINTS:
        return pts
    days: dict[str, dict] = {}
    for pt in pts:
        d = days.setdefault(pt["t"][:10], pt)
        if pt["in_stock"] and (pt["price"] < d["price"] or not d["in_stock"]):
            days[pt["t"][:10]] = pt
    return list(days.values())


@app.get("/api/v1/products/{store}/{product_id}/history")
def history(store: str, product_id: str, days: int = 90, db=Depends(get_db)):
    p = find_product(db, store, product_id)
    if p is None:
        raise HTTPException(404, "unknown product")
    rows = db.scalars(select(Price).where(Price.product_fk == p.id, Price.suspect.is_(False),
                                          Price.observed_at >= now() - timedelta(days=730)).order_by(Price.observed_at)).all()
    mrps = sorted(r.mrp for r in rows[-7:] if r.mrp)
    mrp = mrps[len(mrps) // 2] if mrps else None  # median of recent reports: one bogus MRP can't drive the insight
    result = analyze([Point(r.observed_at, r.price, r.in_stock) for r in rows], mrp, now(), max(7, min(days, 365)))
    return {
        "product": {"store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url,
                    "image": p.image, "currency": p.currency, "price": p.last_price, "mrp": mrp},
        "points": chart_points(rows),
        **result,
    }


# ---------- watchlist & alerts ----------

class WatchIn(BaseModel):
    client_id: str = Field(pattern=UUID)
    store: str = Field(max_length=32)
    product_id: str = Field(max_length=64)
    target_price: float = Field(gt=0, lt=1e8)
    mode: str = Field("target", pattern="^(target|any)$")
    email: str | None = Field(None, pattern=EMAIL, max_length=320)


def watch_out(w: Watch, p: Product) -> dict:
    return {"id": w.id, "store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url,
            "image": p.image, "price": p.last_price, "target_price": w.target_price, "mode": w.mode,
            "triggered_at": w.triggered_at.isoformat() + "Z" if w.triggered_at else None,
            "triggered_price": w.triggered_price}


@app.post("/api/v1/watches")
def add_watch(body: WatchIn, bg: BackgroundTasks, db=Depends(get_db)):
    p = find_product(db, body.store, body.product_id)
    if p is None:
        raise HTTPException(404, "product not seen yet; open its page first")
    w = db.scalar(select(Watch).where(Watch.client_id == body.client_id, Watch.product_fk == p.id))
    if w is None:
        w = Watch(client_id=body.client_id, product_fk=p.id, target_price=body.target_price)
        db.add(w)
    target = min(body.target_price, round(p.last_price - 1, 2)) if body.mode == "any" else body.target_price
    w.target_price, w.mode, w.email, w.triggered_at, w.triggered_price = max(target, 0.01), body.mode, body.email, None, None
    db.flush()
    trigger_watches(db, p, notify=False)  # already below target: flag it, but never send on save (spam relay)
    if body.email:
        request_verification(db, body.client_id, body.email, bg)
    return watch_out(w, p)


class BulkItem(BaseModel):
    store: str = Field(max_length=32)
    product_id: str = Field(min_length=1, max_length=64)
    url: str = Field(max_length=2048)
    title: str = Field("", max_length=512)
    image: str = Field("", max_length=2048)
    price: float = Field(gt=0, lt=1e8)


class BulkWatchIn(BaseModel):
    client_id: str = Field(pattern=UUID)
    mode: str = Field("any", pattern="^(target|any)$")
    email: str | None = Field(None, pattern=EMAIL, max_length=320)
    items: list[BulkItem] = Field(min_length=1, max_length=50)


@app.post("/api/v1/watches/bulk")
def bulk_watches(body: BulkWatchIn, request: Request, bg: BackgroundTasks, db=Depends(get_db)):
    """Wishlist import: record each item's price and watch it, in one request (stays inside per-IP rate limits)."""
    charge(request, len(body.items) - 1)  # the request itself was already counted once
    source, net = source_of(body.client_id, request)
    added = 0
    for it in body.items:
        if not host_ok(it.store, it.url):
            continue
        p = find_product(db, it.store, it.product_id)
        if p is None:
            p = Product(store=it.store, product_id=it.product_id, url=it.url, last_price=it.price,
                        title=clean(it.title, 512), image=safe_image(it.store, it.image))
            db.add(p)
            db.flush()
            record_price(db, p, it.price, None, True, source, net)
        w = db.scalar(select(Watch).where(Watch.client_id == body.client_id, Watch.product_fk == p.id))
        if w is None:
            w = Watch(client_id=body.client_id, product_fk=p.id, target_price=it.price)
            db.add(w)
        target = round(p.last_price - 1, 2) if body.mode == "any" else it.price
        w.target_price, w.mode, w.email, w.triggered_at, w.triggered_price = max(target, 0.01), body.mode, body.email, None, None
        added += 1
    if body.email and added:
        request_verification(db, body.client_id, body.email, bg)
    return {"added": added}


@app.get("/api/v1/watches")
def list_watches(client_id: str = Query(pattern=UUID), db=Depends(get_db)):
    rows = db.execute(select(Watch, Product).join(Product, Watch.product_fk == Product.id)
                      .where(Watch.client_id == client_id).order_by(Watch.created_at.desc())).all()
    return [watch_out(w, p) for w, p in rows]


@app.delete("/api/v1/watches/{watch_id}")
def delete_watch(watch_id: int, client_id: str, db=Depends(get_db)):
    w = db.get(Watch, watch_id)
    if w is None or w.client_id != client_id:
        raise HTTPException(404, "not found")
    db.delete(w)
    return {"ok": True}


@app.delete("/api/v1/clients/{client_id}")
def delete_client(client_id: str, db=Depends(get_db)):
    """Erase everything tied to an install: alerts, email consents, Telegram link (price points carry only a hash)."""
    if not re.fullmatch(UUID, client_id):
        raise HTTPException(422, "bad client id")
    for model in (Watch, EmailAddress, TelegramLink):
        db.execute(delete(model).where(model.client_id == client_id))
    # Keep anonymous counts (mail throttling, coupon scores) but cut the link to this install.
    db.execute(update(EmailSend).where(EmailSend.client_id == client_id).values(client_id=""))
    db.execute(update(CouponReport).where(CouponReport.client_id == client_id).values(client_id=""))
    return {"ok": True}


VERIFY_TTL = timedelta(hours=48)
PAGE = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Cheapr</title>"
        "<body style='font:16px system-ui;text-align:center;margin-top:18vh;padding:0 16px'>{}</body>")


def pending_consent(db, token: str) -> EmailAddress | None:
    e = db.scalar(select(EmailAddress).where(EmailAddress.token == token))
    if e is None or e.verified_at or not e.verify_sent_at or now() - e.verify_sent_at > VERIFY_TTL:
        return None
    return e


@app.get("/api/v1/email/verify", response_class=HTMLResponse)
def verify_email_page(token: str = Query(max_length=64), db=Depends(get_db)):
    # GET only shows a button: mail scanners that prefetch links must not confirm on the user's behalf.
    if pending_consent(db, token) is None:
        return HTMLResponse(PAGE.format("<h1>This link has expired or was already used</h1>"), status_code=404)
    return PAGE.format("<h1>Get Cheapr price alerts by email?</h1>"
                       f"<form method=post><input type=hidden name=token value='{html.escape(token, quote=True)}'>"
                       "<button style='font:600 16px system-ui;padding:12px 24px;border:0;border-radius:10px;background:#6941c6;color:#fff;cursor:pointer'>"
                       "Yes, send me alerts</button></form>")


@app.post("/api/v1/email/verify", response_class=HTMLResponse)
async def verify_email(request: Request):
    form = (await request.body()).decode()[:200]
    token = dict(p.split("=", 1) for p in form.split("&") if "=" in p).get("token", "")
    with Session.begin() as db:
        e = pending_consent(db, unquote_plus(token))
        if e is None:
            return HTMLResponse(PAGE.format("<h1>This link has expired or was already used</h1>"), status_code=404)
        e.verified_at, e.token = now(), secrets.token_urlsafe(32)  # single use
    return PAGE.format("<h1>Email confirmed ✓</h1><p>Cheapr will email you when a watched price drops.</p>")


@app.get("/api/v1/email/status")
def email_status(client_id: str = Query(pattern=UUID), email: str = Query(pattern=EMAIL, max_length=320), db=Depends(get_db)):
    e = find_consent(db, client_id, email)  # scoped to the asking install: no lookup oracle for other addresses
    return {"verified": bool(e and e.verified_at), "available": bool(os.environ.get("SMTP_HOST"))}


# ---------- telegram ----------

class ClientIn(BaseModel):
    client_id: str = Field(pattern=UUID)


@app.post("/api/v1/telegram/link")
def telegram_link(body: ClientIn, db=Depends(get_db)):
    bot = os.environ.get("TELEGRAM_BOT_USERNAME")
    if not bot or not os.environ.get("TELEGRAM_BOT_TOKEN"):
        raise HTTPException(503, "Telegram alerts are not configured on this server")
    link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == body.client_id))
    if link is None:
        link = TelegramLink(client_id=body.client_id, code=secrets.token_urlsafe(18))
        db.add(link)
    elif link.chat_id is None and now() - link.created_at > TG_CODE_TTL:
        link.code, link.created_at = secrets.token_urlsafe(18), now()  # expired codes are rotated
    return {"url": f"https://t.me/{bot}?start={link.code}", "connected": link.chat_id is not None}


@app.get("/api/v1/telegram/status")
def telegram_status(client_id: str = Query(pattern=UUID), db=Depends(get_db)):
    link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == client_id))
    return {"available": bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_BOT_USERNAME")),
            "connected": bool(link and link.chat_id)}


@app.delete("/api/v1/telegram/link")
def telegram_unlink(client_id: str = Query(pattern=UUID), db=Depends(get_db)):
    link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == client_id))
    if link:
        db.delete(link)
    return {"ok": True}


# ---------- coupons ----------

def coupon_scores(db, store: str) -> list[dict]:
    rows = db.execute(
        select(Coupon, func.count(CouponReport.id),
               func.coalesce(func.sum(case((CouponReport.worked, 1), else_=0)), 0),
               func.max(CouponReport.reported_at))
        .outerjoin(CouponReport, CouponReport.coupon_fk == Coupon.id)
        .where(Coupon.store == store, (Coupon.expires_at.is_(None)) | (Coupon.expires_at > now()))
        .group_by(Coupon.id)).all()
    out = [{"code": c.code, "description": c.description, "tries": n, "worked": int(ok),
            "score": round((ok + 1) / (n + 2), 3), "last_report": last.isoformat() + "Z" if last else None}
           for c, n, ok, last in rows if c.source != "user" or ok >= MIN_CONFIRMATIONS]
    return sorted(out, key=lambda c: -c["score"])


@app.get("/api/v1/coupons")
def coupons(store: str, db=Depends(get_db)):
    return coupon_scores(db, store.lower().removeprefix("www."))


class CouponReportIn(BaseModel):
    client_id: str = Field(pattern=UUID)
    store: str = Field(max_length=253)
    code: str = Field(pattern=CODE)
    worked: bool
    saving: float = Field(0, ge=0, lt=1e7)


@app.post("/api/v1/coupons/report")
def report_coupon(r: CouponReportIn, db=Depends(get_db)):
    store, code = r.store.lower().removeprefix("www."), r.code.upper()
    c = db.scalar(select(Coupon).where(Coupon.store == store, Coupon.code == code))
    if c is None:
        if not r.worked:
            return {"ok": True}  # don't store codes nobody has seen work
        c = Coupon(store=store, code=code, source="user")
        db.add(c)
        db.flush()
    if db.scalar(select(CouponReport.id).where(CouponReport.coupon_fk == c.id, CouponReport.client_id == r.client_id)):
        return {"ok": True}  # one vote per client per coupon
    db.add(CouponReport(coupon_fk=c.id, client_id=r.client_id, worked=r.worked, saving=r.saving))
    return {"ok": True}


class CouponIn(BaseModel):
    store: str = Field(max_length=253)
    code: str = Field(pattern=CODE)
    description: str = Field("", max_length=512)
    expires_at: datetime | None = None


def admin(x_admin_token: str = Header("")) -> None:
    token = os.environ.get("ADMIN_TOKEN")
    if not token or not secrets.compare_digest(x_admin_token.encode(), token.encode()):
        raise HTTPException(403, "admin token required")


@app.post("/api/v1/coupons", dependencies=[Depends(admin)])
def add_coupon(c: CouponIn, db=Depends(get_db)):
    store, code = c.store.lower().removeprefix("www."), c.code.upper()
    row = db.scalar(select(Coupon).where(Coupon.store == store, Coupon.code == code)) or Coupon(store=store, code=code)
    row.description, row.expires_at, row.source = c.description, c.expires_at, "admin"
    db.add(row)
    return {"ok": True}


# ---------- admin ----------

@app.get("/admin", include_in_schema=False)
def admin_page():
    return FileResponse(Path(__file__).parent / "static" / "admin.html", headers={"Cache-Control": "no-store"})


@app.get("/api/v1/admin/stats", dependencies=[Depends(admin)])
def admin_stats(db=Depends(get_db)):
    n = lambda q: db.scalar(q) or 0  # noqa: E731
    week, day = now() - timedelta(days=7), now() - timedelta(days=1)
    reports = n(select(func.count(CouponReport.id)))
    worked = n(select(func.count(CouponReport.id)).where(CouponReport.worked.is_(True)))
    return {
        "products": n(select(func.count(Product.id))),
        "products_7d": n(select(func.count(Product.id)).where(Product.id.in_(
            select(Price.product_fk).group_by(Price.product_fk).having(func.min(Price.observed_at) >= week)))),
        "prices": n(select(func.count(Price.id))),
        "prices_24h": n(select(func.count(Price.id)).where(Price.observed_at >= day)),
        "watches": n(select(func.count(Watch.id)).where(Watch.triggered_at.is_(None))),
        "clients": n(select(func.count(func.distinct(Watch.client_id)))),
        "alerts_7d": n(select(func.count(Watch.id)).where(Watch.triggered_at >= week)),
        "coupons": n(select(func.count(Coupon.id))),
        "coupons_user": n(select(func.count(Coupon.id)).where(Coupon.source == "user")),
        "reports": reports, "report_success": worked / reports if reports else 0,
        "recent_drops": [r for r in admin_product_rows(db, limit=200) if r["change"] < 0][:10],
    }


def admin_product_rows(db, q: str = "", limit: int = 100) -> list[dict]:
    stmt = select(Product).order_by(Product.updated_at.desc()).limit(limit)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(func.lower(Product.title).like(like) | func.lower(Product.product_id).like(like))
    products = db.scalars(stmt).all()
    ids = [p.id for p in products]
    agg = {pid: (lo, hi, cnt) for pid, lo, hi, cnt in db.execute(
        select(Price.product_fk, func.min(Price.price), func.max(Price.price), func.count(Price.id))
        .where(Price.product_fk.in_(ids)).group_by(Price.product_fk))} if ids else {}
    watchers = dict(db.execute(select(Watch.product_fk, func.count(Watch.id)).where(Watch.product_fk.in_(ids))
                               .group_by(Watch.product_fk)).all()) if ids else {}
    rows = []
    for p in products:
        lo, hi, cnt = agg.get(p.id, (p.last_price, p.last_price, 0))
        prev = db.scalar(select(Price.price).where(Price.product_fk == p.id, Price.price != p.last_price)
                         .order_by(Price.observed_at.desc()).limit(1))
        rows.append({"store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url, "price": p.last_price,
                     "change": round((p.last_price / prev - 1) * 100) if prev else 0, "min": lo, "max": hi,
                     "points": cnt, "watchers": watchers.get(p.id, 0), "updated_at": p.updated_at.isoformat() + "Z"})
    return rows


@app.get("/api/v1/admin/products", dependencies=[Depends(admin)])
def admin_products(q: str = Query("", max_length=100), db=Depends(get_db)):
    return admin_product_rows(db, q.strip())


@app.get("/api/v1/admin/coupons", dependencies=[Depends(admin)])
def admin_coupons(store: str = Query("", max_length=253), db=Depends(get_db)):
    stmt = (select(Coupon, func.count(CouponReport.id), func.coalesce(func.sum(case((CouponReport.worked, 1), else_=0)), 0))
            .outerjoin(CouponReport, CouponReport.coupon_fk == Coupon.id).group_by(Coupon.id))
    if store:
        stmt = stmt.where(Coupon.store == store.lower().removeprefix("www."))
    out = [{"id": c.id, "store": c.store, "code": c.code, "description": c.description, "source": c.source,
            "tries": n, "worked": int(ok), "score": round((ok + 1) / (n + 2), 3),
            "expires_at": c.expires_at.isoformat() if c.expires_at else None,
            "listed": c.source != "user" or ok >= MIN_CONFIRMATIONS} for c, n, ok in db.execute(stmt).all()]
    return sorted(out, key=lambda c: -c["score"])


@app.delete("/api/v1/admin/coupons/{coupon_id}", dependencies=[Depends(admin)])
def admin_delete_coupon(coupon_id: int, db=Depends(get_db)):
    c = db.get(Coupon, coupon_id)
    if c is None:
        raise HTTPException(404, "not found")
    db.execute(CouponReport.__table__.delete().where(CouponReport.coupon_fk == coupon_id))
    db.delete(c)
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}
