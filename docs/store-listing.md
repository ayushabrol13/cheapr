# Chrome Web Store submission kit

## Listing

**Name:** Cheapr: Price History, Fake-Deal Alerts & Coupons
**Category:** Shopping
**Single purpose:** Help you pay less on Indian shopping sites. It does this with price history and deal verdicts on product pages, price-drop alerts, and coupons at checkout.

**Short description (132 chars max):**
See real price history on Amazon, Flipkart, Myntra & Ajio, spot fake discounts, get price-drop alerts and try coupons. No tracking.

**Description:**
> Is that "70% off" real? Cheapr shows you, right under the price.
>
> • Price history on Amazon.in, Flipkart, Myntra and Ajio product pages, with an interactive chart
> • A clear verdict: Lowest ever, Good deal, Fair price, or Usually cheaper
> • Fake-discount warnings: when a price was raised just before a "sale", or the MRP is inflated
> • Price-drop alerts by browser notification, Telegram or email, even when Chrome is closed
> • Coupons at checkout on 20 major Indian stores: one click tries every code and keeps the best
> • Compare across stores: see if the same product is cheaper on Flipkart or Amazon
> • Import your Amazon or Flipkart wishlist and get told about every price drop
> • Spend Tracker (optional): adds up your Amazon, Flipkart, Swiggy and Zomato orders, entirely on your device
> • Available in English and हिन्दी
>
> What Cheapr never does: no affiliate links or cookie swapping, no browsing-history collection, no selling data. Price sharing is anonymous and opt-in.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Saves your settings, alerts cache and (optional) Spend Tracker totals on your device. |
| `alarms` | Checks for triggered price alerts every 30 minutes and re-checks watched products every 6 hours. |
| `notifications` | Shows a desktop notification when a watched product drops below your target price. |
| `offscreen` | Parses product pages fetched for watched-price re-checks, because service workers have no DOM parser. |
| `scripting` | Registers the coupon finder on other shopping sites only after you turn on "On all shopping sites" and grant access. |
| Host: amazon.in, flipkart.com, myntra.com, ajio.com | Reads the product price on product pages to show history, re-checks watched products, and searches the other store for the same product (price comparison). |
| Host: the Cheapr server | Fetches price history and saves alerts. Release builds add it automatically (`BACKEND_URL`). |
| Content scripts on Amazon/Flipkart wishlists | Offers a one-click import of wishlist items as alerts. |
| Content scripts on 20 Indian store domains | Detects the coupon box at checkout on those stores. |
| Content scripts on swiggy.com, zomato.com (and the stores above) | Spend Tracker, off by default: reads your own order pages when you press "Scan orders". |
| Optional host `https://*/*` | Requested only when you enable coupons on all shopping sites, or point Cheapr at your own server. |

**Remote code:** none. All JavaScript ships in the package, and `scripts/package.sh` fails the build if it finds remote scripts or `eval`.

## Privacy practices tab (data disclosure)

- **Collected:** website content (product title and price, from shopping pages only, opt-in); user activity (coupon code success, on user action). Email address only if the user enters one for alerts.
- **Not collected:** personally identifiable information, health, financial or payment info, authentication info, personal communications, location, web history.
- **Certify:** data is not sold, is not used for purposes unrelated to the single purpose, and is not used for creditworthiness.
- **Privacy policy URL:** https://github.com/ayushabrol13/cheapr/blob/main/PRIVACY.md

## Release checklist

1. Bump the `version` in `extension/manifest.json`.
2. Run `npm test` in `extension/` and `pytest` in `backend/`, against both SQLite and Postgres (CI does both).
3. Run `BACKEND_URL=https://<your server> extension/scripts/package.sh`, then upload `extension/dist/cheapr-<version>.zip`. Never upload a `-dev` zip, because it points at localhost.
5. Screenshots at 1280×800: the product card collapsed and expanded, the popup's Alerts tab, and the welcome page.
