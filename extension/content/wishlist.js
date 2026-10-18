// Wishlist pages (Amazon, Flipkart): offer to track every item with one click. Items become "any drop" alerts.
(() => {
  const { t } = CheaprFormat;
  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const price = (text) => { const m = String(text || "").replace(/,/g, "").match(/₹\s?(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

  // Amazon wishlist items: [{store, product_id, url, title, image, price}] (items without a price are skipped).
  function parseAmazon(doc) {
    const out = new Map();
    for (const a of doc.querySelectorAll('#g-items a[href*="/dp/"], li[data-itemid] a[href*="/dp/"]')) {
      const asin = a.getAttribute("href").match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      if (!asin || out.has(asin)) continue;
      const li = a.closest("li") || a.parentElement;
      const p = Number(li?.getAttribute("data-price")) || price(li?.querySelector(".a-price .a-offscreen")?.textContent);
      const title = (li?.querySelector('[id^="itemName_"]')?.textContent || a.getAttribute("title") || a.textContent || "").trim();
      if (p > 0 && title) {
        out.set(asin, { store: "amazon", product_id: asin, url: `https://www.amazon.in/dp/${asin}`, title,
          image: li.querySelector("img")?.getAttribute("src") || "", price: p });
      }
    }
    return [...out.values()];
  }
  globalThis.CheaprWishlist = { parseAmazon }; // for tests

  const SITES = {
    amazon: {
      test: () => location.hostname.endsWith("amazon.in") && /\/hz\/wishlist\//.test(location.pathname),
      // Lists load more items as you scroll; scroll until the end marker shows or the count stops growing.
      async load() {
        let seen = -1;
        for (let i = 0; i < 30 && !document.querySelector("#endOfListMarker"); i++) {
          const n = document.querySelectorAll('li[data-itemid], #g-items li').length;
          if (n === seen) break;
          seen = n;
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(1200);
        }
      },
      items: (doc = document) => parseAmazon(doc),
    },
    flipkart: {
      test: () => location.hostname.endsWith("flipkart.com") && location.pathname.startsWith("/wishlist"),
      async load() { await sleep(1500); },
      items: () => CheaprCompare.parseSearch("flipkart", document).map((c) => ({ ...c, image: "" })), // same tiles as search
    },
  };

  let host;
  async function check() {
    const site = Object.keys(SITES).find((k) => SITES[k].test());
    const { quiet } = await chrome.storage.sync.get({ quiet: false });
    if (!site || quiet) { host?.remove(); host = null; return; }
    await sleep(2000); // wishlists render client-side
    const items = SITES[site].items();
    if (!items.length || host?.isConnected) return;
    show(site, items.length);
  }

  function show(site, count) {
    host = document.createElement("cheapr-wishlist");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.4 system-ui,"Noto Sans Devanagari",sans-serif}
      div{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.15);padding:10px 14px;display:flex;gap:10px;align-items:center;color:#101828;max-width:360px}
      button{background:#6941c6;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;white-space:nowrap}
      button:focus-visible{outline:2px solid #6941c6;outline-offset:2px}button:disabled{opacity:.5}
      .x{background:none;color:#667085;padding:2px 6px;font-size:16px}
      @media (prefers-color-scheme:dark){div{background:#161b26;border-color:#333741;color:#f2f4f7}}
    </style><div role="status"><span></span><button class="go"></button><button class="x"></button></div>`;
    const msg = root.querySelector("span"), go = root.querySelector(".go"), x = root.querySelector(".x");
    msg.textContent = t("wl_prompt", { n: count });
    go.textContent = t("wl_button");
    x.textContent = "×";
    x.setAttribute("aria-label", t("hide"));
    x.onclick = () => host.remove();
    go.onclick = async () => {
      go.disabled = true;
      msg.textContent = t("wl_progress", { i: 0, n: count });
      try {
        await SITES[site].load();
        const items = SITES[site].items();
        const { added } = await send({ type: "importItems", items, mode: "any" });
        msg.textContent = t("wl_done", { n: added });
      } catch (e) {
        msg.textContent = t("wl_failed", { err: e.message });
      }
      go.remove();
    };
    document.documentElement.append(host);
  }

  CheaprI18n.load().then(check);
  let href = location.href;
  setInterval(() => { if (location.href !== href) { href = location.href; host?.remove(); host = null; check(); } }, 1500);
})();
