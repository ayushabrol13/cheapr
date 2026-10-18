import html
import json
from contextlib import asynccontextmanager
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote_plus, urlparse

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .insights import Point, analyze
from .migrate import upgrade
from .alerts import send_alert, send_verification
from .models import Coupon, CouponReport, Price, Product, Session, TelegramLink, Watch, EmailAddress, EmailSend, EmailThrottle, engine, now

log = logging.getLogger("cheapr")

# Store key -> hostnames its product URLs must live on (stops observations for one store polluting another).
STORES = {"amazon": ("amazon.in",), "flipkart": ("flipkart.com",), "myntra": ("myntra.com",), "ajio": ("ajio.com",)}
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
        ip = request.client.host if request.client else "?"
        if os.environ.get("TRUST_PROXY") and request.headers.get("x-forwarded-for"):
            ip = request.headers["x-forwarded-for"].split(",")[-1].strip()  # right-most = added by our proxy, not the client
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


def get_db():
    with Session.begin() as db:
        yield db


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


def host_ok(store: str, url: str) -> bool:
    u = urlparse(url)
    if u.scheme != "https" or u.username or u.password or "\\" in url or any(ord(ch) < 33 for ch in url):
        return False
    host = (u.hostname or "").lower()
    return store in STORES and any(host == h or host.endswith("." + h) for h in STORES[store])


def find_product(db, store: str, product_id: str) -> Product | None:
    return db.scalar(select(Product).where(Product.store == store, Product.product_id == product_id))


@app.post("/api/v1/observations")
def observe(o: Observation, bg: BackgroundTasks, db=Depends(get_db)):
    if not host_ok(o.store, o.url):
        raise HTTPException(422, "url does not belong to store")
    p = find_product(db, o.store, o.product_id)
    if p is not None and not (p.last_price * MAX_SWING[0] <= o.price <= p.last_price * MAX_SWING[1]):
        raise HTTPException(422, "price differs too much from recent history")
    if p is None:
        p = Product(store=o.store, product_id=o.product_id, url=o.url, last_price=o.price)
        db.add(p)
        db.flush()
    p.title, p.image, p.currency = o.title or p.title, o.image or p.image, o.currency
    for alert in record_price(db, p, o.price, o.mrp, o.in_stock):
        bg.add_task(send_alert, alert)
    return {"ok": True}


def record_price(db, p: Product, price: float, mrp: float | None, in_stock: bool) -> list[dict]:
    """Store a price point (deduped) and fire watches. Returns alerts to deliver. Shared by the API and the worker."""
    if mrp is not None and not (price <= mrp <= price * 20):
        mrp = None  # implausible MRP: keep the price, drop the MRP
    last = db.scalar(select(Price).where(Price.product_fk == p.id).order_by(Price.observed_at.desc()).limit(1))
    if not (last and last.price == price and last.in_stock == in_stock and now() - last.observed_at < DEDUPE_WINDOW):
        db.add(Price(product_fk=p.id, price=price, mrp=mrp, in_stock=in_stock))
    p.last_price, p.updated_at = price, now()
    return trigger_watches(db, p) if in_stock else []


def find_consent(db, client_id: str, email: str) -> EmailAddress | None:
    return db.scalar(select(EmailAddress).where(EmailAddress.client_id == client_id, EmailAddress.email == email.lower()))


def lock_address(db, email: str) -> None:
    """Serialise budget checks for one address: upsert its lock row, then row-lock it (FOR UPDATE on Postgres;
    SQLite serialises writers anyway). Callers lock several addresses in sorted order to avoid deadlocks."""
    ins = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    db.execute(ins(EmailThrottle).values(email=email).on_conflict_do_nothing())
    db.execute(select(EmailThrottle).where(EmailThrottle.email == email).with_for_update())


def sends_since(db, email: str, kind: str, since: datetime, client_id: str | None = None) -> int:
    q = select(func.count(EmailSend.id)).where(EmailSend.email == email, EmailSend.kind == kind, EmailSend.sent_at >= since)
    if client_id:
        q = q.where(EmailSend.client_id == client_id)
    return db.scalar(q) or 0


