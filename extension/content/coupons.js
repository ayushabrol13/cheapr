// Checkout pages: find the coupon box, fetch known codes for this store, try them all, keep the best.
(() => {
  if (!/cart|checkout|basket|bag|payment/i.test(location.pathname + location.hash)) return;

  const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r.data : Promise.reject(new Error(r?.error))));
  const store = location.hostname.toLowerCase().replace(/^www\./, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el && el.offsetParent !== null && !el.disabled;
  const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

  // Known platforms first (Shopify, WooCommerce), then a keyword heuristic.
  const INPUT_SEL = 'input[name="reductions"], #coupon_code, input[name="coupon_code"], input[name*="coupon" i], input[id*="coupon" i], input[placeholder*="coupon" i], input[placeholder*="promo" i], input[name*="promo" i], input[placeholder*="voucher" i], input[aria-label*="coupon" i], input[aria-label*="discount" i]';

  const findInput = () => [...document.querySelectorAll(INPUT_SEL)].find(visible);

  function findButton(input, re) {
    for (let el = input.parentElement, i = 0; el && i < 5; el = el.parentElement, i++) {
      const b = [...el.querySelectorAll('button, [role="button"], input[type="submit"]')]
        .find((b) => visible(b) && re.test(b.textContent + " " + (b.value || "") + " " + (b.getAttribute("aria-label") || "")));
      if (b) return b;
    }
    return null;
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

  async function tryCode(code) {
    const input = findInput();
    if (!input) return null;
    // Wait for a change from the total right before this attempt, not the original base:
    // if the previous code couldn't be removed, the base comparison would credit it to this code.
    const before = readTotal();
    setValue(input, code);
    const btn = findButton(input, /apply|redeem|submit|use/i);
    if (btn) btn.click();
    else input.form?.requestSubmit();
    for (let i = 0; i < 12; i++) { // up to ~6s for the store to re-price
      await sleep(500);
      const t = readTotal();
      if (t != null && t !== before) return { before, after: t };
    }
    return { before, after: readTotal() };
  }

  async function removeCode() {
    const input = findInput();
    const btn = input && findButton(input, /remove|clear|×|✕/i);
    if (btn) { btn.click(); await sleep(2000); }
  }

  async function tryAll(coupons, ui) {
    const base = readTotal();
    if (base == null) return ui("Couldn't read the order total on this page.");
    let best = null;
    for (const [i, c] of coupons.entries()) {
      ui(`Trying ${c.code} (${i + 1}/${coupons.length})…`);
      const r = await tryCode(c.code);
      // Unchanged total while an earlier code is still applied tells us nothing about this code.
      const saving = r?.after != null && (r.after !== r.before || r.before === base) ? base - r.after : 0;
      send({ type: "couponReport", store, code: c.code, worked: saving > 0, saving: Math.max(0, saving) }).catch(() => {});
      if (saving > 0 && (!best || saving > best.saving)) best = { code: c.code, saving };
      await removeCode();
    }
    if (!best) return ui("No coupon lowered your total.");
    await tryCode(best.code);
    ui(`Applied ${best.code}: you save ${inr(best.saving)}.`);
  }

  function showBadge(coupons) {
    const host = document.createElement("cheapr-coupons");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host{all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483647;font:13px/1.4 system-ui,sans-serif}
      div{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 8px 24px rgba(16,24,40,.15);padding:10px 14px;display:flex;gap:10px;align-items:center;color:#101828}
      button{background:#6941c6;color:#fff;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit}
      button:focus-visible{outline:2px solid #6941c6;outline-offset:2px}
      button:disabled{opacity:.5;cursor:default}
    </style><div role="status"><span></span><button>Try all</button></div>`;
    const msg = root.querySelector("span"), btn = root.querySelector("button");
    msg.textContent = `Cheapr found ${coupons.length} coupon${coupons.length > 1 ? "s" : ""}`;
    btn.onclick = async () => {
      btn.disabled = true;
      await tryAll(coupons, (t) => (msg.textContent = t));
      btn.remove();
    };
    document.documentElement.append(host);
  }

  (async () => {
    const { coupons: enabled } = await chrome.storage.sync.get({ coupons: true });
    if (!enabled) return;
    for (let i = 0; i < 15 && !findInput(); i++) await sleep(2000); // coupon boxes often render late
    if (!findInput()) return;
    const list = await send({ type: "coupons", store }).catch(() => []);
    if (list.length) showBadge(list.slice(0, 15));
  })();
})();
