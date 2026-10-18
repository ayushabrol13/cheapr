// Shared display helpers for content scripts and the popup (classic script; exposes globalThis.CheaprFormat).
(() => {
  const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const inr = (n) => (n == null || !Number.isFinite(Number(n)) ? "–" : "₹" + nf.format(Number(n)));
  const date = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  const VERDICTS = {
    buy: { label: "Lowest price ever", tone: "good" },
    good: { label: "Good deal", tone: "good" },
    fair: { label: "Fair price", tone: "warn" },
    wait: { label: "Usually cheaper", tone: "bad" },
    new: { label: "Tracking started", tone: "muted" },
  };

  // Plain-text sentence for each backend insight kind. Unknown kinds are skipped so the backend can add new ones.
  function insight(i) {
    switch (i.kind) {
      case "all_time_low": return "Lowest price we've ever recorded.";
      case "window_low": return `Lowest price in the last ${i.days} days.`;
      case "drop": return `Dropped ${i.pct}% from ${inr(i.from)} on ${date(i.since)}.`;
      case "rise": return `Up ${i.pct}% from ${inr(i.from)} on ${date(i.since)}.`;
      case "inflated_sale": return `Heads up: price was raised to ${inr(i.peak)} recently. Today's "deal" is about the usual ${inr(i.usual)}.`;
      case "inflated_mrp": return `MRP looks inflated: we've never seen it above ${inr(i.highest)}. Real discount vs usual price: ${i.real_discount_pct}%.`;
      default: return null;
    }
  }

  globalThis.CheaprFormat = { inr, date, VERDICTS, insight };
})();
