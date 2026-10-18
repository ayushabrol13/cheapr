const { inr, date, verdict, insight, t } = CheaprFormat;
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
const $ = (s) => document.querySelector(s);
const https = (u) => (/^https:\/\//.test(u || "") ? u : null);
const STORES = [["Amazon", "https://www.amazon.in"], ["Flipkart", "https://www.flipkart.com"], ["Myntra", "https://www.myntra.com"], ["Ajio", "https://www.ajio.com"]];

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
}
const empty = (title, text, ...extra) => el("div", { className: "empty" }, el("b", { textContent: title }), text, ...extra);

// ---------- tabs ----------
function select(name) {
  for (const tab of document.querySelectorAll("[role=tab]")) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", on);
    $(`#${tab.dataset.tab}`).hidden = !on;
  }
}
for (const tab of document.querySelectorAll("[role=tab]")) tab.onclick = () => select(tab.dataset.tab);
document.querySelector("nav").addEventListener("keydown", (e) => { // arrow-key tab navigation
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll("[role=tab]")], i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  next.focus(); select(next.dataset.tab);
});

// ---------- this page ----------
async function renderPage() {
  const box = $("#page");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const data = tab && (await chrome.storage.session.get(`tab:${tab.id}`))[`tab:${tab.id}`];
  if (!data) {
    box.replaceChildren(empty(t("p_open_product"), t("p_works_on"),
      el("div", { className: "stores" }, STORES.map(([n, u]) => el("a", { href: u, target: "_blank", rel: "noopener", textContent: n })))));
    return;
  }
  const { product, history } = data;
  const v = history ? verdict(history.verdict) : { label: t("no_history"), tone: "muted" };
  const s = history?.stats || {};
  box.replaceChildren(
    el("div", { className: "prod" },
      https(product.image) ? el("img", { src: product.image, alt: "" }) : null,
      el("div", {}, el("div", { className: "t", textContent: product.title }),
        el("div", { className: "price", textContent: inr(product.price) }),
        el("span", { className: `chip ${v.tone}`, textContent: v.label }))),
    history ? el("div", { className: "grid" },
      el("div", {}, el("span", { textContent: t("lowest") }), inr(s.all_time_low)),
      el("div", {}, el("span", { textContent: t("usual") }), inr(s.usual ?? s.avg)),
      el("div", {}, el("span", { textContent: t("highest") }), inr(s.all_time_high))) : null,
    history ? el("ul", { className: "ins" }, history.insights.map(insight).filter(Boolean).map((line) => el("li", { textContent: line }))) : null,
    el("p", { className: "muted small", textContent: history ? t("p_checks_since", { n: s.observations, date: date(s.first_seen) }) : t("p_never_seen") }));
}

// ---------- alerts ----------
async function renderAlerts() {
  const box = $("#alerts");
  try {
    const watches = await send({ type: "watches" });
    const hits = watches.filter((w) => w.triggered_at).length;
    $("#alert-count").hidden = !hits;
    $("#alert-count").textContent = hits;
    watches.sort((a, b) => !!b.triggered_at - !!a.triggered_at);
    box.replaceChildren(...(watches.length ? watches.map(alertItem) : [empty(t("p_no_alerts"), t("p_no_alerts_hint"))]));
  } catch (e) {
    box.replaceChildren(empty(t("p_cant_reach"), e.message));
  }
}

function alertItem(w) {
  const del = el("button", { className: "x", textContent: "×", title: t("remove"), ariaLabel: t("p_remove_alert", { title: w.title }) });
  del.onclick = async () => { await send({ type: "unwatch", id: w.id }).catch(() => {}); renderAlerts(); };
  let meta;
  if (w.mode === "any") {
    meta = el("div", { className: "meta", textContent: t("p_now_any", { price: inr(w.price) }) });
  } else {
    const target = el("button", { className: "target", textContent: inr(w.target_price), title: t("p_change_target", { title: w.title }), ariaLabel: t("p_change_target", { title: w.title }) });
    target.onclick = () => {
      const input = el("input", { className: "target-input", type: "number", min: 1, value: w.target_price, ariaLabel: t("p_new_target") });
      const save = async () => {
        const v = Number(input.value);
        if (v > 0 && v !== w.target_price) await send({ type: "updateWatch", store: w.store, product_id: w.product_id, target_price: v }).catch(() => {});
        renderAlerts();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.onblur = null; renderAlerts(); } };
      input.onblur = save;
      target.replaceWith(input);
      input.focus(); input.select();
    };
    meta = el("div", { className: "meta" }, t("p_now_alert_below", { price: inr(w.price) }), target);
  }
  const gap = Math.round((w.price / w.target_price - 1) * 100);
  return el("div", { className: "item" },
    https(w.image) ? el("img", { src: w.image, alt: "" }) : null,
    el("div", { className: "info" },
      el("a", { className: "t", href: https(w.url) || "#", target: "_blank", rel: "noopener", textContent: w.title || w.product_id }),
      meta,
      w.triggered_at ? el("div", { className: "meta hit", textContent: t("p_dropped_on", { price: inr(w.triggered_price), date: date(w.triggered_at) }) })
        : w.mode === "any" ? null : el("div", { className: "meta", textContent: gap > 0 ? t("p_above_target", { pct: gap }) : t("p_at_target") })),
    del);
}

