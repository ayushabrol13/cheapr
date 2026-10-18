from datetime import datetime, timedelta

from app.insights import Point, analyze, weighted_avg

NOW = datetime(2026, 10, 18)


def series(*pairs):
    """pairs of (days_ago, price) -> points, oldest first"""
    return [Point(NOW - timedelta(days=d), p) for d, p in sorted(pairs, key=lambda x: -x[0])]


def kinds(r):
    return [i["kind"] for i in r["insights"]]


def test_weighted_avg_counts_duration():
    # 1000 for 9 days, then 100 for 1 day -> weighted 910, not the naive 550
    assert weighted_avg(series((10, 1000), (1, 100)), NOW - timedelta(days=10), NOW) == 910


def test_new_until_enough_history():
    assert analyze(series((2, 100), (1, 90), (0, 95)), None, NOW)["verdict"] == "new"
    assert analyze(series((30, 100), (20, 90)), None, NOW)["verdict"] == "new"


def test_all_time_low_is_buy():
    r = analyze(series((60, 1200), (30, 1100), (10, 1150), (1, 999)), None, NOW)
    assert r["verdict"] == "buy" and "all_time_low" in kinds(r)
    drop = next(i for i in r["insights"] if i["kind"] == "drop")
    assert drop["from"] == 1150 and drop["pct"] == 13


def test_wait_when_above_usual():
    assert analyze(series((80, 1000), (40, 1000), (5, 1000), (2, 1200)), None, NOW)["verdict"] == "wait"


def test_detects_price_raised_before_sale():
    # usual 1000 for months, hiked to 1500 three weeks ago, now "on sale" at 1010: roughly the usual price
    r = analyze(series((85, 1000), (60, 1000), (21, 1500), (3, 1010)), None, NOW)
    sale = next(i for i in r["insights"] if i["kind"] == "inflated_sale")
    assert sale["peak"] == 1500 and 990 <= sale["usual"] <= 1010


def test_detects_inflated_mrp():
    r = analyze(series((80, 500), (60, 520), (40, 510), (20, 500), (1, 499)), 1999, NOW)
    mrp = next(i for i in r["insights"] if i["kind"] == "inflated_mrp")
    assert mrp["highest"] == 520


def test_out_of_stock_points_ignored():
    pts = series((30, 100), (20, 90), (10, 95))
    pts.append(Point(NOW - timedelta(days=1), 10, in_stock=False))
    assert analyze(pts, None, NOW)["stats"]["current"] == 95


def test_inflated_sale_is_never_called_a_good_deal():
    r = analyze(series((85, 1000), (60, 1000), (21, 1500), (12, 1450), (3, 990)), None, NOW)
    assert "inflated_sale" in kinds(r) and r["verdict"] in ("fair", "buy")


def test_flat_price_is_not_lowest_ever():
    r = analyze(series((10, 500), (5, 500), (1, 500)), None, NOW)
    assert r["verdict"] == "fair" and kinds(r) == ["stable"]
