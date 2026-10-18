// node --test extension/test/*.test.mjs  (stub DOM: selector -> element map; no jsdom needed)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

new Function(readFileSync(new URL("../lib/extract.js", import.meta.url), "utf8"))();
const { parsePrice, extractProduct } = globalThis.CheaprExtract;

const doc = (map, ld = []) => ({
  title: "",
  querySelector: (s) => (s in map ? { textContent: map[s], getAttribute: () => map[s] } : null),
  querySelectorAll: (s) => (s.includes("ld+json") ? ld.map((j) => ({ textContent: JSON.stringify(j) })) : []),
});

test("parsePrice handles Indian grouping and junk", () => {
  assert.equal(parsePrice("₹1,23,456.50"), 123456.5);
  assert.equal(parsePrice("Rs. 999"), 999);
  assert.equal(parsePrice("free"), null);
  assert.equal(parsePrice("₹0"), null);
});

test("amazon: ASIN from URL, price from selector, OOS text", () => {
  const p = extractProduct(doc({ ".priceToPay .a-offscreen": "₹54,999.00", "#productTitle": " Phone X ",
    "#availability .a-color-price": "Currently unavailable." }), "https://www.amazon.in/Phone-X/dp/B0ABCDEF12/ref=x?th=1");
  assert.deepEqual([p.store, p.product_id, p.price, p.title, p.in_stock, p.url],
    ["amazon", "B0ABCDEF12", 54999, "Phone X", false, "https://www.amazon.in/Phone-X/dp/B0ABCDEF12/ref=x"]);
});

test("flipkart: pid + JSON-LD inside @graph", () => {
  const ld = [{ "@graph": [{ "@type": "Product", name: "Shoe", offers: { price: "1299", priceCurrency: "INR",
    availability: "https://schema.org/InStock" } }] }];
  const p = extractProduct(doc({}, ld), "https://www.flipkart.com/shoe/p/itmabc123?pid=SHOEABC&lid=x");
  assert.deepEqual([p.product_id, p.price, p.title, p.in_stock, p.url],
    ["SHOEABC", 1299, "Shoe", true, "https://www.flipkart.com/shoe/p/itmabc123?pid=SHOEABC"]);
});

test("non-product pages and unknown stores return null", () => {
  assert.equal(extractProduct(doc({}), "https://www.amazon.in/gp/cart/view.html"), null);
  assert.equal(extractProduct(doc({ ".pdp-price strong": "₹10" }), "https://example.com/123456/buy"), null);
});
