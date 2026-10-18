import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";

for (const f of ["../lib/extract.js", "../lib/compare.js"]) new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
const { CheaprCompare: C, CheaprExtract: X } = globalThis;
const load = (n) => {
  const h = gunzipSync(readFileSync(new URL(`fixtures/${n}.html.gz`, import.meta.url))).toString();
  return { doc: parseHTML(h).document, url: h.match(/^<!-- (\S+) -->/)[1] };
};
const product = (n) => { const { doc, url } = load(n); return X.extractProduct(doc, url); };

test("Amazon product finds the same item on a real Flipkart search page", () => {
  const p = product("amazon-B0FC2YFSN4");
  assert.equal(C.query(p), "boat airdopes 219");
  const m = C.bestMatch(p, C.parseSearch("flipkart", load("search-flipkart-boat-airdopes-219").doc));
  assert.equal(m.product_id, "ACCHCJW3JXTHN4HH");
  assert.equal(m.price, 879);
  assert.match(m.url, /^https:\/\/www\.flipkart\.com\/.+\?pid=ACCHCJW3JXTHN4HH$/);
});

test("no confident match means no claim (real Amazon page without the model)", () => {
  const p = product("flipkart-ACCG6DS7WDJHGWSH"); // Airdopes 161/163; this result page only has other models
  const cands = C.parseSearch("amazon", load("search-amazon-boat-airdopes-161").doc);
  assert.ok(cands.length > 10 && cands.every((c) => /^[A-Z0-9]{10}$/.test(c.product_id) && c.price > 0));
  assert.equal(C.bestMatch(p, cands), null);
});

test("identity rules reject look-alikes", () => {
  const s = "Samsung Galaxy S25 5G (Icy Blue, 12GB RAM, 256GB Storage)";
  assert.ok(C.score(s, "Samsung Galaxy S25 5G (Navy, 12GB RAM, 256GB Storage)") >= 0.6); // colour variant: same price class
  assert.equal(C.score(s, "Samsung Galaxy S25 5G (Icy Blue, 12GB RAM, 512GB Storage)"), 0); // capacity differs
  assert.equal(C.score(s, "Samsung Galaxy S24 5G (Icy Blue, 256GB)"), 0); // model differs
  assert.equal(C.score(s, "Apple iPhone 16 (256GB)"), 0); // brand differs
});
