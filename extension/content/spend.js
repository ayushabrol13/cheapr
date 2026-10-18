// Spend Tracker (opt-in): runs on YOUR order-history pages and reads them same-origin with your existing session.
// No header spoofing and nothing leaves the browser: results go to chrome.storage.local only.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (s) => Number(String(s).replace(/[^\d.]/g, "")) || 0;
  // Local calendar date: toISOString() would shift Indian dates back a day (UTC+5:30), e.g. 1 Jan into last year.
  const iso = (d) => (isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  const { inr, t } = CheaprFormat;

  const SITES = {
    amazon: {
      test: () => location.hostname.endsWith("amazon.in") && /order-history|your-orders/.test(location.pathname),
      async scan(progress) {
        const years = [...document.querySelectorAll('select[name="timeFilter"] option, select[name="orderFilter"] option')]
          .map((o) => o.value.match(/^year-(\d{4})$/)?.[1]).filter(Boolean);
        if (!years.length) for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 5; y--) years.push(String(y));
        const orders = new Map();
        for (const y of years) {
          for (let start = 0; start < 1000; start += 10) {
            progress(t("scan_progress", { site: `Amazon ${y}`, n: orders.size }));
            const res = await fetch(`/your-orders/orders?timeFilter=year-${y}&startIndex=${start}`, { credentials: "include" });
            if (res.url.includes("/ap/signin")) throw new Error(t("sign_in_first", { site: "Amazon" }));
            const doc = new DOMParser().parseFromString(await res.text(), "text/html");
            const cards = doc.querySelectorAll(".order-card, .js-order-card");
            for (const c of cards) {
              const t = c.textContent.replace(/\s+/g, " ");
              const id = t.match(/\b(\d{3}-\d{7}-\d{7})\b/)?.[1];
              const date = t.match(/Order placed (\d{1,2} \w+ \d{4})/i)?.[1];
              const total = t.match(/Total ₹\s?([\d,]+(?:\.\d+)?)/)?.[1];
              if (id && date && total && !/cancelled/i.test(t)) orders.set(id, { id, date: iso(new Date(date)), amount: num(total), label: "" });
            }
            if (cards.length < 10) break;
            await sleep(400);
          }
        }
        return [...orders.values()];
      },
    },
    swiggy: {
      test: () => location.hostname.endsWith("swiggy.com") && location.pathname.startsWith("/my-account"),
      async scan(progress) {
        const orders = [];
        let last = "";
        for (let page = 0; page < 300; page++) {
          progress(t("scan_progress", { site: "Swiggy", n: orders.length }));
          const res = await fetch(`/dapi/order/all?order_id=${last}`, { credentials: "include" });
          const batch = (await res.json())?.data?.orders || [];
          if (!batch.length) break;
          for (const o of batch) {
            if (o.order_status && !/delivered/i.test(o.order_status)) continue;
            orders.push({ id: String(o.order_id), date: iso(new Date(String(o.order_time).replace(" ", "T"))),
                          amount: num(o.order_total), label: o.restaurant_name || "" });
          }
          last = batch.at(-1).order_id;
          await sleep(400);
        }
        return orders;
      },
    },
    zomato: {
      test: () => location.hostname.endsWith("zomato.com") && /order/i.test(location.pathname),
      async scan(progress) {
        const orders = [];
        for (let page = 1, pages = 1; page <= pages && page <= 300; page++) {
          progress(t("scan_pages", { site: "Zomato", page, pages }));
          const json = await (await fetch(`/webroutes/user/orders?page=${page}`, { credentials: "include" })).json();
          pages = json?.sections?.SECTION_USER_ORDER_HISTORY?.totalPages || pages;
          for (const o of Object.values(json?.entities?.ORDER || {})) {
            orders.push({ id: String(o.orderId ?? o.id), date: iso(new Date(String(o.orderDate).replace(" at ", " "))),
                          amount: num(o.totalCost), label: o.resInfo?.name || "" });
          }
          await sleep(400);
        }
        return orders;
      },
    },
    flipkart: {
      // Order list is client-rendered with obfuscated classes, so scroll to load everything and read links.
      test: () => location.hostname.endsWith("flipkart.com") && location.pathname.startsWith("/account/orders"),
      async scan(progress) {
        let seen = -1;
        for (let i = 0; i < 40; i++) {
          const n = document.querySelectorAll('a[href*="order_details"]').length;
          if (n === seen) break;
          seen = n;
          progress(t("scan_progress", { site: "Flipkart", n }));
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(1500);
        }
        const year = new Date().getFullYear();
        return [...document.querySelectorAll('a[href*="order_details"]')].flatMap((a) => {
          const t = a.textContent.replace(/\s+/g, " ");
          const m = t.match(/Delivered on (\w{3} \d{1,2})(?:, (\d{4}))?/i);
          const price = t.match(/₹\s?([\d,]+)/)?.[1];
          const id = new URL(a.href).searchParams.get("order_id") || a.href;
          return m && price ? [{ id, date: iso(new Date(`${m[1]}, ${m[2] || year}`)), amount: num(price), label: "" }] : [];
        });
      },
    },
  };

  let host;
  async function check() {
    const site = Object.keys(SITES).find((k) => SITES[k].test());
    const { spend: enabled, quiet } = await chrome.storage.sync.get({ spend: false, quiet: false });
    if (!site || !enabled || quiet) { host?.remove(); host = null; return; }
    if (!host?.isConnected) showButton(site);
  }

  function showButton(site) {
    host = document.createElement("cheapr-spend");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.4 system-ui,"Noto Sans Devanagari",sans-serif}
      div{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.15);padding:10px 14px;display:flex;gap:10px;align-items:center;color:#101828;max-width:340px}
      button{background:#6941c6;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;white-space:nowrap}
      button:focus-visible{outline:2px solid #6941c6;outline-offset:2px}
      .x{background:none;color:#667085;padding:2px 6px;font-size:16px}
      @media (prefers-color-scheme:dark){div{background:#161b26;border-color:#333741;color:#f2f4f7}}
    </style><div role="status"><span></span><button class="scan"></button><button class="x"></button></div>`;
    const msg = root.querySelector("span"), btn = root.querySelector(".scan"), x = root.querySelector(".x");
    msg.textContent = t("spend_prompt");
    btn.textContent = t("scan_orders");
    x.textContent = "×";
    x.setAttribute("aria-label", t("hide"));
    x.onclick = () => host.remove();
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const orders = (await SITES[site].scan((text) => (msg.textContent = text))).filter((o) => o.date && o.amount > 0);
        const { spend = {} } = await chrome.storage.local.get("spend");
        spend[site] = { scannedAt: new Date().toISOString(), orders };
        await chrome.storage.local.set({ spend });
        msg.textContent = t("spend_done", { n: orders.length, total: inr(orders.reduce((s, o) => s + o.amount, 0)) });
      } catch (e) {
        msg.textContent = t("scan_failed", { err: e.message });
      }
      btn.remove();
    };
    document.documentElement.append(host);
  }

  CheaprI18n.load().then(check);
  // Order pages are often reached by in-app navigation (Swiggy, Zomato); settings apply to open tabs.
  let href = location.href;
  setInterval(() => { if (location.href !== href) { href = location.href; check(); } }, 1500);
  chrome.storage.onChanged.addListener((c) => { if ("spend" in c || "quiet" in c || "lang" in c) { host?.remove(); host = null; CheaprI18n.load().then(check); } });
})();
