// Product pages: record the price, then show history + verdict + watch button in a shadow-DOM card.
(() => {
  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
  const inr = (n) => (n == null ? "–" : "₹" + Math.round(n).toLocaleString("en-IN"));
  const VERDICT = {
    lowest: ["Lowest price", "#0a7d38"], good: ["Good time to buy", "#0a7d38"], fair: ["Fair price", "#946200"],
    high: ["Higher than usual", "#b42318"], "not-enough-data": ["Tracking started", "#475467"],
  };

  let host, root, lastKey;

  function mount() {
    if (host) return;
    host = document.createElement("cheapr-card");
    root = host.attachShadow({ mode: "closed" });
    document.documentElement.append(host);
  }

  function chart(points) {
    const ps = points.filter((p) => p.in_stock);
    if (ps.length < 2) return "";
    const W = 268, H = 80, xs = ps.map((p) => Date.parse(p.t)), ys = ps.map((p) => p.price);
    xs.push(Date.now()); ys.push(ys.at(-1)); // extend the last price to today
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => H - 6 - ((y - y0) / (y1 - y0 || 1)) * (H - 12);
    let d = `M${X(xs[0])},${Y(ys[0])}`;
    for (let i = 1; i < xs.length; i++) d += ` H${X(xs[i])} V${Y(ys[i])}`; // step line: price holds until it changes
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Price history chart">
      <path d="${d}" fill="none" stroke="#6941c6" stroke-width="2"/>
      <text x="0" y="10" class="ax">${inr(y1)}</text><text x="0" y="${H}" class="ax">${inr(y0)}</text></svg>`;
  }

  function render(state) {
    mount();
    const { product, history, error, collapsed, watchMsg } = state;
    if (collapsed) {
      root.innerHTML = `${STYLE}<button class="pill" aria-label="Open Cheapr">₹ Cheapr</button>`;
      root.querySelector(".pill").onclick = () => render({ ...state, collapsed: false });
      return;
    }
    const [label, color] = error ? ["Offline", "#b42318"] : VERDICT[history?.verdict] || ["Loading…", "#475467"];
    const s = history?.stats || {};
    root.innerHTML = `${STYLE}<section class="card" aria-label="Cheapr price history">
      <header><b>Cheapr</b><span class="verdict" style="background:${color}">${label}</span>
        <button class="x" aria-label="Minimise">–</button></header>
      ${error ? `<p class="err">Backend unreachable: ${escapeHtml(error)}. Check the backend URL in Cheapr settings.</p>` : `
      <div class="now">${inr(product.price)}${product.mrp && product.mrp > product.price ? ` <s>${inr(product.mrp)}</s>` : ""}</div>
      <div class="stats"><span>Low <b>${inr(s.min)}</b></span><span>Avg <b>${inr(s.avg)}</b></span><span>High <b>${inr(s.max)}</b></span></div>
      ${history ? chart(history.points) || `<p class="muted">History builds as the price changes. Cheapr records each visit.</p>` : ""}
      <form class="watch"><label>Alert me below ₹<input type="number" min="1" step="1" required
        value="${Math.floor(product.price * 0.9)}" aria-label="Target price"></label><button>Watch</button></form>
      ${watchMsg ? `<p class="muted" role="status">${escapeHtml(watchMsg)}</p>` : ""}`}
    </section>`;
    root.querySelector(".x").onclick = () => render({ ...state, collapsed: true });
    root.querySelector("form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const target_price = Number(e.target.querySelector("input").value);
      try {
        const w = await send({ type: "watch", store: product.store, product_id: product.product_id, target_price });
        render({ ...state, watchMsg: w.triggered_at ? "Already below target!" : `Watching. We'll alert you under ${inr(target_price)}.` });
      } catch (err) {
        render({ ...state, watchMsg: `Could not save: ${err.message}` });
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  async function run(tries = 10) {
    const product = CheaprExtract.extractProduct(document, location.href);
    if (!product) {
      if (tries > 0 && CheaprExtract.storeFor(new URL(location.href))) setTimeout(() => run(tries - 1), 1000);
      return;
    }
    const key = `${product.store}:${product.product_id}:${product.price}`;
    if (key === lastKey) return;
    lastKey = key;
    render({ product });
    try {
      render({ product, history: await send({ type: "observe", product }) });
    } catch (e) {
      render({ product, error: e.message });
    }
  }

  chrome.storage.sync.get({ overlay: true }).then(({ overlay }) => {
    if (!overlay) return;
    run();
    // SPA stores (Flipkart, Myntra) change products without reloading.
    let href = location.href;
    setInterval(() => { if (location.href !== href) { href = location.href; lastKey = null; setTimeout(run, 1500); } }, 1000);
  });

  const STYLE = `<style>
    :host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.4 system-ui,sans-serif;color:#101828}
    .card{width:300px;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.15);padding:12px 16px}
    header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .verdict{color:#fff;border-radius:99px;padding:1px 8px;font-size:11px}
    .x{margin-left:auto;border:0;background:none;font-size:18px;cursor:pointer;color:#475467}
    .now{font-size:22px;font-weight:700}.now s{font-size:13px;color:#667085;font-weight:400}
    .stats{display:flex;justify-content:space-between;color:#475467;margin:4px 0 8px}
    .ax{font-size:9px;fill:#667085}.muted{color:#667085;margin:6px 0}.err{color:#b42318}
    .watch{display:flex;gap:6px;align-items:center;margin-top:8px}.watch label{flex:1}
    .watch input{width:80px;padding:3px 4px;border:1px solid #d0d5dd;border-radius:6px}
    button{font:inherit}.watch button,.pill{background:#6941c6;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer}
    button:focus-visible,input:focus-visible{outline:2px solid #6941c6;outline-offset:2px}
  </style>`;
})();
