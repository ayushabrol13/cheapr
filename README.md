# Cheapr

**Is that "70% off" real?** Cheapr is a Chrome extension (with a self-hostable server) that shows real price history right under the price on Amazon.in, Flipkart, Myntra and Ajio. It also flags fake discounts, alerts you when prices drop, and tries coupons at checkout.

There are no affiliate links, no browsing-history collection and no ads. Price sharing is anonymous and opt-in.

| | What you get |
|---|---|
| **Verdict on every product** | A compact bar under the price: *Lowest price ever · Good deal · Fair price · Usually cheaper*, plus the 3-month low and the usual price. It expands to an interactive chart (1M / 3M / 1Y / All). |
| **Fake-discount detection** | Warns when a price was raised just before a "sale", or when the MRP is far above any price ever seen. |
| **Price-drop alerts** | Set a target from the card. Alerts arrive by browser notification, Telegram or email (double opt-in). The server re-checks watched products, so alerts fire even when Chrome is closed. |
| **Coupons at checkout** | On 20 major Indian stores, one click tries every known code and keeps the best one. Rankings come from what actually worked for other users. Coupons on all sites are an optional grant. |
| **Spend Tracker** (opt-in) | Adds up your Amazon, Flipkart, Swiggy and Zomato orders by year and by merchant. **Order data never leaves your browser.** |
| **Admin dashboard** | `/admin` on the server: usage stats, recent price drops, a coupon manager and product search. |

## Install (development)

```bash
# server: API + worker + Postgres
cd backend && cp .env.example .env && docker compose up -d --build   # http://localhost:8000

# extension: chrome://extensions → Developer mode → Load unpacked → extension/
```

On install, a welcome page asks two questions: whether to share prices anonymously, and whether to turn on the Spend Tracker. Then open any Amazon.in product page.

To run the server without Docker: `uv venv && uv pip install -r requirements.txt && .venv/bin/uvicorn app.main:app` (SQLite), plus `python -m app.worker` for re-checks and Telegram.

## Configuration (`backend/.env`)

| Variable | Enables |
|---|---|
| `ADMIN_TOKEN` | `/admin` dashboard and the coupon admin API |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `PUBLIC_URL` | email alerts (with confirmation links pointing to `PUBLIC_URL`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Telegram alerts (create a bot with @BotFather) |
| `REFRESH_HOURS` | how stale a watched product can get before the worker re-checks it (default 6) |
| `TRUST_PROXY`, `RATE_LIMIT_WRITE`, `RATE_LIMIT_READ` | rate limiting behind a reverse proxy |

## Layout

```
extension/            Chrome MV3, plain JS, no build step
  background.js       service worker: API calls, alerts, badge, migrations, consent
  lib/extract.js      product detection (store rules → JSON-LD → meta), inline anchor per store
  lib/format.js       verdict labels, insight sentences, ₹ formatting
  content/            product.js (verdict card) · coupons.js · spend.js
  popup/  welcome/    This page · Alerts · Spending · Settings; onboarding + consent
  test/               unit tests + regression tests on real saved store pages
  scripts/package.sh  Web Store zip (fails on remote code / eval)
backend/
  app/main.py         API: observations, history, watches, coupons, Telegram, email opt-in, admin
  app/insights.py     verdict + fake-discount detection (time-weighted)
  app/worker.py       server-side re-checks + Telegram linking
  app/extract.py      server twin of lib/extract.js, tested on the same pages
docs/store-listing.md Chrome Web Store kit: listing copy, permission justifications, data disclosure
PRIVACY.md            privacy policy
```

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q     # API, insights, worker, extractor parity (26 tests)
cd extension && npm test                         # extractor incl. real Amazon/Flipkart/Myntra/Ajio pages
```

CI runs both suites and builds the extension zip on every push.

## Known limits

- **History starts empty.** It builds from opt-in sharing, alerts and worker re-checks. There is no paid data feed.
- **Store markup changes.** When a selector breaks, refresh the saved fixture with `test/save-fixture.py` and fix `lib/extract.js` together with `app/extract.py`. JSON-LD is the most stable source.
- **Server re-checks may hit captchas.** The worker paces itself and skips any page that doesn't return a price. Crowd observations keep history going regardless.
- **Spend Tracker and coupons are best-effort.** They read pages and endpoints that stores can change without notice.
- **Rate limits are per process.** Move them to Redis before running several API workers.

License: MIT
