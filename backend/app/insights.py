"""Price analysis: verdict + shopper-facing insights from a product's price observations.

Observations are change points (the backend dedupes repeats), so averages are time-weighted:
each price counts for as long as it was the live price.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta

MIN_POINTS, MIN_SPAN = 3, timedelta(days=7)  # below this, any verdict would be noise


@dataclass
class Point:
    t: datetime
    price: float
    in_stock: bool = True


def weighted_avg(points: list[Point], start: datetime, end: datetime) -> float | None:
    """Time-weighted mean of the step function defined by points over [start, end]."""
    total = weight = 0.0
    for i, p in enumerate(points):
        seg_start = max(p.t, start)
        seg_end = min(points[i + 1].t if i + 1 < len(points) else end, end)
        if seg_end > seg_start:
            secs = (seg_end - seg_start).total_seconds()
            total += p.price * secs
            weight += secs
    return round(total / weight, 2) if weight else None


def analyze(points: list[Point], mrp: float | None, now: datetime, window_days: int = 90) -> dict:
    ps = [p for p in points if p.in_stock]
    if not ps:
        return {"verdict": "new", "stats": {}, "insights": []}
    cur = ps[-1].price
    since = now - timedelta(days=window_days)
    win = [p for p in ps if p.t >= since] or ps[-1:]
    # the price that was live when the window opened also belongs to the window
    before = [p for p in ps if p.t < since]
    win_prices = [p.price for p in ([before[-1]] if before else []) + win]
    stats = {
        "current": cur,
        "low": min(win_prices), "high": max(win_prices),
        "avg": weighted_avg(ps, since, now),
        "all_time_low": min(p.price for p in ps), "all_time_high": max(p.price for p in ps),
        "first_seen": ps[0].t.isoformat() + "Z", "observations": len(ps),
    }
    insights: list[dict] = []
    if len(ps) < MIN_POINTS or now - ps[0].t < MIN_SPAN:
        return {"verdict": "new", "stats": stats, "insights": insights}

    avg = stats["avg"] or cur
    if cur <= stats["all_time_low"] * 1.01:
        verdict = "buy"
        insights.append({"kind": "all_time_low"})
    elif cur <= avg * 0.95:
        verdict = "good"
    elif cur >= avg * 1.05:
        verdict = "wait"
    else:
        verdict = "fair"
    if verdict != "buy" and cur <= stats["low"]:
        insights.append({"kind": "window_low", "days": window_days})

    run = len(ps) - 1  # start of the trailing run at today's price (repeats are stored every few hours)
    while run > 0 and ps[run - 1].price == cur:
        run -= 1

    # "Raised before the sale": a recent peak well above the pre-hike norm, and today's price back near that norm.
    peak = max((p.price for p in ps[:run] if p.t >= now - timedelta(days=30)), default=None)
    base = weighted_avg(ps, now - timedelta(days=90), now - timedelta(days=30))
    if base and peak and peak >= base * 1.15 and base * 0.97 <= cur < peak * 0.95:
        insights.append({"kind": "inflated_sale", "peak": peak, "usual": base})

    if mrp and stats["observations"] >= 5 and mrp >= stats["all_time_high"] * 1.3:
        insights.append({"kind": "inflated_mrp", "mrp": mrp, "highest": stats["all_time_high"],
                         "real_discount_pct": max(0, round((1 - cur / avg) * 100))})

    if run > 0:
        prev = ps[run - 1].price
        insights.append({"kind": "drop" if cur < prev else "rise", "from": prev,
                         "pct": round(abs(cur - prev) / prev * 100), "since": ps[run].t.isoformat() + "Z"})
    return {"verdict": verdict, "stats": stats, "insights": insights}
