const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const $ = (s) => document.querySelector(s);

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
}

// ---------- tabs ----------
for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll("[role=tab]")) {
      t.setAttribute("aria-selected", t === tab);
      $(`#${t.dataset.tab}`).hidden = t !== tab;
    }
  };
}

// ---------- watchlist ----------
async function renderWatches() {
  const box = $("#watch");
  try {
    const watches = await send({ type: "watches" });
    box.replaceChildren(...(watches.length ? watches.map(watchItem)
      : [el("p", { className: "muted", textContent: "Nothing watched yet. Open a product on Amazon, Flipkart, Myntra or Ajio and press Watch." })]));
  } catch (e) {
    box.replaceChildren(el("p", { className: "muted", textContent: `Backend unreachable (${e.message}). Check Settings.` }));
  }
}

function watchItem(w) {
  const safeUrl = /^https:\/\//.test(w.url) ? w.url : "#";
  const del = el("button", { textContent: "×", title: "Stop watching", ariaLabel: `Stop watching ${w.title}` });
  del.onclick = async () => { await send({ type: "unwatch", id: w.id }); renderWatches(); };
  return el("div", { className: "item" },
    w.image ? el("img", { src: w.image, alt: "" }) : null,
    el("div", {},
      el("a", { href: safeUrl, target: "_blank", rel: "noopener", textContent: w.title || w.product_id }),
      el("div", { className: "meta" }, `${w.store} · now ${inr(w.price)} · target ${inr(w.target_price)} `,
        w.triggered_at ? el("span", { className: "hit", textContent: `Dropped to ${inr(w.triggered_price)}` }) : null)),
    del);
}

// ---------- spend lens ----------
const ORDER_PAGES = {
  amazon: ["Amazon", "https://www.amazon.in/your-orders/orders"],
  flipkart: ["Flipkart", "https://www.flipkart.com/account/orders"],
  swiggy: ["Swiggy", "https://www.swiggy.com/my-account/orders"],
  zomato: ["Zomato", "https://www.zomato.com/"], // then Profile → Order History
};

async function renderSpend() {
  const { spend = {} } = await chrome.storage.local.get("spend");
  const box = $("#spend");
  const all = Object.values(spend).flatMap((s) => s.orders);
  const kids = [
    el("p", { className: "muted", textContent: "Open an order page, sign in, and press “Scan orders”. Data stays on this device." }),
    el("div", { className: "links" }, ...Object.entries(ORDER_PAGES).map(([, [name, url]]) =>
      el("a", { href: url, target: "_blank", rel: "noopener", textContent: name }))),
  ];
  if (all.length) kids.push(el("h3", { textContent: `All sites: ${inr(all.reduce((s, o) => s + o.amount, 0))} over ${all.length} orders` }));
  for (const [site, { orders, scannedAt }] of Object.entries(spend)) {
    const byYear = {};
    for (const o of orders) byYear[o.date.slice(0, 4)] = (byYear[o.date.slice(0, 4)] || 0) + o.amount;
    const top = topLabels(orders);
    kids.push(
      el("h3", { textContent: `${ORDER_PAGES[site]?.[0] || site}: ${inr(orders.reduce((s, o) => s + o.amount, 0))}` }),
      el("div", { className: "meta muted", textContent: `${orders.length} orders · scanned ${new Date(scannedAt).toLocaleDateString()}` }),
      el("table", {}, ...Object.entries(byYear).sort().reverse().map(([y, v]) => el("tr", {}, el("td", { textContent: y }), el("td", { textContent: inr(v) })))),
      top.length ? el("div", { className: "meta muted", textContent: `Top: ${top.join(", ")}` }) : null,
    );
  }
  box.replaceChildren(...kids.filter(Boolean));
}

function topLabels(orders) {
  const sum = {};
  for (const o of orders) if (o.label) sum[o.label] = (sum[o.label] || 0) + o.amount;
  return Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${inr(v)})`);
}

// ---------- settings ----------
async function renderSettings() {
  const s = await send({ type: "settings" });
  const f = $("#settings-form");
  f.backend.value = s.backend;
  f.email.value = s.email;
  f.overlay.checked = s.overlay;
  f.coupons.checked = s.coupons;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const backend = f.backend.value.replace(/\/+$/, "");
    const origin = new URL(backend).origin + "/*";
    // Remote backends need a runtime host grant; localhost is granted in the manifest.
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(backend).origin)
        && !(await chrome.permissions.request({ origins: [origin] }))) {
      $("#settings-status").textContent = "Permission to reach that backend was declined.";
      return;
    }
    await chrome.storage.sync.set({ backend, email: f.email.value.trim(), overlay: f.overlay.checked, coupons: f.coupons.checked });
    $("#settings-status").textContent = "Saved.";
    renderWatches();
  };
}

renderWatches();
renderSpend();
renderSettings();
