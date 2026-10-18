"""The worker's extractor must agree with the extension's on the same real store pages."""
import gzip
from pathlib import Path

import pytest

from app.extract import extract_price, parse_price

FIXTURES = Path(__file__).parents[2] / "extension" / "test" / "fixtures"
CASES = {  # same expectations as extension/test/fixtures.test.mjs
    "amazon-B0FC2YFSN4": ("amazon", 867, 3990),
    "flipkart-ACCG6DS7WDJHGWSH": ("flipkart", 799, None),
    "myntra-35840604": ("myntra", 671, 1399),
    "ajio-443397799_grey": ("ajio", 139, 199),
}


@pytest.mark.parametrize("name", CASES)
def test_real_pages(name):
    store, price, mrp = CASES[name]
    got = extract_price(store, gzip.decompress((FIXTURES / f"{name}.html.gz").read_bytes()).decode())
    assert got == {"price": price, "mrp": mrp, "in_stock": True}


def test_parse_price():
    assert parse_price("₹1,23,456.50") == 123456.5
    assert parse_price("free") is None
