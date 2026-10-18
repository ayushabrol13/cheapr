import os
from datetime import datetime, timezone

from sqlalchemy import (BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, UniqueConstraint,
                        create_engine)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./cheapr.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
Session = sessionmaker(engine, expire_on_commit=False)


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC everywhere; SQLite drops tz


class Base(DeclarativeBase):
    pass


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("store", "product_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    store: Mapped[str] = mapped_column(String(32))
    product_id: Mapped[str] = mapped_column(String(64))
    url: Mapped[str] = mapped_column(String(2048))
    title: Mapped[str] = mapped_column(String(512), default="")
    image: Mapped[str] = mapped_column(String(2048), default="")
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    last_price: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)  # last accepted price
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # last worker attempt (success or not)
    needs_check: Mapped[bool] = mapped_column(Boolean, default=False)  # unconfirmed crowd price crossed a target


class Price(Base):
    __tablename__ = "prices"
    id: Mapped[int] = mapped_column(primary_key=True)
    product_fk: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    price: Mapped[float] = mapped_column(Float)
    mrp: Mapped[float | None] = mapped_column(Float, nullable=True)
    in_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    source: Mapped[str] = mapped_column(String(16), default="")  # hashed install id, "worker", or ""
    net: Mapped[str] = mapped_column(String(16), default="")  # hashed client network (/24 or /48): Sybil resistance
    suspect: Mapped[bool] = mapped_column(Boolean, default=False)  # outside the sanity band, awaiting a 2nd source


class Watch(Base):
    __tablename__ = "watches"
    __table_args__ = (UniqueConstraint("client_id", "product_fk"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    product_fk: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    target_price: Mapped[float] = mapped_column(Float)
    mode: Mapped[str] = mapped_column(String(8), default="target")  # target | any (re-arms on every new low)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    triggered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    triggered_price: Mapped[float | None] = mapped_column(Float, nullable=True)


class Coupon(Base):
    __tablename__ = "coupons"
    __table_args__ = (UniqueConstraint("store", "code"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    store: Mapped[str] = mapped_column(String(253), index=True)  # hostname, e.g. myntra.com
    code: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(String(512), default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="admin")  # admin | user


class CouponReport(Base):
    __tablename__ = "coupon_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    coupon_fk: Mapped[int] = mapped_column(ForeignKey("coupons.id"), index=True)
    client_id: Mapped[str] = mapped_column(String(64))
    worked: Mapped[bool] = mapped_column(Boolean)
    saving: Mapped[float] = mapped_column(Float, default=0)
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class TelegramLink(Base):
    """Links an anonymous client to a Telegram chat. code is the one-time /start payload."""
    __tablename__ = "telegram_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), unique=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class EmailAddress(Base):
    """Alert consent per (install, email): an address confirmed by one install doesn't authorise others."""
    __tablename__ = "email_addresses"
    __table_args__ = (UniqueConstraint("client_id", "email"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verify_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class EmailThrottle(Base):
    """One row per address (stored as a SHA-256 digest), used only as a lock for that address's budget checks."""
    __tablename__ = "email_throttle"
    email: Mapped[str] = mapped_column(String(320), primary_key=True)


class EmailSend(Base):
    """Append-only log of mails sent; budgets count rows in a rolling 24h window. email holds a SHA-256 digest,
    never the address, so the log can outlive a deletion request without keeping PII."""
    __tablename__ = "email_sends"
    __table_args__ = (Index("ix_email_sends_email_kind_at", "email", "kind", "sent_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320))
    client_id: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(8))  # verify | alert
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Sighting(Base):
    """Who (hashed network) saw which price, kept 24h for confirmation counting. History rows are deduped, so
    they can't tell us how many independent networks reported a price."""
    __tablename__ = "sightings"
    __table_args__ = (Index("ix_sightings_product_at", "product_fk", "seen_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    product_fk: Mapped[int] = mapped_column(ForeignKey("products.id"))
    net: Mapped[str] = mapped_column(String(16))
    price: Mapped[float] = mapped_column(Float)
    seen_at: Mapped[datetime] = mapped_column(DateTime, default=now)
