// Checkout pages: find the coupon box, fetch known codes for this store, try them on request, keep the best.
// Also learns: a code the shopper types themselves that lowers the total is reported as working (how the
// coupon list grows without an admin).
(() => {
  if (window.__cheaprCoupons) return; // curated + optional all-sites registrations can both match
  window.__cheaprCoupons = true;

  const { inr, t } = CheaprFormat;
  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
  const store = location.hostname.toLowerCase().replace(/^www\./, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el && el.offsetParent !== null && !el.disabled;
  const CHECKOUT = /cart|checkout|basket|bag|payment/i;
  const CODE = /^[A-Za-z0-9_-]{2,40}$/;

  // Known platforms first (Shopify, WooCommerce), then a keyword heuristic.
  const INPUT_SEL = 'input[name="reductions"], #coupon_code, input[name="coupon_code"], input[name*="coupon" i], input[id*="coupon" i], input[placeholder*="coupon" i], input[placeholder*="promo" i], input[name*="promo" i], input[placeholder*="voucher" i], input[aria-label*="coupon" i], input[aria-label*="discount" i]';
  const findInput = () => [...document.querySelectorAll(INPUT_SEL)].find(visible);

  // Only look for buttons in the coupon box itself: its form, or the nearest ancestor holding few buttons.
  // Climbing further reaches cart rows ("Remove" item) and address/payment blocks ("Use this address").
  function couponBox(input) {
    if (input.form && input.form.querySelectorAll("button, [role=button], input[type=submit]").length <= 4) return input.form;
    let el = input.parentElement;
    for (let i = 0; i < 3 && el?.parentElement; i++) {
      if (el.parentElement.querySelectorAll("button, [role=button], input[type=submit]").length > 4) break;
      el = el.parentElement;
    }
    return el || input.parentElement;
  }

  function findButton(input, words) {
    const re = new RegExp(`^\\s*(${words})\\s*$`, "i"); // the whole label, not a substring
    return [...couponBox(input).querySelectorAll('button, [role="button"], input[type="submit"]')]
      .find((b) => visible(b) && re.test((b.textContent || b.value || b.getAttribute("aria-label") || "").trim()));
  }

  // Reads the payable total: prefer explicit "grand/order total" labels, fall back to a bare "Total".
  function readTotal() {
    const labels = [/grand total|order total|total payable|amount payable|you pay|to pay|total amount/i, /^\s*total\s*$/i];
    const els = [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && el.textContent.length < 40);
    for (const re of labels) {
      for (const el of els.filter((e) => re.test(e.textContent)).reverse()) {
        const row = el.closest("tr, li, div") || el.parentElement;
        const m = row?.textContent.replace(el.textContent, "").replace(/,/g, "").match(/(?:₹|rs\.?|inr|\$)\s*(\d+(?:\.\d+)?)/i);
        if (m) return Number(m[1]);
      }
    }
    return null;
  }

  function setValue(input, value) {
    // React/Vue track the native setter; assigning .value alone is ignored by their state.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Returns {before, after} totals, or null when the coupon box disappeared (code applied as a chip, modal closed).
  async function tryCode(code) {
    const input = findInput();
    if (!input) return null;
    const before = readTotal();
    setValue(input, code);
    const btn = findButton(input, "apply|apply coupon|apply code|redeem|check|submit");
    if (btn) btn.click();
    else input.form?.requestSubmit();
    for (let i = 0; i < 12; i++) { // up to ~6s for the store to re-price
      await sleep(500);
      const now = readTotal();
      if (now != null && now !== before) return { before, after: now };
    }
    return { before, after: readTotal() };
  }

  async function removeCode() {
    const input = findInput();
    const btn = input && findButton(input, "remove|remove coupon|clear|×|✕|x");
    if (btn) { btn.click(); await sleep(2000); }
    return !!findInput();
  }

  async function tryAll(coupons, ui) {
    const base = readTotal();
    if (base == null) return ui(t("no_total"));
    let best = null;
    for (const [i, c] of coupons.entries()) {
      ui(t("trying", { code: c.code, i: i + 1, n: coupons.length }));
      const r = await tryCode(c.code);
      if (!r) break; // coupon box gone: stop rather than report codes we never actually tried
      // Unchanged total while an earlier code is still applied tells us nothing about this code.
      const known = r.after != null && (r.after !== r.before || r.before === base);
      const saving = known ? base - r.after : 0;
      if (known) send({ type: "couponReport", store, code: c.code, worked: saving > 0, saving: Math.max(0, saving) }).catch(() => {});
      if (saving > 0 && (!best || saving > best.saving)) best = { code: c.code, saving };
      if (!(await removeCode())) break;
    }
    if (!best) return ui(t("no_coupon_worked"));
    await tryCode(best.code);
    ui(t("applied_save", { code: best.code, amount: inr(best.saving) }));
  }

  // Learn from the shopper: watch their own apply clicks and report codes that lowered the total.
  function learnFromShopper(input) {
    if (input.__cheaprLearn) return;
    input.__cheaprLearn = true;
    couponBox(input).addEventListener("click", async (e) => {
      if (!e.isTrusted || !e.target.closest('button, [role="button"], input[type="submit"]')) return; // real user clicks only
      const code = input.value.trim().toUpperCase(), before = readTotal();
      if (!CODE.test(code) || before == null) return;
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        const after = readTotal();
        if (after != null && after < before) {
          send({ type: "couponReport", store, code, worked: true, saving: before - after }).catch(() => {});
          return;
        }
      }
    }, true);
  }

  let badge;
  function showBadge(coupons) {
    if (badge?.isConnected) return;
    badge = document.createElement("cheapr-coupons");
    const root = badge.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;font:13px/1.4 system-ui,"Noto Sans Devanagari",sans-serif}
      div{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.15);padding:10px 14px;display:flex;gap:10px;align-items:center;color:#101828}
      button{background:#6941c6;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit}
      button:focus-visible{outline:2px solid #6941c6;outline-offset:2px}button:disabled{opacity:.5;cursor:default}
      .x{background:none;color:#667085;padding:2px 6px;font-size:16px}
      @media (prefers-color-scheme:dark){div{background:#161b26;border-color:#333741;color:#f2f4f7}}
    </style><div role="status"><span></span><button class="try"></button><button class="x"></button></div>`;
    const msg = root.querySelector("span"), btn = root.querySelector(".try"), x = root.querySelector(".x");
    msg.textContent = coupons.length > 1 ? t("coupons_have", { n: coupons.length }) : t("coupons_have_1");
    btn.textContent = coupons.length > 1 ? t("try_codes", { n: coupons.length }) : t("try_code");
    x.textContent = "×";
    x.setAttribute("aria-label", t("dismiss_week"));
    x.onclick = async () => {
      const { couponDismissed = {} } = await chrome.storage.local.get("couponDismissed");
      await chrome.storage.local.set({ couponDismissed: { ...couponDismissed, [store]: Date.now() } });
      badge.remove();
    };
    btn.onclick = async () => {
      btn.disabled = true;
      await tryAll(coupons, (text) => (msg.textContent = text));
      btn.remove();
    };
    document.documentElement.append(badge);
  }

  let scanning = false;
  async function scan() {
    if (scanning || !CHECKOUT.test(location.pathname + location.hash)) return;
    scanning = true;
    try {
      const [{ coupons: enabled, quiet }, { couponDismissed = {} }] = await Promise.all([
        chrome.storage.sync.get({ coupons: true, quiet: false }), chrome.storage.local.get("couponDismissed")]);
      if (!enabled || quiet) { badge?.remove(); return; }
      for (let i = 0; i < 15 && !findInput(); i++) await sleep(2000); // coupon boxes often render late
      const input = findInput();
      if (!input) return;
      learnFromShopper(input);
      if (Date.now() - (couponDismissed[store] || 0) < 7 * 864e5) return; // dismissed: quiet for a week
      const list = await send({ type: "coupons", store }).catch(() => []);
      if (list.length) showBadge(list.slice(0, 15));
    } finally {
      scanning = false;
    }
  }

  CheaprI18n.load().then(scan);
  // SPA stores reach the cart without a page load; settings changes apply to open tabs.
  let href = location.href;
  setInterval(() => { if (location.href !== href) { href = location.href; scan(); } }, 1500);
  chrome.storage.onChanged.addListener((c) => { if ("coupons" in c || "quiet" in c || "lang" in c) { badge?.remove(); CheaprI18n.load().then(scan); } });
})();
