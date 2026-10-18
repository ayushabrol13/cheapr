// Service worker: the only part that talks to the Cheapr backend (content scripts would hit page CORS).
// Classic worker so shared libs load with importScripts. Keep no state in globals: the worker is killed when idle.
importScripts("lib/config.js", "lib/i18n.js", "lib/compare.js");

// share: anonymous price uploads (opt-in, chosen on the welcome page). spend: spend tracker (opt-in).
const DEFAULTS = { backend: CHEAPR_CONFIG.BACKEND, email: "", overlay: true, coupons: true, share: false, spend: false, quiet: false, lang: "auto" };
const SCHEMA = 3; // bump + add a step in migrate() when stored data changes shape
// Never run on banking, government, education, health or payment sites, even with the all-sites grant.
const SENSITIVE = ["*://*.gov.in/*", "*://*.nic.in/*", "*://*.gov/*", "*://*.bank.in/*", "*://*.bank/*", "*://*.edu/*",
  "*://*.ac.in/*", "*://*.edu.in/*", "*://*.res.in/*", "*://*.mil/*", "*://*.icicibank.com/*", "*://*.hdfcbank.com/*",
  "*://*.axisbank.com/*", "*://*.sbi.co.in/*", "*://*.onlinesbi.sbi/*", "*://*.kotak.com/*", "*://*.paypal.com/*",
  "*://*.paytm.com/*", "*://*.phonepe.com/*", "*://*.razorpay.com/*", "*://*.juspay.in/*", "*://*.billdesk.com/*",
  "*://*.practo.com/*", "*://*.apollo247.com/*", "*://*.incometax.gov.in/*", "*://*.irctc.co.in/*"];
const TIMEOUT_MS = 10000;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

let idPromise; // single flight: concurrent first calls must not mint two install ids
function clientId() {
  idPromise ??= (async () => {
    let { clientId } = await chrome.storage.local.get("clientId");
    if (!clientId) await chrome.storage.local.set({ clientId: (clientId = crypto.randomUUID()) });
    return clientId;
  })();
  return idPromise;
}

// Price reports use a separate random id, rotated daily and never sent with alerts, email or Telegram: the server
// can rate-limit and de-duplicate reports without being able to link browsing to an alert owner.
async function observerId() {
  const today = new Date().toISOString().slice(0, 10);
  const { observer } = await chrome.storage.local.get("observer");
  if (observer?.day === today) return observer.id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ observer: { id, day: today } });
  return id;
}

