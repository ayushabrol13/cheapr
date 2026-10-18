const { inr, date, VERDICTS, insight } = CheaprFormat;
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
  for (const t of document.querySelectorAll("[role=tab]")) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", on);
    $(`#${t.dataset.tab}`).hidden = !on;
  }
}
for (const t of document.querySelectorAll("[role=tab]")) t.onclick = () => select(t.dataset.tab);
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
    box.replaceChildren(empty("Open a product to see its price history",
      "Cheapr works on product pages of these stores:",
      el("div", { className: "stores" }, STORES.map(([n, u]) => el("a", { href: u, target: "_blank", rel: "noopener", textContent: n })))));
    return;
  }
  const { product, history } = data;
  const v = history ? VERDICTS[history.verdict] || VERDICTS.new : { label: "No history yet", tone: "muted" };
  const s = history?.stats || {};
  box.replaceChildren(
    el("div", { className: "prod" },
      https(product.image) ? el("img", { src: product.image, alt: "" }) : null,
      el("div", {}, el("div", { className: "t", textContent: product.title }),
        el("div", { className: "price", textContent: inr(product.price) }),
        el("span", { className: `chip ${v.tone}`, textContent: v.label }))),
    history ? el("div", { className: "grid" },
      el("div", {}, el("span", { textContent: "Lowest" }), inr(s.all_time_low)),
      el("div", {}, el("span", { textContent: "Usual" }), inr(s.usual ?? s.avg)),
      el("div", {}, el("span", { textContent: "Highest" }), inr(s.all_time_high))) : null,
    history ? el("ul", { className: "ins" }, history.insights.map(insight).filter(Boolean).map((t) => el("li", { textContent: t }))) : null,
    el("p", { className: "muted small", textContent: history ? `${s.observations} price checks since ${date(s.first_seen)}. Set alerts from the card on the page.` : "Cheapr hasn't seen this product's price before." }));
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
    box.replaceChildren(...(watches.length ? watches.map(alertItem)
      : [empty("No alerts yet", "On any product page, open the Cheapr card and choose “Set alert”.")]));
  } catch (e) {
    box.replaceChildren(empty("Can't reach the Cheapr server", e.message));
  }
}

