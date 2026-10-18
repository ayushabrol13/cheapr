import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

const load = (f) => new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
globalThis.chrome = { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } }, runtime: { sendMessage: async () => ({}) } };
load("../lib/i18n.js");

test("every English string has a Hindi translation with the same placeholders", () => {
  const { en, hi } = globalThis.CheaprI18n.STRINGS;
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const k of Object.keys(en)) {
    assert.ok(hi[k], `missing hi: ${k}`);
    assert.equal(ph(hi[k]), ph(en[k]), `placeholders differ: ${k}`);
  }
});

test("t() interpolates and falls back to English", () => {
  const { t } = globalThis.CheaprI18n;
  assert.equal(t("alert_at", { price: "₹500" }), "Alert at ₹500");
  assert.equal(t("no_such_key"), "no_such_key");
});

test("Amazon wishlist parser reads items, skips priceless ones", () => {
  const { document } = parseHTML(`<ul id="g-items">
    <li data-itemid="I1" data-price="1299.0"><a id="itemName_I1" href="/boAt-Airdopes/dp/B0FC2YFSN4/ref=x" title="boAt Airdopes 219">boAt Airdopes 219</a><img src="https://m.media-amazon.com/a.jpg"></li>
    <li data-itemid="I2" data-price="-Infinity"><a id="itemName_I2" href="/dp/B0ZZZZZZZ1">Unavailable thing</a></li>
    <li data-itemid="I3"><a id="itemName_I3" href="/dp/B0YYYYYYY2">Has offscreen price</a><span class="a-price"><span class="a-offscreen">₹2,499.00</span></span></li>
  </ul>`);
  globalThis.window = { __cheaprWishlist: false };
  globalThis.location = new URL("https://www.amazon.in/gp/cart/view.html"); // not a wishlist page: script stays idle
  globalThis.CheaprFormat = { t: (k) => k };
  globalThis.CheaprI18n.load = async () => "en";
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // the content script polls for SPA navigation; don't keep the test process alive
  try { load("../content/wishlist.js"); } finally { globalThis.setInterval = realInterval; }
  const items = globalThis.CheaprWishlist.parseAmazon(document);
  assert.deepEqual(items.map((i) => [i.product_id, i.price]), [["B0FC2YFSN4", 1299], ["B0YYYYYYY2", 2499]]);
  assert.equal(items[0].url, "https://www.amazon.in/dp/B0FC2YFSN4");
});
