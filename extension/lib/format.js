// Shared display helpers for content scripts and the popup (classic script; needs lib/i18n.js loaded first).
(() => {
  const { t } = CheaprI18n;
  const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const inr = (n) => (n == null || !Number.isFinite(Number(n)) ? "–" : "₹" + nf.format(Number(n)));
  const date = (iso) => new Date(iso).toLocaleDateString(CheaprI18n.lang === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short" });

  const TONES = { buy: "good", good: "good", fair: "warn", wait: "bad", new: "muted" };
  const verdict = (v) => ({ label: t(`v_${TONES[v] ? v : "new"}`), tone: TONES[v] || "muted" });

  // Sentence for each backend insight kind. Unknown kinds are skipped so the backend can add new ones.
  function insight(i) {
    switch (i.kind) {
      case "all_time_low": return t("i_all_time_low");
      case "window_low": return t("i_window_low", { days: i.days });
      case "drop": return t("i_drop", { pct: i.pct, from: inr(i.from), date: date(i.since) });
      case "rise": return t("i_rise", { pct: i.pct, from: inr(i.from), date: date(i.since) });
      case "inflated_sale": return t("i_inflated_sale", { peak: inr(i.peak), usual: inr(i.usual) });
      case "inflated_mrp": return t("i_inflated_mrp", { highest: inr(i.highest), pct: i.real_discount_pct });
      default: return null;
    }
  }

  globalThis.CheaprFormat = { inr, date, verdict, insight, t };
})();
