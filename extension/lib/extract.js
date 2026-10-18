// Shared product extraction. Classic script (content scripts can't be modules); used by
// content/product.js on live pages and by offscreen.js on fetched HTML.
(() => {
  const STORES = {
    amazon: {
      hosts: ["amazon.in"],
      id: (u) => u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/)?.[1],
      price: [".priceToPay .a-offscreen", "#corePrice_desktop .a-price .a-offscreen",
              "#corePrice_feature_div .a-price .a-offscreen", "#priceblock_dealprice", "#priceblock_ourprice"],
      mrp: [".basisPrice .a-offscreen", "#corePrice_desktop .a-text-price .a-offscreen"],
      title: ["#productTitle"],
      image: ["#landingImage", "#imgBlkFront"],
      oos: ["#outOfStock", "#availability .a-color-price"],
    },
    flipkart: {
      hosts: ["flipkart.com"],
      id: (u) => u.searchParams.get("pid") || u.pathname.match(/\/p\/(itm[0-9a-z]+)/i)?.[1],
      price: [], mrp: [], title: [], image: [], oos: [], // obfuscated classes: JSON-LD/meta only
    },
    myntra: {
      hosts: ["myntra.com"],
      id: (u) => u.pathname.match(/\/(\d{5,})\/buy/)?.[1],
      price: [".pdp-price strong"],
      mrp: [".pdp-mrp s"],
      brand: [".pdp-title"],
      title: [".pdp-name"],
      image: [".image-grid-image"],
      oos: [".size-buttons-out-of-stock"],
    },
    ajio: {
      hosts: ["ajio.com"],
      id: (u) => u.pathname.match(/\/p\/([0-9a-z_]+)/i)?.[1],
      price: [".prod-sp"],
      mrp: [".prod-cp"],
      title: [".prod-name"],
      image: [".rilrtl-lazy-img", ".img-container img"],
      oos: [".out-of-stock"],
    },
  };

  function storeFor(url) {
    const host = url.hostname.toLowerCase();
    return Object.keys(STORES).find((k) => STORES[k].hosts.some((h) => host === h || host.endsWith("." + h)));
  }

  // "₹1,23,456.00" -> 123456; returns null when nothing numeric is present.
  function parsePrice(text) {
    if (text == null) return null;
    const m = String(text).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    const n = m ? Number(m[0]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function first(doc, selectors, read) {
    for (const s of selectors) {
      const el = doc.querySelector(s);
      const v = el && read(el);
      if (v) return v;
    }
    return null;
  }

  function jsonLdProduct(doc) {
    const walk = (node) => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) return node.map(walk).find(Boolean) || null;
      const t = node["@type"];
      if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return node;
      return walk(node["@graph"]);
    };
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { const p = walk(JSON.parse(s.textContent)); if (p) return p; } catch { /* malformed block */ }
    }
    return null;
  }

  function meta(doc, name) {
    return doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || null;
  }

  // Returns {store, product_id, url, title, image, price, mrp, currency, in_stock} or null.
  function extractProduct(doc, href) {
    const url = new URL(href);
    const store = storeFor(url);
    if (!store) return null;
    const cfg = STORES[store];
    const product_id = cfg.id(url);
    if (!product_id) return null;

    const ld = jsonLdProduct(doc);
    const offer = ld && [].concat(ld.offers || [])[0];
    const text = (el) => el.textContent.trim();
    const img = (el) => el.getAttribute("data-old-hires") || el.currentSrc || el.getAttribute("src");

    const price = first(doc, cfg.price, (el) => parsePrice(text(el)))
      ?? parsePrice(offer?.price ?? offer?.lowPrice)
      ?? parsePrice(meta(doc, "product:price:amount"));
    if (!price) return null;

    const oosText = first(doc, cfg.oos, text) || "";
    const in_stock = !/unavailable|out of stock|sold out/i.test(oosText)
      && !/OutOfStock/i.test(offer?.availability || "");

    return {
      store, product_id,
      url: `${url.origin}${url.pathname}${store === "flipkart" ? `?pid=${encodeURIComponent(product_id)}` : ""}`,
      title: [first(doc, cfg.brand || [], text), first(doc, cfg.title, text) || ld?.name || meta(doc, "og:title") || doc.title]
        .filter(Boolean).join(" ").slice(0, 500),
      image: (first(doc, cfg.image, img) || [].concat(ld?.image || [])[0] || meta(doc, "og:image") || "").slice(0, 2000),
      price,
      mrp: first(doc, cfg.mrp, (el) => parsePrice(text(el))),
      currency: offer?.priceCurrency || "INR",
      in_stock,
    };
  }

  globalThis.CheaprExtract = { STORES, storeFor, parsePrice, extractProduct };
})();
