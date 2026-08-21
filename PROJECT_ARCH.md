# Paws Delivered — Project Architecture

## Overview

A pet marketplace that imports listings from pbtmarketplace.com and resells them, with the operator handling checkout (CashApp) and ground transportation (via delivery partner Puppy Travelers). The stack is entirely Cloudflare-native with no build step and no frontend framework. This document describes only what's actually built — if it drifts from the real code, fix the doc, not the reader's understanding.

---

## Platform & Infrastructure

| Layer    | Technology                      |
|----------|----------------------------------|
| Runtime  | Cloudflare Workers               |
| Database | Cloudflare D1 (SQLite)           |
| Hosting  | Cloudflare Workers Static Assets |
| Config   | `wrangler.toml`                  |

Worker bindings (from `wrangler.toml`):
- `env.DB` — D1 database
- `env.ASSETS` — static file serving

Worker secrets (`wrangler secret put`):
- `ADMIN_TOKEN` — required. Gates every `/api/admin/*` route. Must stay a Worker secret, not a DB row (it can't be stored behind the very check it powers).
- `RESEND_API_KEY` / `RESEND_SENDER_EMAIL` / `RESEND_SENDER_NAME` — optional. Order-confirmation emails (buyer + admin) are a no-op if `RESEND_API_KEY` is unset. Sending requires a domain verified with Resend (SPF/DKIM DNS records) — `RESEND_SENDER_EMAIL` must be an address at that verified domain.
- `ADMIN_NOTIFICATION_EMAIL` — optional. If unset, the admin copy of the order-confirmation email is simply not sent.

Everything else configurable at runtime — CashApp cashtag/instructions, company/waybill info, pricing markup, and the scraper's own pbtmarketplace.com login — lives in the `settings` D1 table and is editable from the admin console's Settings page. There is no on-chain wallet, no BTC/USD price feed, and no user accounts anywhere in this project.

---

## Folder Structure

```
/
├── public/                    # Static frontend (served by env.ASSETS)
│   ├── index.html             # Landing page
│   ├── browse.html            # Pet listings grid
│   ├── pet.html                # Single listing detail + CashApp checkout flow
│   ├── how-it-works.html
│   ├── about.html
│   ├── contact.html           # Static Puppy Travelers phone numbers, no form/widget
│   ├── privacy.html
│   ├── terms.html
│   ├── navbar.js              # Shared nav — injected as IIFE, no module system
│   ├── shared.js              # Shared client utils (escHtml, formatUsd, ageFromDob, ...)
│   └── admin/                 # Admin console — all admin-token-gated
│       ├── admin.js           # Shared shell: token capture/persistence, nav, adminFetch()
│       ├── index.html         # Dashboard (summary counts)
│       ├── orders.html        # Payment queue + sold/paid history + waybill printing
│       ├── waybill.html       # Print-formatted waybill (standalone, no nav — see below)
│       ├── seller-blacklist.html
│       └── settings.html      # CashApp config, company/waybill info, PBT login
├── src/
│   └── worker.js               # Entire backend: routing, handlers, scraper, cron
├── schema.sql                  # D1 schema (source of truth for the database)
└── wrangler.toml                # Workers config: bindings, cron triggers
```

`admin/waybill.html` deliberately does **not** load `admin.js` — it's meant to print cleanly, and `admin.js` injects a nav header with no `.no-print` wrapper that would otherwise show up in the printed output. It reads/writes the same `sessionStorage` token key directly instead.

---

## Design Pattern

### Backend (`src/worker.js`)

- **Single-file backend.** All request handling lives in `worker.js`. There is no module bundler and no imports — the project has zero npm dependencies.
- **Manual router.** `handleApi()` matches URL patterns with `===` and `RegExp.match()`. New routes go here — no routing library. `handleApi()` is routing only; no logic lives inside it.
- **Handler functions are top-level async functions.** Each route has one dedicated function (e.g. `handleCreateOrder`, `handleConfirmPayment`).
- **Admin auth via `checkAdminToken(request, env, url)`.** Every `/api/admin/*` handler calls this first and returns 401 if it's false. Deny-if-unset, not fail-open.
- **All API responses use the `json(data, status)` helper.** Never construct `new Response(JSON.stringify(...))` inline.
- **Settings reads go through `getSettingsMap(env, keys)`.** Don't write ad hoc `SELECT value FROM settings WHERE key=...` queries scattered around handlers.
- **Cron** (`scheduled` export) runs two passes: `*/5 * * * *` expires overdue pending orders; `*/30 * * * *` syncs listings from pbtmarketplace.com.

### Frontend (`public/`)

- **Vanilla HTML + CSS + JS only.** No React, Vue, Svelte, or any frontend framework. No npm, no bundler.
- **One HTML file per page.** Logic specific to a page lives in a `<script>` tag at the bottom of that page's HTML file.
- **Styles are per-page `<style>` blocks.** No external stylesheet. CSS custom properties (variables) define the color palette (`--blue` for links/accents, `--coral` for primary CTAs) and are declared in `:root`/`:root[data-theme="dark"]` on each page that needs them.
- **`navbar.js` + `shared.js` are the only shared public-site files.** `navbar.js` is an IIFE that injects the `<nav>` element and its styles plus the light/dark theme toggle. All public pages include both via `<script src="/navbar.js">`/`<script src="/shared.js">`.
- **`admin/admin.js` is the equivalent for the admin console.** It captures the `?token=` query param once, persists it to `sessionStorage`, injects a shared nav + shared CSS component classes (`.admin-card`, `.admin-btn`, `.admin-table`, ...), and exposes `adminFetch()`/`adminUrl()`/`adminTokenGate()` so individual admin pages never duplicate token-handling or re-implement the same card/table CSS.
- **No inline `style="..."` attributes** on elements (except dynamically set ones in JS where a class isn't practical).

### Data & Scraping

- **Scraped fields are limited to an approved list**: photos, age (via `date_of_birth`), weight, sex, breed, registry name, vaccinations, worming, and price. Description, vet comments/health info, microchip ID, and sire/dam info are never scraped or stored — don't add those columns/extraction back in without an explicit requirements change.
- **Images are hotlinked directly from PBT's own S3 URLs.** Never proxied, never re-uploaded, never routed through the Worker.
- **The `worming` field's extraction regex is a best-effort guess** (mirrors the vaccine-pair pattern against unconfirmed class names). Verify it via `GET /api/admin/pbt-debug?pbt_id=...&token=...` against a real live listing before trusting it, and correct the class names in `pbtScrapeDetail` once confirmed. Don't remove that debug route until this is done.
- **Pet status lifecycle:** `available` → `pending` (order created) → `sold` (admin manually confirms payment) or back to `available` (order expired, or admin never confirms in time). Listings no longer present on pbtmarketplace.com (or from a blacklisted seller) flip to `ended`; only pets sold through Paws Delivered are retained indefinitely — everything else reflects PBT's current listing set.

### Payments (CashApp, extensible)

- **CashApp only for now**, confirmed **manually** by an admin — CashApp has no public API this Worker can poll to verify an individual payment. `orders.payment_method` has no `CHECK` constraint specifically so a future method (e.g. `'paypal'`) can be added without a migration.
- **`marked_paid_at` is the buyer's own claim, not proof.** It flags an order for the admin's payment queue but never changes `status`. Only `handleConfirmPayment` (admin-only) sets `status='paid'` + `paid_at`.
- **`settings` is the extension point for payment config**, not new columns on `orders` or `pets`. CashApp's cashtag/note, the company/waybill info, and the pricing markup all live there.

---

## Golden Rules

1. **No frontend framework, no bundler, no npm dependencies.** `worker.js` has zero imports.
2. **No CSS framework.** `<style>` blocks with CSS custom properties.
3. **No inline styles** on HTML elements (dynamic JS-set exceptions only).
4. **All API responses go through `json()`.**
5. **Every `/api/admin/*` handler calls `checkAdminToken()` first** and returns 401 immediately if it's false.
6. **Photos are always hotlinked from PBT's S3 URLs, never proxied.**
7. **Scraped fields are limited to the approved list** (see Data & Scraping above) — never silently reintroduce description/health_info/microchip_id/sire-dam.
8. **`schema.sql` is canonical.** Schema changes go there first, applied with `wrangler d1 execute`.
9. **`orders.payment_method` + the `settings` table are the extension points for new payment methods.** Never hardcode a second method into column names.
10. **`handleApi()` is routing only.** No logic lives inside it — just pattern matching and dispatch calls.
11. **If a handler exceeds ~60 lines, decompose it.** Extract private helpers named after the handler.
12. **Each `// ── Section ──` block has a ~150-line soft budget.** Exceeding it is a signal to extract helpers, not a hard stop.
13. **TEMPORARY debug routes are labeled as such and actually removed once their purpose is served** — e.g. `GET /api/admin/pbt-debug` stays only until the worming-extraction regex is verified against real markup.
14. **Admin pages share `admin.js`.** Never duplicate a per-page token box, `apiUrl()` helper, or the shared card/table CSS.
15. **Keep `worker.js` under a soft ~1500-line budget.** There's no on-chain/crypto code in this project, so it should stay comfortably under that.