// ---------- spending ----------
const ORDER_PAGES = {
  amazon: ["Amazon", "https://www.amazon.in/your-orders/orders"],
  flipkart: ["Flipkart", "https://www.flipkart.com/account/orders"],
  swiggy: ["Swiggy", "https://www.swiggy.com/my-account/orders"],
  zomato: ["Zomato", "https://www.zomato.com/"], // then Profile → Order History
};

async function renderSpend() {
  const box = $("#spend");
  const { spend: enabled } = await chrome.storage.sync.get({ spend: false });
  if (!enabled) {
    const on = el("button", { className: "btn", textContent: t("p_spend_on") });
    on.onclick = async () => { await chrome.storage.sync.set({ spend: true }); renderSpend(); renderSettings(); };
    box.replaceChildren(empty(t("p_spend_title"), t("p_spend_desc"), el("p", {}, on)));
    return;
  }
  const { spend = {} } = await chrome.storage.local.get("spend");
  const all = Object.values(spend).flatMap((s) => s.orders);
  const year = String(new Date().getFullYear());
  const kids = [
    el("p", { className: "muted", textContent: t("p_spend_hint") }),
    el("div", { className: "links" }, Object.values(ORDER_PAGES).map(([name, url]) => el("a", { className: "btn ghost", href: url, target: "_blank", rel: "noopener", textContent: name }))),
  ];
  if (all.length) {
    const thisYear = all.filter((o) => o.date.startsWith(year)).reduce((s, o) => s + o.amount, 0);
    kids.push(el("h3", { textContent: t("p_year_so_far", { year }) }), el("div", { className: "bigtotal", textContent: inr(thisYear) }),
      el("div", { className: "muted", textContent: t("p_all_time", { total: inr(all.reduce((s, o) => s + o.amount, 0)), n: all.length }) }));
  }
  for (const [site, { orders, scannedAt }] of Object.entries(spend)) {
    const byYear = {};
    for (const o of orders) byYear[o.date.slice(0, 4)] = (byYear[o.date.slice(0, 4)] || 0) + o.amount;
    const top = topLabels(orders);
    const name = ORDER_PAGES[site]?.[0] || site;
    const clear = el("button", { className: "x", textContent: "×", title: t("p_delete_site", { site: name }), ariaLabel: t("p_delete_site", { site: name }) });
    clear.onclick = async () => { delete spend[site]; await chrome.storage.local.set({ spend }); renderSpend(); };
    kids.push(
      el("h3", { style: "display:flex;justify-content:space-between" }, `${name} · ${inr(orders.reduce((s, o) => s + o.amount, 0))}`, clear),
      el("div", { className: "meta", textContent: t("p_orders_scanned", { n: orders.length, date: date(scannedAt) }) }),
      el("table", {}, Object.entries(byYear).sort().reverse().map(([y, v]) => el("tr", {}, el("td", { textContent: y }), el("td", { textContent: inr(v) })))),
      top.length ? el("div", { className: "meta", textContent: t("p_top", { list: top.join(", ") }) }) : null);
  }
  box.replaceChildren(...kids);
}