async function api(path, { method = "GET", body, query } = {}) {
  const { backend } = await settings();
  const url = new URL(path.replace(/^\//, ""), backend.endsWith("/") ? backend : backend + "/"); // keeps a path prefix
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? "server timed out" : "server unreachable");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.detail?.toString?.() || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function setTabState(tabId, state) {
  if (tabId == null) return;
  const good = ["buy", "good"].includes(state?.history?.verdict);
  chrome.action.setBadgeText({ tabId, text: good ? "↓" : "" }).catch(() => {});
  if (good) chrome.action.setBadgeBackgroundColor({ tabId, color: "#067647" }).catch(() => {});
  if (state) await chrome.storage.session.set({ [`tab:${tabId}`]: state });
  else await chrome.storage.session.remove(`tab:${tabId}`);
}

const handlers = {
  async observe({ product }, sender) {
    if ((await settings()).share) {
      await api("/api/v1/observations", { method: "POST", body: { ...product, client_id: await observerId() } }).catch(() => {});
    }
    let result;
    try {
      result = await handlers.history(product);
    } catch (e) {
      if (e.status !== 404) { await setTabState(sender?.tab?.id, null); throw e; }
      result = { missing: true };
    }
    await setTabState(sender?.tab?.id, { product, history: result.missing ? null : result });
    return result;
  },
  clearTab(_msg, sender) { // the page stopped being a product page (SPA navigation)
    return setTabState(sender?.tab?.id, null);
  },
  history({ store, product_id }) {
    return api(`/api/v1/products/${encodeURIComponent(store)}/${encodeURIComponent(product_id)}/history`);
  },
  async watch({ product, target_price, mode = "target" }) {
    const { email } = await settings();
    // Product details travel with the alert itself: a separate price report would let the server pair the
    // anonymous report id with this install by timing.
    const { store, product_id, url, title, image, price } = product;
    return api("/api/v1/watches", {
      method: "POST",
      body: { client_id: await clientId(), store, product_id, url, title, image, price, target_price, mode, email: email || null },
    });
  },
  async updateWatch({ store, product_id, target_price, mode = "target" }) {
    const { email } = await settings();
    return api("/api/v1/watches", { method: "POST", body: { client_id: await clientId(), store, product_id, target_price, mode, email: email || null } });
  },
  async unwatch({ id }) {
    return api(`/api/v1/watches/${id}`, { method: "DELETE", query: { client_id: await clientId() } });
  },
  async watches() {
    return api("/api/v1/watches", { query: { client_id: await clientId() } });
  },
  // Wishlist import: one bulk request (up to 50 items) so the server's per-IP rate limit isn't tripped.
  async importItems({ items, mode = "any" }) {
    const { email } = await settings();
    const clean = items.slice(0, 50).map(({ store, product_id, url, title, image, price }) => ({ store, product_id, url, title, image, price }));
    return api("/api/v1/watches/bulk", { method: "POST", body: { client_id: await clientId(), mode, email: email || null, items: clean } });
  },
  coupons({ store }) {
    return api("/api/v1/coupons", { query: { store } });
  },
  async couponReport({ store, code, worked, saving }) {
    return api("/api/v1/coupons/report", {
      method: "POST", body: { client_id: await clientId(), store, code, worked, saving: saving || 0 },
    });
  },
  // Same product on the other big store, searched from the user's browser. Cached 12h per product.
  async compare({ product }) {
    const other = CheaprCompare.OTHER[product.store];
    if (!other) return null;
    const key = `cmp:${product.store}:${product.product_id}`;
    const { [key]: cached, cmpReject = {} } = await chrome.storage.local.get([key, "cmpReject"]);
    if (cached && Date.now() - cached.at < 12 * 3600e3) return cached.match;
    const res = await fetch(CheaprCompare.SEARCH[other](CheaprCompare.query(product)),
      { credentials: "include", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!res?.ok) return null;
    await ensureOffscreen();
    const match = await chrome.runtime.sendMessage({ target: "offscreen", kind: "search", store: other, html: await res.text(),
      product, reject: cmpReject[key] || [] });
    await chrome.storage.local.set({ [key]: { at: Date.now(), match } });
    return match;
  },
  async rejectMatch({ product, match }) {
    const key = `cmp:${product.store}:${product.product_id}`;
    const { cmpReject = {} } = await chrome.storage.local.get("cmpReject");
    cmpReject[key] = [...new Set([...(cmpReject[key] || []), match.product_id])].slice(-20);
    await chrome.storage.local.set({ cmpReject });
    await chrome.storage.local.remove(key);
    return true;
  },
  settings,
  async emailStatus() {
    const { email } = await settings();
    return email ? api("/api/v1/email/status", { query: { client_id: await clientId(), email } }) : { verified: false, available: false };
  },
  async telegram({ action }) {
    const client_id = await clientId();
    if (action === "link") return api("/api/v1/telegram/link", { method: "POST", body: { client_id } });
    if (action === "unlink") return api("/api/v1/telegram/link", { method: "DELETE", query: { client_id } });
    return api("/api/v1/telegram/status", { query: { client_id } });
  },
  // Optional "coupons on every site": the popup obtains the host grant (needs a user gesture), we register the script.
  async setAllSiteCoupons({ enabled }) {
    const id = "coupons-all";
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    if (enabled && (await chrome.permissions.contains({ origins: ["https://*/*"] }))) {
      await chrome.scripting.registerContentScripts([{
        id, js: ["content/all-sites-flag.js", "lib/i18n.js", "lib/format.js", "content/coupons.js"], matches: ["https://*/*"], excludeMatches: SENSITIVE, runAt: "document_idle",
      }]);
    }
    return { enabled: enabled && (await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length > 0 };
  },
  // Everything Cheapr holds for this install, as one JSON document (local settings + server-side alerts).
  async exportData() {
    const [sync, local, watches] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(null),
      handlers.watches().catch(() => [])]);
    return { exported_at: new Date().toISOString(), version: chrome.runtime.getManifest().version, settings: sync,
      spend: local.spend || {}, muted_sites: local.mutedSites || [], alerts: watches };
  },
  // Erase server-side data (alerts, email consent, Telegram link), then local data. A new install id is minted.
  async deleteData() {
    await api(`/api/v1/clients/${await clientId()}`, { method: "DELETE" });
    await chrome.storage.local.clear();
    idPromise = undefined;
    await chrome.storage.local.set({ schema: SCHEMA });
    return true;
  },
  openSettings() {
    return chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html#settings") });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender)).then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await clientId();
  await migrate(reason);
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
});

// Alarms can be cleared by browser restarts or updates: ensure them every time the worker starts.
async function ensureAlarms() {
  if (!(await chrome.alarms.get("alerts"))) chrome.alarms.create("alerts", { periodInMinutes: 30 });
  if (!(await chrome.alarms.get("refresh"))) chrome.alarms.create("refresh", { periodInMinutes: 360 });
}
ensureAlarms();
chrome.runtime.setUninstallURL(CHEAPR_CONFIG.UNINSTALL_URL).catch(() => {});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "alerts") checkAlerts().catch(console.warn);
  if (a.name === "refresh") refreshWatched().then(checkAlerts).catch(console.warn);
});