function alertItem(w) {
  const gap = Math.round((w.price / w.target_price - 1) * 100);
  const target = el("button", { className: "target", textContent: inr(w.target_price), title: "Change target", ariaLabel: `Change target for ${w.title}` });
  target.onclick = () => {
    const input = el("input", { className: "target-input", type: "number", min: 1, value: w.target_price, ariaLabel: "New target price" });
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
  const del = el("button", { className: "x", textContent: "×", title: "Remove alert", ariaLabel: `Remove alert for ${w.title}` });
  del.onclick = async () => { await send({ type: "unwatch", id: w.id }); renderAlerts(); };
  return el("div", { className: "item" },
    https(w.image) ? el("img", { src: w.image, alt: "" }) : null,
    el("div", { className: "info" },
      el("a", { className: "t", href: https(w.url) || "#", target: "_blank", rel: "noopener", textContent: w.title || w.product_id }),
      el("div", { className: "meta" }, `${inr(w.price)} now · alert below `, target),
      w.triggered_at ? el("div", { className: "meta hit", textContent: `Dropped to ${inr(w.triggered_price)} on ${date(w.triggered_at)}` })
        : el("div", { className: "meta", textContent: gap > 0 ? `${gap}% above your target` : "At or below target" })),
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
    const on = el("button", { className: "btn", textContent: "Turn on Spend Tracker" });
    on.onclick = async () => { await chrome.storage.sync.set({ spend: true }); renderSpend(); renderSettings(); };
    box.replaceChildren(empty("See what you really spend", "Add up your orders on Amazon, Flipkart, Swiggy and Zomato. Order data never leaves this browser.", el("p", {}, on)));
    return;
  }
  const { spend = {} } = await chrome.storage.local.get("spend");
  const all = Object.values(spend).flatMap((s) => s.orders);
  const year = String(new Date().getFullYear());
  const kids = [
    el("p", { className: "muted", textContent: "Open an order page, sign in, then press “Scan orders” on the page." }),
    el("div", { className: "links" }, Object.values(ORDER_PAGES).map(([name, url]) => el("a", { className: "btn ghost", href: url, target: "_blank", rel: "noopener", textContent: name }))),
  ];
  if (all.length) {
    const thisYear = all.filter((o) => o.date.startsWith(year)).reduce((s, o) => s + o.amount, 0);
    kids.push(el("h3", { textContent: `${year} so far` }), el("div", { className: "bigtotal", textContent: inr(thisYear) }),
      el("div", { className: "muted", textContent: `All time: ${inr(all.reduce((s, o) => s + o.amount, 0))} over ${all.length} orders` }));
  }
  for (const [site, { orders, scannedAt }] of Object.entries(spend)) {
    const byYear = {};
    for (const o of orders) byYear[o.date.slice(0, 4)] = (byYear[o.date.slice(0, 4)] || 0) + o.amount;
    const top = topLabels(orders);
    const clear = el("button", { className: "x", textContent: "×", title: `Delete ${site} data`, ariaLabel: `Delete ${site} spending data` });
    clear.onclick = async () => { delete spend[site]; await chrome.storage.local.set({ spend }); renderSpend(); };
    kids.push(
      el("h3", { style: "display:flex;justify-content:space-between" }, `${ORDER_PAGES[site]?.[0] || site} · ${inr(orders.reduce((s, o) => s + o.amount, 0))}`, clear),
      el("div", { className: "meta", textContent: `${orders.length} orders · scanned ${date(scannedAt)}` }),
      el("table", {}, Object.entries(byYear).sort().reverse().map(([y, v]) => el("tr", {}, el("td", { textContent: y }), el("td", { textContent: inr(v) })))),
      top.length ? el("div", { className: "meta", textContent: `Top: ${top.join(", ")}` }) : null);
  }
  box.replaceChildren(...kids);
}

function topLabels(orders) {
  const sum = {};
  for (const o of orders) if (o.label) sum[o.label] = (sum[o.label] || 0) + o.amount;
  return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${inr(v)})`);
}

// ---------- telegram ----------
async function renderTelegram() {
  const box = $("#telegram");
  const st = await send({ type: "telegram", action: "status" }).catch(() => null);
  if (!st?.available) { box.hidden = true; return; } // server has no bot configured
  box.hidden = false;
  if (st.connected) {
    const off = el("button", { type: "button", className: "btn ghost", textContent: "Disconnect" });
    off.onclick = async () => { await send({ type: "telegram", action: "unlink" }); renderTelegram(); };
    box.replaceChildren(el("span", { className: "ok", textContent: "✓ Telegram alerts on" }), off);
  } else {
    const on = el("button", { type: "button", className: "btn", textContent: "Connect" });
    on.onclick = async () => {
      const { url } = await send({ type: "telegram", action: "link" });
      chrome.tabs.create({ url }); // user presses Start in Telegram; the server links the chat
    };
    box.replaceChildren(el("span", { textContent: "Get alerts on Telegram" }), on);
  }
}

// ---------- settings ----------
async function renderSettings() {
  const s = await send({ type: "settings" });
  const f = $("#settings-form");
  for (const k of ["overlay", "share", "coupons", "spend", "quiet"]) f[k].checked = !!s[k];
  f.email.value = s.email;
  f.backend.value = s.backend;
  f.allSites.checked = (await chrome.scripting.getRegisteredContentScripts({ ids: ["coupons-all"] })).length > 0;
  $("#quiet-pill").hidden = !s.quiet;
  $("#version").textContent = chrome.runtime.getManifest().version;

  const { mutedSites = [] } = await chrome.storage.local.get("mutedSites");
  $("#muted").replaceChildren(...mutedSites.map((site) => {
    const b = el("button", { type: "button", className: "btn ghost", textContent: "Show again" });
    b.onclick = async () => { await chrome.storage.local.set({ mutedSites: mutedSites.filter((x) => x !== site) }); renderSettings(); };
    return el("div", { className: "muted-site" }, el("span", { textContent: `Hidden on ${site}` }), b);
  }));
}

const status = (t) => { $("#settings-status").textContent = t; setTimeout(() => ($("#settings-status").textContent = ""), 2500); };

$("#settings-form").addEventListener("submit", (e) => e.preventDefault());
$("#settings-form").addEventListener("change", async (e) => {
  const f = e.currentTarget, name = e.target.name;
  if (name === "allSites") {
    // permissions.request must run in the user-gesture turn of the click; keep it first.
    const granted = e.target.checked ? await chrome.permissions.request({ origins: ["https://*/*"] }) : false;
    if (!e.target.checked) await chrome.permissions.remove({ origins: ["https://*/*"] }).catch(() => {});
    const { enabled } = await send({ type: "setAllSiteCoupons", enabled: granted });
    e.target.checked = enabled;
    return status(enabled ? "Coupons enabled on all sites." : "Coupons limited to supported stores.");
  }
  if (name === "backend") {
    const origin = new URL(f.backend.value).origin;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !(await chrome.permissions.request({ origins: [origin + "/*"] }))) {
      return status("Permission to reach that server was declined.");
    }
  }
  if (name === "email" && f.email.value && !f.email.checkValidity()) return status("That email doesn't look right.");
  await chrome.storage.sync.set({
    overlay: f.overlay.checked, share: f.share.checked, coupons: f.coupons.checked, spend: f.spend.checked,
    quiet: f.quiet.checked, email: f.email.value.trim(), backend: f.backend.value.replace(/\/+$/, ""),
  });
  $("#quiet-pill").hidden = !f.quiet.checked;
  status("Saved.");
  if (name === "spend") renderSpend();
  if (name === "backend") renderAlerts();
});

// ---------- boot ----------
if (location.hash === "#settings") { document.body.classList.add("tab"); select("settings"); }
renderPage();
renderAlerts();
renderSpend();
renderSettings();
renderTelegram();
