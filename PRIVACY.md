# Cheapr privacy policy

_Last updated: 18 October 2026 (v0.3)_

Cheapr has one purpose: helping you pay less on Indian shopping sites. It collects only what that purpose needs, and nothing that identifies you.

## What the extension sends to the Cheapr server

| When | What is sent | Why |
|---|---|---|
| You open a product page and **"Share prices anonymously" is on** (off until you choose it) | store, product ID, product URL without tracking parameters, title, image URL, price, MRP, in-stock flag | builds the price history everyone sees |
| You **set a price alert** | the same product details, your target price, a random install ID, and your alert email if you entered one | so the server can tell you when the price drops |
| You open a product page | the store and product ID, to fetch its history | to show history and the verdict |
| A coupon box appears on a supported store's checkout | the store's domain; after you press "Try codes", each code and whether it lowered the total | to rank coupons by whether they actually work |
| You import a wishlist | each item's store, product ID, title, image URL and price, plus your install ID | to create the alerts you asked for |
| You connect Telegram | your random install ID, which is linked to the chat that pressed Start | to send alerts on Telegram |

The **random install ID** is generated on your device and is used only for your alerts, email confirmation and Telegram link. It is not tied to your name, Google account, or browsing.

**Price reports** carry a *different* random ID that rotates every day (background re-checks use a fresh one each time) and is never sent with alerts, email or Telegram. Setting an alert sends the product details with the alert itself, not as a separate report. The server stores only a hash of the report ID, plus a hash of your network (for example, the first three parts of an IPv4 address), to stop one person from faking many reports.

Like any website, the server sees the IP address each request comes from. Cheapr does not store raw IP addresses, but a server operator could in principle correlate requests by IP at the moment they arrive. This is the limit of what an extension can promise.

**Coupon learning:** if anonymous sharing is on and you apply a code yourself on one of the 20 supported stores, Cheapr reports whether it lowered your total. Codes learned this way are shown to others only after several different people confirm them.

## What your browser fetches directly (never sent to us)

- **Price comparison:** on an Amazon or Flipkart product page, your browser runs a search on the other store using the product's name. This is the same request you'd make by searching yourself. The result is compared on your device; only the matched product is kept, in local storage, for 12 hours.
- **Watched-price re-checks:** your browser re-opens watched product pages in the background to read the current price.

## What Cheapr never collects or does

- No browsing history. Content scripts run only on supported shopping sites, and the "all sites" coupon option is off unless you grant it.
- No affiliate links, no cookie changes, and no redirects. Cheapr does not earn money from your purchases.
- No selling, renting or sharing of data with third parties. No ads, no analytics SDKs, no remote code.
- **Spend Tracker data never leaves your browser.** Order totals read from your own order pages are stored only in `chrome.storage.local` on your device. You can delete them from the popup at any time.

## Email alerts

Cheapr emails an address only after you confirm it through a link in a confirmation email. Each address receives at most 20 alerts a day. To stop alerts, remove the alert or the email in the popup.

## Retention and deletion

- **Price observations** are kept to show history and contain no personal data.
- **Alerts** are deleted when you remove them.
- **Uninstalling** the extension deletes everything stored on your device.
- **Delete my data** (popup → Settings) erases your alerts, email confirmation and Telegram link on the server, then clears local data. **Export my data** downloads everything as JSON.
- Mail-throttling records keep only a one-way hash of your address. Price observations carry only hashed install and network tags.

## Who runs the server

Cheapr is open source (MIT). Each Cheapr deployment is run by its operator, who is responsible for the server it connects to. Contact for this deployment: open an issue at https://github.com/ayushabrol13/cheapr/issues.