// Notify each alert firing once. Keyed by id + trigger time, so an edited (re-armed) alert notifies again.
async function checkAlerts() {
  await CheaprI18n.load();
  const t = CheaprI18n.t, inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const watches = await handlers.watches();
  const { notified = [], notifyAfter = "" } = await chrome.storage.local.get(["notified", "notifyAfter"]);
  const fresh = watches.filter((w) => w.triggered_at && w.triggered_at > notifyAfter && !notified.includes(`${w.id}:${w.triggered_at}`));
  if (fresh.length > 3) { // a sale day shouldn't produce a wall of notifications
    chrome.notifications.create("digest", { type: "basic", iconUrl: "icons/128.png",
      title: t("n_digest_title", { n: fresh.length }), message: fresh.slice(0, 4).map((w) => `${inr(w.triggered_price)} · ${w.title.slice(0, 40)}`).join("\n") });
  } else {
    for (const w of fresh) {
      chrome.notifications.create(`watch:${w.id}:${w.url}`, { type: "basic", iconUrl: "icons/128.png",
        title: t("n_drop_title", { price: inr(w.triggered_price) }),
        message: t("n_drop_msg", { title: w.title.slice(0, 90), target: inr(w.target_price) }) });
    }
  }
  await chrome.storage.local.set({ notified: [...notified, ...fresh.map((w) => `${w.id}:${w.triggered_at}`)].slice(-500) });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === "digest") return chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html#alerts") });
  const url = id.split(":").slice(2).join(":");
  if (url.startsWith("https://")) chrome.tabs.create({ url });
});

// Re-check watched products from the user's own browser so alerts fire even if nobody else views them.
async function refreshWatched() {
  const pending = (await handlers.watches()).filter((w) => !w.triggered_at || w.mode === "any");
  if (!pending.length) return;
  await ensureOffscreen();
  for (const w of pending.slice(0, 40)) {
    try {
      const res = await fetch(w.url, { credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const product = res.ok && (await chrome.runtime.sendMessage({ target: "offscreen", html: await res.text(), url: w.url }));
      // One-time id per re-check: a shared id would make the set of reports mirror this user's watch list.
      if (product) await api("/api/v1/observations", { method: "POST", body: { ...product, client_id: crypto.randomUUID() } });
    } catch (e) {
      console.warn("refresh failed", w.url, e.message);
    }
    await new Promise((r) => setTimeout(r, 4000 + Math.random() * 8000)); // gentle with stores; no fixed rhythm
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Parse product and search pages for price checks",
  });
}

async function migrate(reason) {
  const { schema = reason === "install" ? SCHEMA : 1 } = await chrome.storage.local.get("schema");
  if (schema < 2) {
    // v0.1 had no consent step: keep existing users' behaviour explicit rather than silently uploading.
    const { share } = await chrome.storage.sync.get("share");
    if (share === undefined) await chrome.storage.sync.set({ share: false });
  }
  if (schema < 3) {
    // v0.2 keyed "notified" by watch id only, which suppressed re-armed alerts. Start the new keys from now on,
    // without re-notifying alerts that already fired.
    await chrome.storage.local.remove("notified");
    await chrome.storage.local.set({ notifyAfter: new Date().toISOString() });
  }
  await chrome.storage.local.set({ schema: SCHEMA });
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));
