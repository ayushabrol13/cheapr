// Cross-store comparison: build a search query for the other store, parse its search results page, and pick
// the same product only when we're confident (brand + model numbers + capacity agree). A wrong "cheaper
// elsewhere" claim is worse than none, so ambiguous results return null. Classic script: CheaprCompare.
(() => {
  const STOP = new Set(["with", "for", "and", "the", "in", "of", "to", "a", "an", "new", "launch", "edition", "sponsored", "ad"]);
  const OTHER = { amazon: "flipkart", flipkart: "amazon" }; // fashion stores rarely list identical items: skipped
  const SEARCH = {
    amazon: (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
    flipkart: (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`,
  };

  const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !STOP.has(w));
  // The identifying part of a title comes before the first spec separator: "boAt Airdopes 219, 40H Battery…"
  const namePart = (title) => String(title).replace(/^sponsored ad\s*-\s*/i, "").split(/[,|(–—]| - /)[0];
  const digits = (ws) => new Set(ws.filter((w) => /\d/.test(w)));
  const capacity = (title) => new Set((String(title).toLowerCase().match(/\b\d+\s?(?:gb|tb)\b/g) || []).map((c) => c.replace(/\s/, "")));
  const subset = (a, b) => [...a].every((x) => b.has(x));

  function query(product) {
    return words(namePart(product.title)).slice(0, 6).join(" ");
  }

  // 0..1 confidence that two titles are the same product; 0 when identity tokens conflict.
  function score(srcTitle, candTitle) {
    const a = words(namePart(srcTitle)), b = words(namePart(candTitle));
    if (!a.length || !b.length || a[0] !== b[0]) return 0; // brand must match
    const da = digits(a), db = digits(b);
    if (!da.size || !db.size || !(subset(da, db) || subset(db, da))) return 0; // model numbers must agree
    const ca = capacity(srcTitle), cb = capacity(candTitle);
    if (ca.size && cb.size && !(subset(ca, cb) && subset(cb, ca))) return 0; // 128GB vs 256GB is a different product
    const A = new Set(a), B = new Set(b);
    const inter = [...A].filter((w) => B.has(w)).length;
    return inter / Math.min(A.size, B.size) * 0.7 + inter / new Set([...A, ...B]).size * 0.3;
  }

  // Candidates from a search results document: [{store, product_id, title, price, url, sponsored}]
  function parseSearch(store, doc) {
    const num = (t) => { const m = String(t || "").replace(/,/g, "").match(/₹\s?(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
    if (store === "amazon") {
      return [...doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')].map((c) => {
        const alt = c.querySelector("img.s-image")?.getAttribute("alt") || "";
        const asin = c.getAttribute("data-asin");
        return {
          store, product_id: asin, url: `https://www.amazon.in/dp/${asin}`,
          title: alt.replace(/^sponsored ad\s*-\s*/i, "") || [...c.querySelectorAll("h2")].map((h) => h.textContent.trim()).join(" "),
          price: num(c.querySelector(".a-price .a-offscreen")?.textContent), sponsored: /sponsored/i.test(alt),
        };
      }).filter((c) => /^[A-Z0-9]{10}$/.test(c.product_id) && c.price);
    }
    if (store === "flipkart") {
      const out = new Map();
      for (const a of doc.querySelectorAll('a[href*="/p/itm"]')) {
        const href = new URL(a.getAttribute("href"), "https://www.flipkart.com");
        const pid = href.searchParams.get("pid");
        const title = a.querySelector("img")?.getAttribute("alt");
        if (!pid || !title || out.has(pid)) continue;
        let card = a; // climb to the tile that also holds the price link
        for (let i = 0; i < 8 && card.parentElement && !/₹/.test(card.textContent); i++) card = card.parentElement;
        const price = num(card.textContent);
        if (price) out.set(pid, { store, product_id: pid, title, price, sponsored: false,
          url: `https://www.flipkart.com${href.pathname}?pid=${encodeURIComponent(pid)}` });
      }
      return [...out.values()];
    }
    return [];
  }

  // Best confident match, preferring higher score, then non-sponsored, then lower price.
  function bestMatch(product, candidates, min = 0.6) {
    return candidates
      .map((c) => ({ ...c, score: Math.round(score(product.title, c.title) * 100) / 100 }))
      .filter((c) => c.score >= min && c.product_id !== product.product_id)
      .sort((x, y) => y.score - x.score || x.sponsored - y.sponsored || x.price - y.price)[0] || null;
  }

  globalThis.CheaprCompare = { OTHER, SEARCH, query, score, parseSearch, bestMatch };
})();
