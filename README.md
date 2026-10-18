# Cheapr

A Chrome extension and a self-hosted backend for smarter shopping in India: price history, drop alerts, auto-coupons and a private spending tracker.

| Module | What it does |
|---|---|
| **Price history** | On Amazon.in, Flipkart, Myntra and Ajio product pages, a card shows the current, lowest, average and highest price, a step chart, and a verdict ("Lowest price", "Good time to buy", "Higher than usual") |
| **Price-drop alerts** | **Watch** a product with a target price. The backend flags it when any user's visit, or your browser's background re-check every 6 hours, sees it at or below the target. You get a Chrome notification, plus an email if SMTP is configured |
| **Auto-coupons** | On checkout pages with a coupon box, Cheapr fetches known codes for that store, tries each one, keeps the best, and reports what worked so future rankings improve |
| **Spend Lens** | On your Amazon, Flipkart, Swiggy and Zomato order pages, it adds up what you've spent by year and by top merchant. It reads those pages with your existing login and **stores the results only in your browser** |

## Layout

```
cheapr/
├── extension/          Chrome MV3, plain JS, no build step
│   ├── manifest.json
│   ├── background.js   service worker: backend API, alarms, notifications
│   ├── offscreen.*     DOM parsing for background re-checks
│   ├── lib/extract.js  product detection (store rules + JSON-LD + meta fallbacks)
│   ├── content/        product.js · coupons.js · spend.js
│   ├── popup/          Watchlist · Spend Lens · Settings
│   └── test/
├── backend/            FastAPI + SQLAlchemy (Postgres in Docker, SQLite for dev)
│   ├── app/main.py     observations, history, watches, coupons
│   ├── docker-compose.yml
│   └── tests/
└── docs/                (local research notes, not published)
```

## Run it

**Backend**

```bash
cd backend
cp .env.example .env            # optional: ADMIN_TOKEN, SMTP_*
docker compose up -d --build    # API on http://localhost:8000
```

To run it without Docker:

```bash
uv venv && uv pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload    # uses ./cheapr.db
```

**Extension**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Open any Amazon.in product page. The Cheapr card appears at the bottom right.

The extension talks to `http://localhost:8000` by default. Change this in **Popup → Settings**; Chrome asks for permission to reach a remote host.

## Adding coupons

```bash
curl -X POST localhost:8000/api/v1/coupons -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"store":"myntra.com","code":"SAVE200","description":"₹200 off ₹1499"}'
```

You can also list codes in `backend/seed_coupons.json`, which is loaded at startup. When a code a user tries actually lowers their total, Cheapr adds it automatically as a user-sourced coupon. Rankings use a smoothed success rate.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/observations` | Record a seen price (deduplicated: an unchanged price within 6 hours isn't stored again) |
| GET | `/api/v1/products/{store}/{id}/history?days=90` | Price points, stats and verdict |
| POST, GET, DELETE | `/api/v1/watches` | Watchlist, keyed by an anonymous client UUID |
| GET | `/api/v1/coupons?store=myntra.com` | Ranked coupons |
| POST | `/api/v1/coupons/report` | Report whether a code worked |
| POST | `/api/v1/coupons` | Add a coupon (admin token required) |

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q        # API
node --test extension/test/*.test.mjs              # extractor
```

## Known limits

- **History starts empty.** The backend only knows prices that Cheapr users have seen. To backfill, import your own data into `prices`.
- **Selectors drift.** Store page markup changes. Fix product detection in `lib/extract.js` (JSON-LD is the most stable source) and the Spend Lens parsers in `content/spend.js`.
- **Coupon heuristics are generic.** They cover Shopify and WooCommerce plus keyword matching. Stores with custom coupon popups may need a site rule.
- **Spend Lens is best-effort.** It reads each site's own order pages and endpoints, which can change without notice. Use it on your own account only.
- **Observations are trusted** after a store-host check. Add per-client rate limiting before opening the backend to the public.