function topLabels(orders) {
  const sum = {};
  for (const o of orders) if (o.label) sum[o.label] = (sum[o.label] || 0) + o.amount;
  return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${inr(v)})`);
}

// ---------- telegram & email ----------
async function renderTelegram() {
  const box = $("#telegram");
  const st = await send({ type: "telegram", action: "status" }).catch(() => null);
  if (!st?.available) { box.hidden = true; return; } // server has no bot configured
  box.hidden = false;
  if (st.connected) {
    const off = el("button", { type: "button", className: "btn ghost", textContent: t("s_disconnect") });
    off.onclick = async () => { await send({ type: "telegram", action: "unlink" }); renderTelegram(); };
    box.replaceChildren(el("span", { className: "ok", textContent: t("s_tg_on") }), off);
  } else {
    const on = el("button", { type: "button", className: "btn", textContent: t("s_connect") });
    on.onclick = async () => {
      const { url } = await send({ type: "telegram", action: "link" });
      chrome.tabs.create({ url }); // user presses Start in Telegram; the server links the chat
    };
    box.replaceChildren(el("span", { textContent: t("s_tg_label") }), on);
  }
}

async function renderEmailStatus() {
  const st = await send({ type: "emailStatus" }).catch(() => null);
  const f = $("#settings-form");
  $("#email-status").textContent = !f.email.value ? "" : !st?.available ? t("s_email_unavailable")
    : st.verified ? t("s_email_confirmed") : t("s_email_unconfirmed");
}

// ---------- settings ----------
async function renderSettings() {
  const s = await send({ type: "settings" });
  const f = $("#settings-form");
  for (const k of ["overlay", "share", "coupons", "spend", "quiet"]) f[k].checked = !!s[k];
  f.email.value = s.email;
  f.backend.value = s.backend;
  f.lang.value = s.lang || "auto";
  f.allSites.checked = (await chrome.scripting.getRegisteredContentScripts({ ids: ["coupons-all"] })).length > 0;
  $("#quiet-pill").hidden = !s.quiet;
  $("#version").textContent = chrome.runtime.getManifest().version;
  const { mutedSites = [] } = await chrome.storage.local.get("mutedSites");
  $("#muted").replaceChildren(...mutedSites.map((site) => {
    const b = el("button", { type: "button", className: "btn ghost", textContent: t("s_show_again") });
    b.onclick = async () => { await chrome.storage.local.set({ mutedSites: mutedSites.filter((x) => x !== site) }); renderSettings(); };
    return el("div", { className: "muted-site" }, el("span", { textContent: t("s_hidden_on", { site }) }), b);
  }));
}

const status = (text) => { $("#settings-status").textContent = text; setTimeout(() => ($("#settings-status").textContent = ""), 3000); };

$("#settings-form").addEventListener("submit", (e) => e.preventDefault());
$("#settings-form").addEventListener("change", async (e) => {
  const f = e.currentTarget, name = e.target.name;
  if (name === "allSites") {
    // permissions.request must run in the user-gesture turn of the click; keep it first.
    const granted = e.target.checked ? await chrome.permissions.request({ origins: ["https://*/*"] }) : false;
    if (!e.target.checked) await chrome.permissions.remove({ origins: ["https://*/*"] }).catch(() => {});
    const { enabled } = await send({ type: "setAllSiteCoupons", enabled: granted });
    e.target.checked = enabled;
    return status(enabled ? t("s_coupons_all_on") : t("s_coupons_all_off"));
  }
  const backend = f.backend.value.replace(/\/+$/, "");
  if (name === "backend") {
    let origin;
    try { origin = new URL(backend).origin; } catch { return status(t("s_bad_url")); }
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !(await chrome.permissions.request({ origins: [origin + "/*"] }))) {
      return status(t("s_perm_declined"));
    }
  }
  if (name === "email" && f.email.value && !f.email.checkValidity()) return status(t("s_bad_email"));
  await chrome.storage.sync.set({
    overlay: f.overlay.checked, share: f.share.checked, coupons: f.coupons.checked, spend: f.spend.checked,
    quiet: f.quiet.checked, email: f.email.value.trim(), backend, lang: f.lang.value,
  });
  $("#quiet-pill").hidden = !f.quiet.checked;
  if (name === "lang") return location.reload(); // re-render every string in the new language
  status(t("s_saved"));
  if (name === "spend") renderSpend();
  if (name === "backend") renderAlerts();
  if (name === "email" || name === "backend") renderEmailStatus();
});

$("#export").onclick = async () => {
  try {
    const data = await send({ type: "exportData" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    el("a", { href: url, download: `cheapr-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    status(t("s_failed", { err: e.message }));
  }
};

$("#delete").onclick = async () => {
  if (!confirm(t("s_delete_confirm"))) return;
  try {
    await send({ type: "deleteData" });
    status(t("s_deleted"));
    renderAlerts(); renderSpend(); renderSettings();
  } catch (e) {
    status(t("s_failed", { err: e.message }));
  }
};

// ---------- boot ----------
CheaprI18n.load().then(() => {
  CheaprI18n.apply();
  if (location.hash === "#settings" || location.hash === "#alerts") {
    document.body.classList.add("tab");
    select(location.hash.slice(1));
  }
  renderPage();
  renderAlerts();
  renderSpend();
  renderTelegram();
  renderSettings().then(renderEmailStatus);
});
