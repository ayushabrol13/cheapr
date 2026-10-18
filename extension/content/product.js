// Product pages: record the price, then show a compact verdict bar (expandable to chart + insights + alert)
// inline under the store's price block. Falls back to a floating card when the store's layout is unknown.
(() => {
  const { inr, date, VERDICTS, insight } = CheaprFormat;
  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error || "No response"))));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const RANGES = { "1M": 30, "3M": 90, "1Y": 365, All: Infinity };
  const site = location.hostname.replace(/^www\./, "");

  let host, root, state = {}, lastKey;

  // ---------- mounting ----------
  function mount(product) {
    if (host?.isConnected) return;
    host = document.createElement("cheapr-card");
    root = host.attachShadow({ mode: "closed" });
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    const cfg = CheaprExtract.STORES[product.store];
    const anchor = cfg.anchor?.map((s) => document.querySelector(s)).find((el) => el?.offsetParent);
    if (anchor) anchor.after(host);
    else { host.setAttribute("floating", ""); document.documentElement.append(host); }
  }

  // ---------- rendering ----------
  function render(patch = {}) {
    state = { ...state, ...patch };
    const { product, history, error, missing, expanded, menu, watch, watchMsg, loading } = state;
    if (!product) return;
    mount(product);
    const v = error ? { label: "Offline", tone: "bad" } : loading ? { label: "Checking…", tone: "muted" }
      : missing ? { label: "No history yet", tone: "muted" } : VERDICTS[history?.verdict] || VERDICTS.new;
    const s = history?.stats || {};
    const summary = s.low != null && history?.verdict !== "new"
      ? `<span class="sep">·</span><span>3M low <b>${inr(s.low)}</b></span><span class="sep">·</span><span>Usual <b>${inr(s.usual ?? s.avg)}</b></span>` : "";
    root.innerHTML = `${STYLE}<section class="card ${expanded ? "open" : ""}" aria-label="Cheapr price history">
      <div class="bar">
        <span class="logo" aria-hidden="true">₹</span>
        <span class="chip ${v.tone}">${esc(v.label)}</span>
        <span class="summary"><span class="now"><b>${inr(product.price)}</b></span>${summary}</span>
        <button class="act primary" data-act="watch">${watch ? `Alert at ${inr(watch.target_price)}` : "Set alert"}</button>
        <button class="act icon" data-act="toggle" aria-expanded="${!!expanded}" aria-label="${expanded ? "Collapse" : "Show price history"}">${expanded ? '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 12l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'}</button>
        <button class="act icon" data-act="menu" aria-haspopup="menu" aria-expanded="${!!menu}" aria-label="Cheapr options"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="4" cy="10" r="1.7" fill="currentColor"/><circle cx="10" cy="10" r="1.7" fill="currentColor"/><circle cx="16" cy="10" r="1.7" fill="currentColor"/></svg></button>
      </div>
      ${menu ? `<div class="menu" role="menu">
        <button role="menuitem" data-act="mute">Hide on ${esc(site)}</button>
        <button role="menuitem" data-act="quiet">Pause Cheapr on all sites</button>
        <button role="menuitem" data-act="settings">Settings</button></div>` : ""}
      ${expanded ? body() : ""}
      ${watchMsg ? `<p class="toast" role="status">${esc(watchMsg)}</p>` : ""}
    </section>`;
    if (expanded) wireChart();
  }

  function body() {
    const { product, history, error, missing, watch, range = "3M" } = state;
    if (error) return `<div class="body"><p class="err">Couldn't reach the Cheapr server (${esc(error)}). Prices will appear when it's back.</p></div>`;
    if (missing) return `<div class="body"><p class="muted">No price history for this product yet. ${state.share ? "Cheapr just started tracking it." : "Turn on anonymous price sharing in Settings to help build history."}</p>${alertForm(product, watch)}</div>`;
    if (!history) return `<div class="body"><p class="muted">Loading price history…</p></div>`;
    const lines = history.insights.map(insight).filter(Boolean);
    const s = history.stats;
    if (history.verdict === "new" && new Set(history.points.map((p) => p.price)).size < 2) {
      // Not enough to draw honestly: a flat one-point "chart" would look like history we don't have.
      return `<div class="body"><p class="muted">Cheapr started tracking this product ${s.observations > 1 ? `on ${date(s.first_seen)}` : "today"}. We'll show a price trend once the price changes, and a verdict after about a week.</p>
        ${alertForm(product, watch)}</div>`;
    }
    return `<div class="body">
      <div class="tabs" role="tablist" aria-label="Chart range">${Object.keys(RANGES).map((r) =>
        `<button role="tab" data-act="range" data-range="${r}" aria-selected="${r === range}">${r}</button>`).join("")}</div>
      <div class="chart">${chart(history.points, RANGES[range])}<div class="tip" hidden></div></div>
      <dl class="stats">
        <div><dt>Lowest</dt><dd>${inr(s.all_time_low)}</dd></div>
        <div><dt>Usual price</dt><dd>${inr(s.usual ?? s.avg)}</dd></div>
        <div><dt>Highest</dt><dd>${inr(s.all_time_high)}</dd></div>
      </dl>
      ${lines.length ? `<ul class="insights">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      ${history.verdict === "new" ? `<p class="muted">We need about a week of prices before judging a deal. Set an alert and we'll watch it for you.</p>` : ""}
      ${alertForm(product, watch)}
      <p class="foot">${s.observations} price ${s.observations === 1 ? "check" : "checks"} since ${date(s.first_seen)}</p>
    </div>`;
  }

  function alertForm(product, watch) {
    const target = watch?.target_price ?? Math.floor(product.price * 0.9);
    return `<form class="alert"><label for="t">Alert me below</label>
      <span class="money">₹<input id="t" type="number" inputmode="numeric" min="1" step="1" required value="${target}"></span>
      <button class="act primary">${watch ? "Update" : "Set alert"}</button>
      ${watch ? `<button type="button" class="act link" data-act="unwatch">Remove</button>` : ""}</form>`;
  }

  // ---------- chart ----------
  let chartPts = [];
  const W = 480, H = 120, PAD = 8;

  function chart(points, days) {
    const now = Date.now(), from = now - days * 864e5;
    let ps = points.filter((p) => p.in_stock).map((p) => ({ t: Date.parse(p.t), price: p.price }));
    const before = ps.filter((p) => p.t < from).at(-1);
    ps = ps.filter((p) => p.t >= from);
    if (before) ps.unshift({ t: from, price: before.price }); // carry the price that was live when the range starts
    if (!ps.length) return `<p class="muted center">No prices in this range.</p>`;
    ps.push({ t: now, price: ps.at(-1).price, now: true });
    const x0 = ps[0].t, x1 = now, ys = ps.map((p) => p.price);
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || hi * 0.1 || 1;
    const X = (t) => PAD + ((t - x0) / (x1 - x0 || 1)) * (W - 2 * PAD);
    const Y = (y) => PAD + (1 - (y - lo + span * 0.1) / (span * 1.2)) * (H - 2 * PAD);
    chartPts = ps.map((p) => ({ ...p, x: X(p.t), y: Y(p.price) }));
    let d = `M${chartPts[0].x},${chartPts[0].y}`;
    for (let i = 1; i < chartPts.length; i++) d += `H${chartPts[i].x}V${chartPts[i].y}`; // step: price holds until it changes
    const low = chartPts.reduce((a, b) => (b.price < a.price ? b : a));
    const cur = chartPts.at(-1);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price from ${inr(lo)} to ${inr(hi)}">
      <path d="${d}V${H}H${chartPts[0].x}Z" class="area"/><path d="${d}" class="line"/>
      <circle cx="${low.x}" cy="${low.y}" r="3.5" class="lowdot"/><circle cx="${cur.x}" cy="${cur.y}" r="3.5" class="curdot"/>
      <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg>
      <div class="axis"><span>${date(new Date(x0).toISOString())}</span><span>${inr(hi)} high · ${inr(lo)} low</span><span>Today</span></div>`;
  }

  function wireChart() {
    const svg = root.querySelector("svg"), tip = root.querySelector(".tip"), cursor = root.querySelector(".cursor");
    if (!svg) return;
    const show = (clientX) => {
      const r = svg.getBoundingClientRect(), x = ((clientX - r.left) / r.width) * W;
      const p = chartPts.findLast((q) => q.x <= x) || chartPts[0]; // step chart: the live price at that x
      cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = `${p.now ? "Today" : date(new Date(p.t).toISOString())} · ${inr(p.price)}`;
      tip.style.left = `${Math.min(Math.max((x / W) * 100, 12), 88)}%`;
    };
    svg.addEventListener("pointermove", (e) => show(e.clientX));
    svg.addEventListener("pointerleave", () => { tip.hidden = true; cursor.setAttribute("visibility", "hidden"); });
  }

  // ---------- actions ----------
  async function onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) { if (state.menu && !e.target.closest(".menu")) render({ menu: false }); return; }
    const act = btn.dataset.act;
    if (act === "toggle") return setExpanded(!state.expanded);
    if (act === "menu") return render({ menu: !state.menu });
    if (act === "range") return render({ range: btn.dataset.range });
    if (act === "watch") { await setExpanded(true); return root.querySelector("#t")?.focus(); }
    if (act === "settings") { render({ menu: false }); return send({ type: "openSettings" }).catch(() => {}); }
    if (act === "mute" || act === "quiet") {
      const { mutedSites = [] } = await chrome.storage.local.get("mutedSites");
      await (act === "mute" ? chrome.storage.local.set({ mutedSites: [...new Set([...mutedSites, site])] }) : chrome.storage.sync.set({ quiet: true }));
      host.remove();
      return;
    }
    if (act === "unwatch" && state.watch) {
      await send({ type: "unwatch", id: state.watch.id }).catch(() => {});
      return render({ watch: null, watchMsg: "Alert removed." });
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const target_price = Number(root.querySelector("#t").value);
    if (!(target_price > 0)) return;
    try {
      const w = await send({ type: "watch", product: state.product, target_price });
      render({ watch: w, watchMsg: w.triggered_at ? "It's already below your target!" : `Alert set. We'll notify you below ${inr(target_price)}.` });
    } catch (err) {
      render({ watchMsg: `Couldn't set alert: ${err.message}` });
    }
  }

  async function setExpanded(expanded) {
    await chrome.storage.local.set({ cardExpanded: expanded }); // remembered across products
    render({ expanded, menu: false, watchMsg: null });
  }

  // ---------- lifecycle ----------
  async function run(tries = 30) { // ~30s: SPA stores (Ajio, Myntra) render prices late
    const product = CheaprExtract.extractProduct(document, location.href);
    if (!product) {
      if (tries > 0 && CheaprExtract.storeFor(new URL(location.href))) setTimeout(() => run(tries - 1), 1000);
      else if (host) { host.remove(); host = null; state = {}; lastKey = null; }
      return;
    }
    const key = `${product.store}:${product.product_id}:${product.price}`;
    if (key === lastKey) { if (!host?.isConnected) render(); return; } // SPA re-render removed us: remount
    if (!state.product || state.product.product_id !== product.product_id) { host?.remove(); host = null; }
    lastKey = key;
    const { cardExpanded = false } = await chrome.storage.local.get("cardExpanded");
    const { share = false } = await chrome.storage.sync.get("share");
    render({ product, history: null, error: null, missing: false, loading: true, expanded: cardExpanded, share, watchMsg: null });
    try {
      const [res, watches] = await Promise.all([send({ type: "observe", product }), send({ type: "watches" }).catch(() => [])]);
      const watch = watches.find((w) => w.store === product.store && w.product_id === product.product_id) || null;
      render({ loading: false, history: res.missing ? null : res, missing: !!res.missing, watch });
    } catch (err) {
      render({ loading: false, error: err.message });
    }
  }

  (async () => {
    const [{ overlay = true, quiet = false }, { mutedSites = [] }] = await Promise.all([
      chrome.storage.sync.get(["overlay", "quiet"]), chrome.storage.local.get("mutedSites")]);
    if (!overlay || quiet || mutedSites.includes(site)) return;
    run();
    // SPAs (Flipkart, Myntra) swap products without a reload, and may re-render over our card.
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) { href = location.href; setTimeout(run, 1200); }
      else if (host && !host.isConnected) run(0);
    }, 1000);
  })();

  const STYLE = `<style>
    :host{all:initial;display:block;margin:12px 0;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#101828;max-width:560px}
    :host([floating]){position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;margin:0}
    *{box-sizing:border-box}
    .card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.06);position:relative}
    :host([floating]) .card{box-shadow:0 12px 32px rgba(16,24,40,.18)}
    .bar{display:flex;align-items:center;gap:8px;padding:8px 10px}
    .summary{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary>span{margin-right:6px}
    .logo{width:22px;height:22px;border-radius:6px;background:#6941c6;color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px;flex:none}
    .chip{border-radius:99px;padding:2px 8px;font-size:12px;font-weight:600;white-space:nowrap}
    .chip.good{background:#dcfae6;color:#067647}.chip.warn{background:#fef0c7;color:#93370d}.chip.bad{background:#fee4e2;color:#b42318}.chip.muted{background:#f2f4f7;color:#475467}
    .now b{font-size:15px}.sep{color:#d0d5dd}
    .act{font:inherit;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap}
    .act:hover{background:#f9fafb}.act.primary{background:#6941c6;border-color:#6941c6;color:#fff}.act.primary:hover{background:#53389e}
    .act.icon{padding:0;width:32px;height:30px;display:inline-grid;place-items:center}.act.link{border:0;background:none;color:#475467;text-decoration:underline;padding:4px}
    button:focus-visible,input:focus-visible{outline:2px solid #6941c6;outline-offset:2px}
    .menu{position:absolute;right:8px;top:44px;z-index:2;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.16);padding:4px;display:flex;flex-direction:column;min-width:200px}
    .menu button{font:inherit;text-align:left;background:none;border:0;padding:8px 10px;border-radius:6px;cursor:pointer;color:#344054}.menu button:hover{background:#f2f4f7}
    .body{padding:4px 14px 12px;border-top:1px solid #f2f4f7}
    .tabs{display:flex;gap:4px;margin:8px 0}
    .tabs button{font:inherit;font-size:12px;border:0;background:none;padding:3px 9px;border-radius:6px;cursor:pointer;color:#475467}
    .tabs button[aria-selected=true]{background:#f4ebff;color:#53389e;font-weight:600}
    .chart{position:relative}.chart svg{width:100%;height:120px;display:block;touch-action:none}
    .line{fill:none;stroke:#6941c6;stroke-width:2;vector-effect:non-scaling-stroke}.area{fill:#6941c6;opacity:.07}
    .lowdot{fill:#067647}.curdot{fill:#6941c6}.cursor{stroke:#98a2b3;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
    .tip{position:absolute;top:-4px;transform:translateX(-50%);background:#101828;color:#fff;font-size:12px;padding:3px 8px;border-radius:6px;pointer-events:none;white-space:nowrap}
    .axis{display:flex;justify-content:space-between;color:#667085;font-size:11px;margin-top:2px}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0 4px}
    .stats div{background:#f9fafb;border-radius:8px;padding:6px 8px}.stats dt{color:#667085;font-size:11px}.stats dd{margin:0;font-weight:600}
    .insights{margin:8px 0;padding:0;list-style:none}.insights li{padding:4px 0 4px 18px;position:relative}
    .insights li::before{content:"";position:absolute;left:4px;top:11px;width:6px;height:6px;border-radius:50%;background:#6941c6}
    .alert{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
    .money{display:inline-flex;align-items:center;border:1px solid #d0d5dd;border-radius:8px;padding:0 0 0 8px;color:#475467}
    .money input{border:0;width:90px;padding:5px 6px;font:inherit;background:transparent;color:#101828}
    .muted{color:#667085}.center{text-align:center}.err{color:#b42318}
    .foot{color:#98a2b3;font-size:11px;margin:10px 0 0}
    .toast{margin:0;padding:6px 14px 10px;color:#067647}
    @media (prefers-color-scheme:dark){
      :host{color:#f2f4f7}.card,.menu,.act{background:#161b26;border-color:#333741;color:#cecfd2}
      .act.primary{background:#7f56d9;border-color:#7f56d9;color:#fff}.body{border-color:#22262f}.stats div{background:#1f242f}
      .money input{color:#f2f4f7}.menu button{color:#cecfd2}.menu button:hover,.act:hover{background:#22262f}
      .tabs button[aria-selected=true]{background:#2c1c5f;color:#d6bbfb}.chip.muted{background:#22262f;color:#cecfd2}
    }
    @media (prefers-reduced-motion:no-preference){.card{transition:box-shadow .15s}}
  </style>`;
})();
