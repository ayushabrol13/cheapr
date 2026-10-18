// Regression tests against real product pages saved from the live stores (scripts/styles stripped, gzipped).
// Refresh a fixture: dump the page with Playwright, then `python3 test/save-fixture.py <dump> <store-id>`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";

new Function(readFileSync(new URL("../lib/extract.js", import.meta.url), "utf8"))();
const { extractProduct } = globalThis.CheaprExtract;

function load(name) {
  const html = gunzipSync(readFileSync(new URL(`fixtures/${name}.html.gz`, import.meta.url))).toString();
  return extractProduct(parseHTML(html).document, html.match(/^<!-- (\S+) -->/)[1]);
}

const CASES = {
  "amazon-B0FC2YFSN4": { product_id: "B0FC2YFSN4", price: 867, mrp: 3990, in_stock: true, title: /^boAt Airdopes 219/ },
  "flipkart-ACCG6DS7WDJHGWSH": { product_id: "ACCG6DS7WDJHGWSH", price: 799, in_stock: true, title: /^boAt Airdopes 161/ },
  "myntra-35840604": { product_id: "35840604", price: 671, mrp: 1399, in_stock: true, title: /^ADIDAS 3-Stripes/i },
  "ajio-443397799_grey": { product_id: "443397799_grey", price: 139, mrp: 199, in_stock: true, title: /^Shein Men/ },
};

for (const [name, want] of Object.entries(CASES)) {
  test(`real page: ${name}`, () => {
    const p = load(name);
    assert.ok(p, "product detected");
    for (const [k, v] of Object.entries(want)) v instanceof RegExp ? assert.match(p[k], v) : assert.equal(p[k], v, k);
    assert.match(p.image, /^https:\/\//);
    assert.ok(!p.url.includes("?") || p.store === "flipkart", "tracking params stripped");
  });
}
