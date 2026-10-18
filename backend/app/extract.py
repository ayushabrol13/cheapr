"""Server-side twin of extension/lib/extract.js, used by the worker to re-check watched products.

Kept deliberately parallel to the JS version; both are tested against the same saved store pages.
"""
import json
import re

from bs4 import BeautifulSoup

STORES = {
    "amazon": {
        "price": [".priceToPay .a-offscreen", "#corePrice_desktop .a-price .a-offscreen",
                  "#corePrice_feature_div .a-price .a-offscreen", "#priceblock_dealprice", "#priceblock_ourprice"],
        "mrp": [".basisPrice .a-offscreen", "#corePrice_desktop .a-text-price .a-offscreen"],
        "oos": ["#outOfStock", "#availability .a-color-price"],
    },
    "flipkart": {"price": [], "mrp": [], "oos": []},
    "myntra": {"price": [".pdp-price strong"], "mrp": [".pdp-mrp s"], "oos": [".size-buttons-out-of-stock"]},
    "ajio": {"price": [".prod-sp"], "mrp": [".prod-cp"], "oos": [".out-of-stock"]},
}


def parse_price(text) -> float | None:
    if text is None:
        return None
    m = re.search(r"\d+(?:\.\d+)?", str(text).replace(",", ""))
    n = float(m.group()) if m else 0
    return n if n > 0 else None


def _first(soup, selectors, read):
    for sel in selectors:
        el = soup.select_one(sel)
        v = el and read(el)
        if v:
            return v
    return None


def _ld_product(soup):
    def walk(node):
        if isinstance(node, list):
            return next((p for p in map(walk, node) if p), None)
        if not isinstance(node, dict):
            return None
        t = node.get("@type")
        if t == "Product" or (isinstance(t, list) and "Product" in t):
            return node
        return walk(node.get("@graph"))
    for s in soup.select('script[type="application/ld+json"]'):
        try:
            p = walk(json.loads(s.string or ""))
        except ValueError:
            continue
        if p:
            return p
    return None


def extract_price(store: str, html: str) -> dict | None:
    """Returns {price, mrp, in_stock} for a product page of a known store, or None if no price is found."""
    cfg = STORES.get(store)
    if cfg is None:
        return None
    soup = BeautifulSoup(html, "html.parser")
    ld = _ld_product(soup)
    offers = ld.get("offers") if ld else None
    offer = (offers[0] if isinstance(offers, list) and offers else offers) or {}
    text = lambda el: el.get_text(strip=True)  # noqa: E731
    price = (_first(soup, cfg["price"], lambda el: parse_price(text(el)))
             or parse_price(offer.get("price") or offer.get("lowPrice")))
    if not price:
        meta = soup.select_one('meta[property="product:price:amount"]')
        price = parse_price(meta.get("content") if meta else None)
    if not price:
        return None
    oos_text = _first(soup, cfg["oos"], text) or ""
    in_stock = not re.search(r"unavailable|out of stock|sold out", oos_text, re.I) \
        and "outofstock" not in str(offer.get("availability", "")).lower()
    return {"price": price, "mrp": _first(soup, cfg["mrp"], lambda el: parse_price(text(el))), "in_stock": in_stock}
