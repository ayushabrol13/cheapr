import json
from contextlib import asynccontextmanager
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select

from .insights import Point, analyze
from .alerts import send_alert
from .models import Base, Coupon, CouponReport, Price, Product, Session, TelegramLink, Watch, engine, now

log = logging.getLogger("cheapr")

# Store key -> hostnames its product URLs must live on (stops observations for one store polluting another).
STORES = {"amazon": ("amazon.in",), "flipkart": ("flipkart.com",), "myntra": ("myntra.com",), "ajio": ("ajio.com",)}
DEDUPE_WINDOW = timedelta(hours=6)
MAX_SWING = (0.2, 5.0)  # an observation outside 20%..500% of the last price is treated as bogus
MIN_CONFIRMATIONS = 2  # distinct clients before a user-submitted coupon is listed
UUID = r"^[0-9a-fA-F-]{36}$"
CODE = r"^[A-Za-z0-9_-]{2,40}$"
EMAIL = r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]+$"

def startup() -> None:
    Base.metadata.create_all(engine)
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


def trigger_watches(db, p: Product) -> list[dict]:
    alerts = []
    hits = db.scalars(select(Watch).where(Watch.product_fk == p.id, Watch.triggered_at.is_(None),
                                          Watch.target_price >= p.last_price)).all()
    for w in hits:
        w.triggered_at, w.triggered_price = now(), p.last_price
        link = db.scalar(select(TelegramLink).where(TelegramLink.client_id == w.client_id, TelegramLink.chat_id.is_not(None)))
        # shortcut: emails go to unverified addresses; add double opt-in before opening the server to the public
        alerts.append({"title": p.title, "url": p.url, "price": p.last_price, "target": w.target_price,
                       "email": w.email, "chat_id": link.chat_id if link else None})
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
def add_watch(body: WatchIn, db=Depends(get_db)):
    p = find_product(db, body.store, body.product_id)
    if p is None:
        raise HTTPException(404, "product not seen yet; open its page first")
    w = db.scalar(select(Watch).where(Watch.client_id == body.client_id, Watch.product_fk == p.id))
    if w is None:
        w = Watch(client_id=body.client_id, product_fk=p.id, target_price=body.target_price)
        db.add(w)
    w.target_price, w.email, w.triggered_at, w.triggered_price = body.target_price, body.email, None, None
    db.flush()
    trigger_watches(db, p)  # already below target: flag it, but never send alerts on save (spam relay)
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
        link = TelegramLink(client_id=body.client_id, code=secrets.token_urlsafe(16)[:24])
        db.add(link)
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
    if not token or x_admin_token != token:
        raise HTTPException(403, "admin token required")


@app.post("/api/v1/coupons", dependencies=[Depends(admin)])
def add_coupon(c: CouponIn, db=Depends(get_db)):
    store, code = c.store.lower().removeprefix("www."), c.code.upper()
    row = db.scalar(select(Coupon).where(Coupon.store == store, Coupon.code == code)) or Coupon(store=store, code=code)
    row.description, row.expires_at, row.source = c.description, c.expires_at, "admin"
    db.add(row)
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}
