// Service worker: the only part that talks to the Cheapr backend (content scripts would hit page CORS).
// share: anonymous price uploads (opt-in, chosen on the welcome page). spend: spend tracker (opt-in).
const DEFAULTS = { backend: "http://localhost:8000", email: "", overlay: true, coupons: true, share: false, spend: false, quiet: false };
const SCHEMA = 2; // bump + add a step in migrate() when stored data changes shape

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

async function clientId() {
  let { clientId } = await chrome.storage.local.get("clientId");
  if (!clientId) await chrome.storage.local.set({ clientId: (clientId = crypto.randomUUID()) });
  return clientId;
}

async function api(path, { method = "GET", body, query } = {}) {
  const { backend } = await settings();
  const url = new URL(path, backend);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.detail?.toString?.() || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const handlers = {
  async observe({ product }, sender) {
    if ((await settings()).share) await api("/api/v1/observations", { method: "POST", body: product }).catch(() => {});
    let result;
    try {
      result = await handlers.history(product);
    } catch (e) {
      if (e.status !== 404) throw e;
      result = { missing: true };
    }
    if (sender?.tab?.id != null) {
      const tabId = sender.tab.id, good = ["buy", "good"].includes(result.verdict);
      chrome.action.setBadgeText({ tabId, text: good ? "↓" : "" });
      if (good) chrome.action.setBadgeBackgroundColor({ tabId, color: "#067647" });
      chrome.storage.session.set({ [`tab:${tabId}`]: { product, history: result.missing ? null : result } });
    }
    return result;
  },
  history({ store, product_id }) {
    return api(`/api/v1/products/${encodeURIComponent(store)}/${encodeURIComponent(product_id)}/history`);
  },
  async watch({ product, target_price }) {
    const { email } = await settings();
    // Setting an alert is an explicit request to track this product, so record its price even if sharing is off.
    await api("/api/v1/observations", { method: "POST", body: product });
    return api("/api/v1/watches", {
      method: "POST",
      body: { client_id: await clientId(), store: product.store, product_id: product.product_id, target_price, email: email || null },
    });
  },
  async updateWatch({ store, product_id, target_price }) {
    const { email } = await settings();
    return api("/api/v1/watches", { method: "POST", body: { client_id: await clientId(), store, product_id, target_price, email: email || null } });
  },
  async unwatch({ id }) {
    return api(`/api/v1/watches/${id}`, { method: "DELETE", query: { client_id: await clientId() } });
  },
  async watches() {
    return api("/api/v1/watches", { query: { client_id: await clientId() } });
  },
  coupons({ store }) {
    return api("/api/v1/coupons", { query: { store } });
  },
  async couponReport({ store, code, worked, saving }) {
    return api("/api/v1/coupons/report", {
      method: "POST", body: { client_id: await clientId(), store, code, worked, saving: saving || 0 },
    });
  },
  settings,
  // Optional "coupons on every site": the popup obtains the host grant (needs a user gesture), we register the script.
  async setAllSiteCoupons({ enabled }) {
    const id = "coupons-all";
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    if (enabled && (await chrome.permissions.contains({ origins: ["https://*/*"] }))) {
      await chrome.scripting.registerContentScripts([{ id, js: ["content/coupons.js"], matches: ["https://*/*"], runAt: "document_idle" }]);
    }
    return { enabled: enabled && (await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length > 0 };
  },
  openSettings() {
    return chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html#settings") });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, _sender)).then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

// ---------- alerts & background refresh ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  clientId();
  await migrate(reason);
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
  chrome.alarms.create("alerts", { periodInMinutes: 30 });
  chrome.alarms.create("refresh", { periodInMinutes: 360 });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "alerts") checkAlerts().catch(console.warn);
  if (a.name === "refresh") refreshWatched().then(checkAlerts).catch(console.warn);
});

async function checkAlerts() {
  const watches = await handlers.watches();
  const { notified = [] } = await chrome.storage.local.get("notified");
  for (const w of watches.filter((w) => w.triggered_at && !notified.includes(w.id))) {
    chrome.notifications.create(`watch:${w.id}:${w.url}`, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: `Price drop: ${w.currency || "₹"}${Math.round(w.triggered_price).toLocaleString("en-IN")}`,
      message: `${w.title.slice(0, 90)} hit your target of ₹${w.target_price.toLocaleString("en-IN")}`,
    });
    notified.push(w.id);
  }
  await chrome.storage.local.set({ notified: notified.slice(-500) });
}

chrome.notifications.onClicked.addListener((id) => {
  const url = id.split(":").slice(2).join(":");
  if (url.startsWith("https://")) chrome.tabs.create({ url });
});

// Re-check watched products from the user's own browser so alerts fire even if nobody else views them.
async function refreshWatched() {
  const pending = (await handlers.watches()).filter((w) => !w.triggered_at);
  if (!pending.length) return;
  await ensureOffscreen();
  for (const w of pending) {
    try {
      const html = await (await fetch(w.url, { credentials: "omit" })).text();
      const product = await chrome.runtime.sendMessage({ target: "offscreen", html, url: w.url });
      if (product) await api("/api/v1/observations", { method: "POST", body: product });
    } catch (e) {
      console.warn("refresh failed", w.url, e);
    }
    await new Promise((r) => setTimeout(r, 3000)); // be gentle with stores
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Parse product pages for watched prices",
  });
}

async function migrate(reason) {
  const { schema = reason === "install" ? SCHEMA : 1 } = await chrome.storage.local.get("schema");
  if (schema < 2) {
    // v0.1 had no consent step: keep existing users' behaviour explicit rather than silently uploading.
    const { share } = await chrome.storage.sync.get("share");
    if (share === undefined) await chrome.storage.sync.set({ share: false });
  }
  await chrome.storage.local.set({ schema: SCHEMA });
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));
