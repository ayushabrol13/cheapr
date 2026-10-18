// Product pages: record the price, then show a compact verdict bar (expandable to chart, insights, comparison
// and alert) inline under the store's price block; floating card when the store's layout is unknown.
(() => {
  const { inr, date, verdict, insight, t } = CheaprFormat;
  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error || "No response"))));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const RANGES = { "1M": 30, "3M": 90, "1Y": 365, All: Infinity };
  const STORE_NAMES = { amazon: "Amazon", flipkart: "Flipkart", myntra: "Myntra", ajio: "Ajio" };
  const site = location.hostname.replace(/^www\./, "");

  let host, root, state = {}, lastKey, timer, stopped = false, seq = 0;

  // ---------- mounting ----------
  function mount(product) {
    if (host?.isConnected) return;
    host = document.createElement("cheapr-card");
    root = host.attachShadow({ mode: "closed" });
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.menu) { render({ menu: false }); focusAct("menu"); } });
    const cfg = CheaprExtract.STORES[product.store];
    const anchor = cfg.anchor?.map((s) => document.querySelector(s)).find((el) => el?.offsetParent);
    if (anchor) anchor.after(host);
    else { host.setAttribute("floating", ""); document.documentElement.append(host); }
  }

  function unmount() {
    host?.remove();
    host = null; state = {}; lastKey = null;
  }

  // Stop for good (hidden on this site / paused): no timers, no remounts until settings change or the page reloads.
  function stop() {
    stopped = true;
    clearInterval(timer);
    unmount();
    send({ type: "clearTab" }).catch(() => {});
  }

  const focusAct = (act) => root?.querySelector(`[data-act="${act}"]`)?.focus();

  // ---------- rendering ----------
  function render(patch = {}) {
    state = { ...state, ...patch };
    const { product, history, error, missing, expanded, menu, watch, watchMsg, loading } = state;
    if (!product || stopped) return;
    mount(product);
    // Keep keyboard focus and a half-typed target price across re-renders (screen readers, async updates).
    const active = root.activeElement, focusKey = active?.dataset?.act || active?.id;
    const typed = root.querySelector("#t")?.value;
    const v = error ? { label: t("offline"), tone: "bad" } : loading ? { label: t("checking"), tone: "muted" }
      : missing ? { label: t("no_history"), tone: "muted" } : verdict(history?.verdict);
    const s = history?.stats || {};
    const summary = s.low != null && history?.verdict !== "new"
      ? `<span class="sep">·</span><span>${t("low_3m")} <b>${inr(s.low)}</b></span><span class="sep">·</span><span>${t("usual")} <b>${inr(s.usual ?? s.avg)}</b></span>` : "";
    const c = cheaper();
    root.innerHTML = `${STYLE}<section class="card ${expanded ? "open" : ""}" aria-label="Cheapr">
      <div class="bar">
        <span class="logo" aria-hidden="true">₹</span>
        <span class="chip ${v.tone}">${esc(v.label)}</span>
        <span class="summary"><span class="now"><b>${inr(product.price)}</b></span>${summary}</span>
        ${c ? `<a class="deal" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(t("cheaper_on", { diff: inr(product.price - c.price), store: STORE_NAMES[c.store] }))}</a>` : ""}
        <button class="act primary" data-act="watch">${esc(watch ? (watch.mode === "any" ? t("any_drop") : t("alert_at", { price: inr(watch.target_price) })) : t("set_alert"))}</button>
        <button class="act icon" data-act="toggle" aria-expanded="${!!expanded}" aria-label="${esc(expanded ? t("collapse") : t("show_history"))}">${expanded ? ICON_UP : ICON_DOWN}</button>
        <button class="act icon" data-act="menu" aria-haspopup="menu" aria-expanded="${!!menu}" aria-label="${esc(t("options"))}">${ICON_DOTS}</button>
      </div>
      ${menu ? `<div class="menu" role="menu">
        <button role="menuitem" data-act="mute">${esc(t("hide_on", { site }))}</button>
        <button role="menuitem" data-act="quiet">${esc(t("pause_all"))}</button>
        <button role="menuitem" data-act="settings">${esc(t("settings"))}</button></div>` : ""}
      ${expanded ? body() : ""}
      ${watchMsg ? `<p class="toast" role="status">${esc(watchMsg)}</p>` : ""}
    </section>`;
    if (expanded) wireChart();
    const input = root.querySelector("#t");
    if (input && typed != null && focusKey === "t") input.value = typed;
    if (menu && focusKey === "menu") root.querySelector('[role="menuitem"]')?.focus();
    else if (focusKey) (root.querySelector(`[data-act="${focusKey}"]`) || root.querySelector(`#${focusKey}`))?.focus();
  }

  function body() {
    const { product, history, error, missing, watch, range = "3M" } = state;
    if (error) return `<div class="body"><p class="err">${esc(t("server_down", { err: error }))}</p></div>`;
    if (missing) return `<div class="body"><p class="muted">${esc(t(state.share ? "missing_share" : "missing_noshare"))}</p>${compareRow()}${alertForm(product, watch)}</div>`;
    if (!history) return `<div class="body"><p class="muted">${esc(t("loading_history"))}</p></div>`;
    const lines = history.insights.map(insight).filter(Boolean);
    const s = history.stats;
    if (history.verdict === "new" && new Set(history.points.map((p) => p.price)).size < 2) {
      // Not enough to draw honestly: a flat one-point "chart" would look like history we don't have.
      return `<div class="body"><p class="muted">${esc(s.observations > 1 ? t("started_on", { date: date(s.first_seen) }) : t("started_today"))}</p>
        ${compareRow()}${alertForm(product, watch)}</div>`;
    }
    return `<div class="body">
      <div class="tabs" role="group" aria-label="Chart range">${Object.keys(RANGES).map((r) =>
        `<button data-act="range-${r}" aria-pressed="${r === range}">${r}</button>`).join("")}</div>
      <div class="chart">${chart(history.points, RANGES[range])}<div class="tip" hidden></div></div>
      <dl class="stats">
        <div><dt>${esc(t("lowest"))}</dt><dd>${inr(s.all_time_low)}</dd></div>
        <div><dt>${esc(t("usual_price"))}</dt><dd>${inr(s.usual ?? s.avg)}</dd></div>
        <div><dt>${esc(t("highest"))}</dt><dd>${inr(s.all_time_high)}</dd></div>
      </dl>
      ${compareRow()}
      ${lines.length ? `<ul class="insights">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      ${history.verdict === "new" ? `<p class="muted">${esc(t("need_week"))}</p>` : ""}
      ${alertForm(product, watch)}
      <p class="foot">${esc(s.observations === 1 ? t("check_since", { date: date(s.first_seen) }) : t("checks_since", { n: s.observations, date: date(s.first_seen) }))}</p>
    </div>`;
  }

  function cheaper() {
    const c = state.compare;
    return c && /^https:\/\//.test(c.url) && c.price < state.product.price ? c : null;
  }

  function compareRow() {
    const c = state.compare;
    if (!c || !/^https:\/\//.test(c.url)) return "";
    const diff = c.price - state.product.price;
    const note = diff < 0 ? `<b class="good">${esc(t("cmp_cheaper", { diff: inr(-diff) }))}</b>` : esc(diff > 0 ? t("cmp_more", { diff: inr(diff) }) : t("cmp_same"));
    return `<div class="cmp"><span>${STORE_NAMES[c.store]}: <b>${inr(c.price)}</b> · ${note}</span>
      <a class="act" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(t("view"))}</a>
      <button class="act link" data-act="reject">${esc(t("not_same"))}</button></div>`;
  }

  function alertForm(product, watch) {
    const target = watch?.mode === "target" ? watch.target_price : Math.floor(product.price * 0.9);
    const any = watch?.mode === "any";
    return `<form class="alert"><label for="t">${esc(t("alert_below"))}</label>
      <span class="money">₹<input id="t" type="number" inputmode="numeric" min="1" step="1" ${any ? "disabled" : "required"} value="${target}"></span>
      <label class="any"><input type="checkbox" id="any" data-act="any" ${any ? "checked" : ""}> ${esc(t("any_drop"))}</label>
      <button class="act primary" data-act="save">${esc(watch ? t("update") : t("set_alert"))}</button>
      ${watch ? `<button type="button" class="act link" data-act="unwatch">${esc(t("remove"))}</button>` : ""}</form>`;
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
    if (!ps.length) return `<p class="muted center">${esc(t("no_prices_range"))}</p>`;
    ps.push({ t: now, price: ps.at(-1).price, now: true });
    const x0 = ps[0].t, ys = ps.map((p) => p.price);
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || hi * 0.1 || 1;
    const X = (x) => PAD + ((x - x0) / (now - x0 || 1)) * (W - 2 * PAD);
    const Y = (y) => PAD + (1 - (y - lo + span * 0.1) / (span * 1.2)) * (H - 2 * PAD);
    chartPts = ps.map((p) => ({ ...p, x: X(p.t), y: Y(p.price) }));
    let d = `M${chartPts[0].x},${chartPts[0].y}`;
    for (let i = 1; i < chartPts.length; i++) d += `H${chartPts[i].x}V${chartPts[i].y}`; // step: price holds until it changes
    const low = chartPts.reduce((a, b) => (b.price < a.price ? b : a)), cur = chartPts.at(-1);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("chart_label", { lo: inr(lo), hi: inr(hi) }))}">
      <path d="${d}V${H}H${chartPts[0].x}Z" class="area"/><path d="${d}" class="line"/>
      <circle cx="${low.x}" cy="${low.y}" r="3.5" class="lowdot"/><circle cx="${cur.x}" cy="${cur.y}" r="3.5" class="curdot"/>
      <line class="cursor" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/></svg>
      <div class="axis"><span>${date(new Date(x0).toISOString())}</span><span>${esc(t("range_high_low", { hi: inr(hi), lo: inr(lo) }))}</span><span>${esc(t("today"))}</span></div>`;
  }

  function wireChart() {
    const svg = root.querySelector(".chart svg"), tip = root.querySelector(".tip"), cursor = root.querySelector(".cursor");
    if (!svg || !cursor) return;
    const show = (clientX) => {
      const r = svg.getBoundingClientRect(), x = ((clientX - r.left) / r.width) * W;
      const p = chartPts.findLast((q) => q.x <= x) || chartPts[0]; // step chart: the live price at that x
      cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.textContent = `${p.now ? t("today") : date(new Date(p.t).toISOString())} · ${inr(p.price)}`;
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
    if (act.startsWith("range-")) return render({ range: act.slice(6) });
    if (act === "any") { const i = root.querySelector("#t"); i.disabled = btn.checked; i.required = !btn.checked; return; }
    if (act === "watch") { await setExpanded(true); return (root.querySelector("#t:not([disabled])") || root.querySelector("#any"))?.focus(); }
    if (act === "settings") { render({ menu: false }); return send({ type: "openSettings" }).catch(() => {}); }
    if (act === "mute") {
      const { mutedSites = [] } = await chrome.storage.local.get("mutedSites");
      await chrome.storage.local.set({ mutedSites: [...new Set([...mutedSites, site])] });
      return stop();
    }
    if (act === "quiet") { await chrome.storage.sync.set({ quiet: true }); return stop(); }
    if (act === "reject" && state.compare) {
      await send({ type: "rejectMatch", product: state.product, match: state.compare }).catch(() => {});
      return render({ compare: null });
    }
    if (act === "unwatch" && state.watch) {
      await send({ type: "unwatch", id: state.watch.id }).catch(() => {});
      return render({ watch: null, watchMsg: t("alert_removed") });
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const any = root.querySelector("#any").checked;
    const target_price = any ? state.product.price : Number(root.querySelector("#t").value);
    if (!(target_price > 0)) return;
    const product = state.product;
    try {
      const w = await send({ type: "watch", product, target_price, mode: any ? "any" : "target" });
      if (state.product?.product_id !== product.product_id) return;
      render({ watch: w, watchMsg: w.triggered_at ? t("already_below") : any ? t("alert_set_any") : t("alert_set", { price: inr(target_price) }) });
    } catch (err) {
      render({ watchMsg: t("alert_failed", { err: err.message }) });
    }
  }

  async function setExpanded(expanded) {
    await chrome.storage.local.set({ cardExpanded: expanded }); // remembered across products
    render({ expanded, menu: false, watchMsg: null });
  }

  // ---------- lifecycle ----------
  async function run(tries = 30) {
    if (stopped) return;
    const url = new URL(location.href);
    const store = CheaprExtract.storeFor(url);
    if (!store || !CheaprExtract.STORES[store].id(url)) { // not a product page (any more): clear right away
      if (host || state.product) { unmount(); send({ type: "clearTab" }).catch(() => {}); }
      return;
    }
    const product = CheaprExtract.extractProduct(document, location.href);
    // SPA stores update the URL before the page content: if the title still belongs to the previous product, the
    // price on screen is stale too, so wait rather than record it under the new product id. (~30s for late renders)
    const stale = product && state.product && product.product_id !== state.product.product_id && product.title === state.product.title;
    if (!product || stale) {
      if (tries > 0) setTimeout(() => run(tries - 1), 1000);
      return;
    }
    const key = `${product.store}:${product.product_id}:${product.price}`;
    if (key === lastKey) { if (!host?.isConnected) render(); return; } // SPA re-render removed us: remount
    if (!state.product || state.product.product_id !== product.product_id) { host?.remove(); host = null; }
    lastKey = key;
    const my = ++seq; // replies for an older product must not land on this one
    const { cardExpanded = false } = await chrome.storage.local.get("cardExpanded");
    const { share = false } = await chrome.storage.sync.get("share");
    render({ product, history: null, compare: null, error: null, missing: false, loading: true, expanded: cardExpanded, share, watchMsg: null, watch: null });
    try {
      const [res, watches] = await Promise.all([send({ type: "observe", product }), send({ type: "watches" }).catch(() => [])]);
      if (my !== seq) return;
      const watch = watches.find((w) => w.store === product.store && w.product_id === product.product_id) || null;
      render({ loading: false, history: res.missing ? null : res, missing: !!res.missing, watch });
      const compare = await send({ type: "compare", product }).catch(() => null);
      if (my === seq) render({ compare });
    } catch (err) {
      if (my === seq) render({ loading: false, error: err.message });
    }
  }

  async function start() {
    const [{ overlay = true, quiet = false }, { mutedSites = [] }] = await Promise.all([
      chrome.storage.sync.get(["overlay", "quiet"]), chrome.storage.local.get("mutedSites")]);
    if (!overlay || quiet || mutedSites.includes(site)) return stop();
    stopped = false;
    await CheaprI18n.load();
    run();
    // SPAs (Flipkart, Myntra) swap products without a reload, and may re-render over our card.
    let href = location.href;
    clearInterval(timer);
    timer = setInterval(() => {
      if (location.href !== href) { href = location.href; setTimeout(run, 1200); }
      else if (host && !host.isConnected && state.product) run(0);
    }, 1000);
  }

  // Settings changed in the popup apply to open tabs immediately (pause, hide, show again, language).
  chrome.storage.onChanged.addListener((changes) => {
    if (["overlay", "quiet", "mutedSites", "lang"].some((k) => k in changes)) { unmount(); start(); }
  });

  const ICON_DOWN = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_UP = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 12l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_DOTS = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="4" cy="10" r="1.7" fill="currentColor"/><circle cx="10" cy="10" r="1.7" fill="currentColor"/><circle cx="16" cy="10" r="1.7" fill="currentColor"/></svg>';

  const STYLE = `<style>
    :host{all:initial;display:block;margin:12px 0;font:13px/1.45 system-ui,-apple-system,"Segoe UI","Noto Sans Devanagari",sans-serif;color:#101828;max-width:560px}
    :host([floating]){position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;margin:0}
    *{box-sizing:border-box}
    .card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.06);position:relative}
    :host([floating]) .card{box-shadow:0 12px 32px rgba(16,24,40,.18)}
    .bar{display:flex;align-items:center;gap:8px;padding:8px 10px}
    .summary{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary>span{margin-right:6px}
    .logo{width:22px;height:22px;border-radius:6px;background:#6941c6;color:#fff;display:grid;place-items:center;font-weight:700;font-size:12px;flex:none}
    .chip{border-radius:99px;padding:2px 8px;font-size:12px;font-weight:600;white-space:nowrap;flex:none}
    .chip.good{background:#dcfae6;color:#067647}.chip.warn{background:#fef0c7;color:#93370d}.chip.bad{background:#fee4e2;color:#b42318}.chip.muted{background:#f2f4f7;color:#475467}
    .now b{font-size:15px}.sep{color:#d0d5dd}
    .act{font:inherit;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap;flex:none}
    .act:hover{background:#f9fafb}.act.primary{background:#6941c6;border-color:#6941c6;color:#fff}.act.primary:hover{background:#53389e}
    .act.icon{padding:0;width:32px;height:30px;display:inline-grid;place-items:center}.act.link{border:0;background:none;color:#475467;text-decoration:underline;padding:4px}
    a.act{text-decoration:none}
    button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #6941c6;outline-offset:2px}
    .deal{flex:none;background:#dcfae6;color:#067647;border-radius:99px;padding:2px 9px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap}
    .deal:hover{text-decoration:underline}.good{color:#067647}
    .menu{position:absolute;right:8px;top:44px;z-index:2;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.16);padding:4px;display:flex;flex-direction:column;min-width:220px}
    .menu button{font:inherit;text-align:left;background:none;border:0;padding:8px 10px;border-radius:6px;cursor:pointer;color:#344054}.menu button:hover,.menu button:focus{background:#f2f4f7}
    .body{padding:4px 14px 12px;border-top:1px solid #f2f4f7}
    .tabs{display:flex;gap:4px;margin:8px 0}
    .tabs button{font:inherit;font-size:12px;border:0;background:none;padding:3px 9px;border-radius:6px;cursor:pointer;color:#475467}
    .tabs button[aria-pressed=true]{background:#f4ebff;color:#53389e;font-weight:600}
    .chart{position:relative}.chart svg{width:100%;height:120px;display:block;touch-action:none}
    .line{fill:none;stroke:#6941c6;stroke-width:2;vector-effect:non-scaling-stroke}.area{fill:#6941c6;opacity:.07}
    .lowdot{fill:#067647}.curdot{fill:#6941c6}.cursor{stroke:#98a2b3;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
    .tip{position:absolute;top:-4px;transform:translateX(-50%);background:#101828;color:#fff;font-size:12px;padding:3px 8px;border-radius:6px;pointer-events:none;white-space:nowrap}
    .axis{display:flex;justify-content:space-between;color:#667085;font-size:11px;margin-top:2px;gap:6px}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0 4px}
    .stats div{background:#f9fafb;border-radius:8px;padding:6px 8px}.stats dt{color:#667085;font-size:11px}.stats dd{margin:0;font-weight:600}
    .cmp{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#f9fafb;border-radius:8px;padding:8px 10px;margin:8px 0}.cmp span{flex:1}
    .insights{margin:8px 0;padding:0;list-style:none}.insights li{padding:4px 0 4px 18px;position:relative}
    .insights li::before{content:"";position:absolute;left:4px;top:11px;width:6px;height:6px;border-radius:50%;background:#6941c6}
    .alert{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
    .money{display:inline-flex;align-items:center;border:1px solid #d0d5dd;border-radius:8px;padding:0 0 0 8px;color:#475467}
    .money input{border:0;width:90px;padding:5px 6px;font:inherit;background:transparent;color:#101828}.money input:disabled{color:#98a2b3}
    .any{display:inline-flex;gap:4px;align-items:center;color:#475467}
    .muted{color:#667085}.center{text-align:center}.err{color:#b42318}
    .foot{color:#98a2b3;font-size:11px;margin:10px 0 0}
    .toast{margin:0;padding:6px 14px 10px;color:#067647}
    @media (prefers-color-scheme:dark){
      :host{color:#f2f4f7}.card,.menu,.act{background:#161b26;border-color:#333741;color:#cecfd2}
      .act.primary{background:#7f56d9;border-color:#7f56d9;color:#fff}.body{border-color:#22262f}.stats div,.cmp{background:#1f242f}
      .money input{color:#f2f4f7}.menu button{color:#cecfd2}.menu button:hover,.menu button:focus,.act:hover{background:#22262f}
      .tabs button[aria-pressed=true]{background:#2c1c5f;color:#d6bbfb}.chip.muted{background:#22262f;color:#cecfd2}
    }
  </style>`;

  start(); // last: the constants above must be initialised before the first render
})();
