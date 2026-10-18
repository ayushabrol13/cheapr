import json
from contextlib import asynccontextmanager
import logging
import os
import smtplib
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select

from .models import Base, Coupon, CouponReport, Price, Product, Session, Watch, engine, now

log = logging.getLogger("cheapr")

# Store key -> hostnames its product URLs must live on (stops observations for one store polluting another).
STORES = {"amazon": ("amazon.in",), "flipkart": ("flipkart.com",), "myntra": ("myntra.com",), "ajio": ("ajio.com",)}
DEDUPE_WINDOW = timedelta(hours=6)
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


app = FastAPI(title="Cheapr API", version="0.1.0", lifespan=lifespan)


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
    host = (urlparse(url).hostname or "").lower()
    return store in STORES and any(host == h or host.endswith("." + h) for h in STORES[store])


def find_product(db, store: str, product_id: str) -> Product | None:
    return db.scalar(select(Product).where(Product.store == store, Product.product_id == product_id))


@app.post("/api/v1/observations")
def observe(o: Observation, bg: BackgroundTasks, db=Depends(get_db)):
    # shortcut: crowd-submitted prices are trusted after a host check; add per-client rate limits before going public
    if not host_ok(o.store, o.url):
        raise HTTPException(422, "url does not belong to store")
    p = find_product(db, o.store, o.product_id)
    if p is None:
        p = Product(store=o.store, product_id=o.product_id, url=o.url, last_price=o.price)
        db.add(p)
        db.flush()
    last = db.scalar(select(Price).where(Price.product_fk == p.id).order_by(Price.observed_at.desc()).limit(1))
    if not (last and last.price == o.price and last.in_stock == o.in_stock and now() - last.observed_at < DEDUPE_WINDOW):
        db.add(Price(product_fk=p.id, price=o.price, mrp=o.mrp, in_stock=o.in_stock))
    p.title, p.image, p.currency = o.title or p.title, o.image or p.image, o.currency
    p.last_price, p.updated_at = o.price, now()
    if o.in_stock:
        trigger_watches(db, p, bg)
    return {"ok": True}


def trigger_watches(db, p: Product, bg: BackgroundTasks) -> None:
    hits = db.scalars(select(Watch).where(Watch.product_fk == p.id, Watch.triggered_at.is_(None),
                                          Watch.target_price >= p.last_price))
    for w in hits:
        w.triggered_at, w.triggered_price = now(), p.last_price
        if w.email:
            bg.add_task(send_email, w.email, p.title, p.url, p.last_price, p.currency)


def verdict(prices: list[float]) -> str:
    if len(prices) < 3:
        return "not-enough-data"
    cur, lo, avg = prices[-1], min(prices), sum(prices) / len(prices)
    if cur <= lo * 1.02:
        return "lowest"
    if cur < avg * 0.97:
        return "good"
    if cur > avg * 1.05:
        return "high"
    return "fair"


@app.get("/api/v1/products/{store}/{product_id}/history")
def history(store: str, product_id: str, days: int = 90, db=Depends(get_db)):
    p = find_product(db, store, product_id)
    if p is None:
        raise HTTPException(404, "unknown product")
    since = now() - timedelta(days=max(1, min(days, 730)))
    rows = db.scalars(select(Price).where(Price.product_fk == p.id, Price.observed_at >= since)
                      .order_by(Price.observed_at)).all()
    prices = [r.price for r in rows if r.in_stock]
    return {
        "product": {"store": p.store, "product_id": p.product_id, "title": p.title, "url": p.url,
                    "image": p.image, "currency": p.currency, "price": p.last_price},
        "points": [{"t": r.observed_at.isoformat() + "Z", "price": r.price, "in_stock": r.in_stock} for r in rows],
        "stats": {"min": min(prices, default=None), "max": max(prices, default=None),
                  "avg": round(sum(prices) / len(prices), 2) if prices else None, "count": len(rows)},
        "verdict": verdict(prices),
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
    trigger_watches(db, p, bg)
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


def send_email(to: str, title: str, url: str, price: float, currency: str) -> None:
    host = os.environ.get("SMTP_HOST")
    if not host:
        return
    msg = EmailMessage()
    msg["Subject"] = f"Price drop: {title[:80]} is now {currency} {price:,.0f}"
    msg["From"] = os.environ.get("SMTP_FROM", "cheapr@localhost")
    msg["To"] = to
    msg.set_content(f"{title}\n\nNow {currency} {price:,.2f}, at or below your target.\n\n{url}\n\n- Cheapr")
    try:
        with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
            s.starttls()
            if os.environ.get("SMTP_USER"):
                s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
            s.send_message(msg)
    except Exception:
        log.exception("alert email failed")


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
           for c, n, ok, last in rows]
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