def take_alert_slot(db, client_id: str, email: str) -> bool:
    """Count one alert against the address's rolling-24h cap; False when the cap is reached."""
    lock_address(db, email)
    if sends_since(db, email, "alert", now() - timedelta(days=1)) >= ALERTS_PER_DAY:
        return False
    db.add(EmailSend(email=email, client_id=client_id, kind="alert", sent_at=now()))
    return True


def take_verify_slot(db, client_id: str, email: str) -> bool:
    """Reserve a confirmation mail: at most 1/hour and 3/rolling-day per address, whichever install asks.
    Trade-off (deliberate): never mailing non-consenting inboxes beats guaranteed opt-in, so a stranger who keeps
    requesting confirmations for an address can stall its owner; per-IP rate limits and Telegram mitigate that."""
    lock_address(db, email)
    t, (gap, per_day) = now(), VERIFY_PER_ADDRESS
    if sends_since(db, email, "verify", t - gap) or sends_since(db, email, "verify", t - timedelta(days=1)) >= per_day:
        return False
    db.add(EmailSend(email=email, client_id=client_id, kind="verify", sent_at=t))
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
    """Mark watches at/below target as triggered. notify=False (saving a watch) flags without spending mail budget."""
    alerts = []
    hits = db.scalars(select(Watch).where(Watch.product_fk == p.id, Watch.triggered_at.is_(None),
                                          Watch.target_price >= p.last_price)
                      .order_by(func.lower(func.coalesce(Watch.email, "")), Watch.id)).all()  # fixed lock order
    for w in hits:
        w.triggered_at, w.triggered_price = now(), p.last_price
        if not notify:
            continue
        link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == w.client_id, TelegramLink.chat_id.is_not(None)))
        alerts.append({"title": p.title, "url": p.url, "price": p.last_price, "target": w.target_price,
                       "email": w.email if w.email and email_allowed(db, w.client_id, w.email) else None,
                       "chat_id": link.chat_id if link else None})
    return alerts


@app.get("/api/v1/products/{store}/{product_id}/history")
def history(store: str, product_id: str, days: int = 90, db=Depends(get_db)):
    p = find_product(db, store, product_id)
    if p is None:
        raise HTTPException(404, "unknown product")
    rows = db.scalars(select(Price).where(Price.product_fk == p.id, Price.observed_at >= now() - timedelta(days=730))
                      .order_by(Price.observed_at)).all()
    mrps = sorted(r.mrp for r in rows[-7:] if r.mrp)
    mrp = mrps[len(mrps) // 2] if mrps else None  # median of recent reports: one bogus MRP can't drive the insight
    result = analyze([Point(r.observed_at, r.price, r.in_stock) for r in rows], mrp, now(), max(7, min(days, 365)))
    return {
        "product": {"store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url,
                    "image": p.image, "currency": p.currency, "price": p.last_price, "mrp": mrp},
        "points": [{"t": r.observed_at.isoformat() + "Z", "price": r.price, "in_stock": r.in_stock} for r in rows],
        **result,
    }


# ---------- watchlist & alerts ----------

class WatchIn(BaseModel):
    client_id: str = Field(pattern=UUID)
    store: str = Field(max_length=32)
    product_id: str = Field(max_length=64)
    target_price: float = Field(gt=0, lt=1e8)
    email: str | None = Field(None, pattern=EMAIL, max_length=320)


def watch_out(w: Watch, p: Product) -> dict:
    return {"id": w.id, "store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url,
            "image": p.image, "price": p.last_price, "target_price": w.target_price,
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
    w.target_price, w.email, w.triggered_at, w.triggered_price = body.target_price, body.email, None, None
    db.flush()
    trigger_watches(db, p, notify=False)  # already below target: flag it, but never send on save (spam relay)
    if body.email:
        request_verification(db, body.client_id, body.email, bg)
    return watch_out(w, p)


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
