---
name: fish-chips-order
description: QR scan-to-order system for a fish & chips shop, with POS integration and an AI ordering agent ("Order & Track") that includes a fishing mini-game rewards mechanic. Use this skill whenever building, extending, or debugging any part of the fish-chips-order system (backend, customer-facing web order app, POS adapter, or gamification).
---

## Project Overview
QR-scan-to-order system for a fish & chips shop. Customer scans a table QR, orders from a web menu, order goes to the POS/kitchen, and after checkout the customer can play a short fishing mini-game for a chance at a reward voucher (discount, free drink, or free chips) redeemable on their next visit.

## Stack — as built
The plan called for FastAPI + Next.js. What actually shipped is Node, and new work should match it:

- **Backend:** Node 20 + TypeScript (ESM, strict) + Express 4 + MongoDB (the driver, no ODM)
- **Web:** no framework and no build step — hand-written HTML/CSS/JS served by Express.
  `src/web/` is the customer app (one client-rendered document); `src/staff-web/` is the staff area.
  The customer page is opened by scanning a QR at the table, so it has to load on a bad connection.
- **Validation:** Zod at every edge (HTTP query/body, agent tool input)
- **Uploads:** `multer` to local disk, served read-only — see *Menu management* below
- **Auth:** one shared staff password (`STAFF_PASSWORD`), guarding every staff page and every
  `/api/staff/*` route. No library and no per-user accounts — see *Staff auth* below. The customer
  side has no auth at all and is not meant to.
- **Hosting:** Railway
- **Tests:** Vitest. `npm test` and `npm run typecheck` both have to pass; the web tests boot the
  real page against the real server in jsdom.
- **Optional later:** React Native/Expo for a staff kitchen-display (KDS) app

## Current Status

### Built
1. **Menu** — categories, items, option groups (fish type, chips size, sauces, ice, sugar), allergen
   and dietary filtering, portion info, suggestions for the undecided customer
2. **Ordering** — QR-linked order page at `/order?table=<table_id>`, cart with running total,
   confirmed orders, table carried from the scan onto the ticket
3. **Payments** — Stripe (cards) + Revenue Monster (e-wallets/DuitNow) behind a `PaymentAdapter`,
   webhooks with real signature verification, simulated when no credentials are configured
4. **Staff area** — five views: kitchen status, daily sales total, sales reporting, menu management
   and table QR codes, all behind one shared password. See *Staff area* and *Staff auth* below.

### Not built yet
5. POS adapter — behind a `POSAdapter` interface so the backend is swappable. **[DECISION NEEDED]**
   Loyverse, Square, something local, or none yet — start with a mock adapter that logs + prints a ticket
6. Customer-facing order status tracking (`get_order_status`) — staff set the status, but the
   customer cannot yet watch it. Reuses the same field the staff pages update.
7. Fishing mini-game + voucher generation. **[DECISION NEEDED]** guaranteed reward per order vs.
   true random chance of nothing
8. Staff voucher redemption screen
9. AI agent conversational layer ("Order & Track") on top of the above

Ask before deciding anything not specified here (exact menu items, styling details, etc.).

## Staff area

Five views plus a login screen under `STAFF_DASHBOARD_PATH` (default `/staff`), sharing one nav and one
stylesheet in `src/staff-web/assets/`:

| Path | View | What it does |
| --- | --- | --- |
| `/` | **Dashboard** | Today's orders in Received / Cooking / Ready columns; running Today's Sales Total in the header |
| `/kitchen` | **Kitchen & Counter** | The same active orders as cards, each with the one action its status calls for |
| `/sales` | **Sales Report** | Date range (defaults to today), summary cards, sales-by-day chart, daily breakdown table |
| `/menu` | **Menu** | Add / edit / delete items, upload photos, one-tap availability toggle |
| `/qr` | **Table QR Codes** | Type the tables, generate, print the sheet or download a PNG each |
| `/login` | **Sign in** | The one page outside the gate. No nav, one password field — see *Staff auth* |

Each view is its own document rather than a client-side router, so a tablet on the pass reloads into
the view it was showing. Add a sixth view by adding one entry to `STAFF_VIEWS` in
`src/staff-web/assets/nav.js`, one HTML file, and one route — the nav is defined once.

The mount path is substituted into each page at serve time (`{{STAFF_BASE}}` → the configured path),
because relative asset URLs would resolve differently on `/staff` and `/staff/kitchen`. Live updates
are short polling of `GET /api/staff/overview` every 2s, not a websocket: one shop, one process, and
a dropped socket on a kitchen tablet that silently stops updating is worse than a request every two
seconds. The header shows `not updating` when the feed stalls.

### Kitchen status: Received → Cooking → Ready → Collected

`collected` means handed to the customer. It is a real status but **not a column**: the ticket drops
off both boards, while staying in the day's trade so the sales report still counts it. The Kitchen &
Counter view is where it is set ("Mark Collected"); the Dashboard's chain still ends at Ready.

Any status is accepted rather than forward-only — a mis-tap on a busy pass has to be undoable, and
a shared password means there is no per-person audit trail to protect anyway. The change is
idempotent, so a double-tap is not an error. Kitchen status never touches payment status: money and food move independently.

### Menu management

The menu is editable from `/menu`. It is **one document** in Mongo (collection `menu`, `_id:
"current"`), held in memory by `MenuStore` and written through on every edit. That shape is
deliberate:

- Reads stay **synchronous**. `MenuService.getMenu`, `priceCart` and every cart mutation read the
  snapshot, and making that async would turn the whole pricing path into promises for no gain.
- Staff edits are visible to pricing and to the customer page immediately, because both read the
  same snapshot.
- One document keeps `items`, `categories` and `version` consistent with each other. At tens of
  items a per-item collection buys nothing.
- With no `MONGODB_URI`, the seed menu in `src/menu/data/menu.ts` still serves — edits just do not
  survive a restart.

**Categories are staff-editable free text**, not the closed enum they used to be. A typed name is
slugged to an id (`Sides & Dips` → `sides-dips`) and reused rather than duplicated, so "Sides" and
"sides " are one section. A section that empties out disappears, except the four the shop opened
with. The form's `datalist` suggests sections already in use.

**The availability toggle is its own endpoint** that can touch nothing else. It fires on a single tap
during service, so it must not be able to carry a stale price with it. Turning an item back on clears
any `unavailableReason`, which described the old state.

**Prices are an integer count of sen everywhere**, including the staff form (`priceSen`). The form
converts from ringgit and back; nothing on the wire is a float.

Deleting an item leaves a cart that still holds it failing to price with `unknown_item` — the same
400 an unavailable item already produced.

### Table QR codes

`src/qr/tables.ts` owns the table list, the URL each code carries and the image; the staff page and
`npm run qr` are two callers of it. **Generated per request, never stored** — a code is a pure
function of the public URL and the table number, so there is nothing to keep and nothing to go stale
when `PUBLIC_BASE_URL` changes. The page gets data URIs (shown, printed, saved with `<a download>`);
the CLI writes PNGs plus a print sheet, which is the right shape for forty stickers.

Error correction is level `Q` — a sticker in a chip shop gets smudged. Codes point at
`/order?table=N`, which always opens a fresh session. Tests decode both the files and the page's
data URIs with a real QR reader: the failure worth catching is a code that renders and does not scan.

The route sits behind the staff password like the rest of `/api/staff`, which is the reason this can
be a page at all: an open route that mints table codes hands anyone a link that opens an order
against someone else's table.

### Image upload storage — and the Railway volume it needs

- Photos are written to `UPLOADS_DIR/menu-items/`, and `UPLOADS_DIR` defaults to `uploads` beside
  the working directory. Railway's working directory is `/app`, so that resolves to
  **`/app/uploads/menu-items/`** with no configuration.
- They are served read-only at **`/uploads/*`** (`express.static`, `nosniff`, a restrictive CSP,
  dotfiles denied). The item's `imageUrl` stores the **served path**, not the disk path, so moving
  the directory does not rewrite the menu.
- Filenames are a fresh uuid plus the extension for the detected type. The uploaded name is never
  reused: it is attacker-controlled and may not be a safe path segment.
- Limits: **5 MB**, one file, and **JPEG / PNG / WebP / GIF / AVIF only**. SVG is refused because it
  can carry script and these files are served from the same origin as the app.
- Replacing or deleting an image unlinks the file it replaced, best effort — an orphaned file wastes
  a few hundred kilobytes, whereas failing the staff member's actual request over a failed unlink
  would be worse.

> **MANUAL RAILWAY STEP — not done in code, and not checked for.**
> A container filesystem is wiped on every redeploy. Attach a **persistent volume mounted at
> `/app/uploads`** to the service in the Railway dashboard (Service → Settings → Volumes), the same
> pattern as the volume behind the MongoDB service. Do not try to configure this from code.
> A missing volume looks exactly like a working directory until the next deploy, when every stored
> image URL starts 404ing while the menu still lists the items.

### Staff auth — one shared password

Everything under the staff path and everything under `/api/staff/` is behind a single password that
the whole shop shares. Deliberately not per-user accounts: one shop, one tablet on the pass, and
individual logins would be ceremony that ends with the password written on the wall anyway. It lives
in `src/staff/auth.ts`.

> **MANUAL RAILWAY STEP — set `STAFF_PASSWORD` in the service's variables before this protects
> anything in production.** It is a plain string, set in the Railway dashboard (Service → Variables),
> never committed. With it unset the gate is **off** and the staff area is as open as it was before
> this shipped — the deliberate choice, so local development and the tests run without a secret, but
> it means a deploy that forgot the variable is unprotected. It is loud rather than silent: the
> server warns at startup, and `GET /health` reports `"staffAuth": "disabled"` until it is set.

**The flow.** `POST /api/staff/login { password }` → 200 and a `staff_session` cookie, or 401
`invalid_password`. A browser hitting any staff page without a valid cookie is **302'd** to
`{STAFF_DASHBOARD_PATH}/login?next=<where it was going>`; sign in and it lands where it was headed.
`POST /api/staff/logout` clears the cookie; the **Log out** button in the shared header calls it.
Any staff API call that comes back 401 sends the page to the login screen — that is how a session
expiring mid-service is handled, in `api()` in `assets/common.js` (and by hand in `menu.html`, whose
upload builds its own multipart request).

**The session** is a payload plus an HMAC over it — no JWT library, because nothing here needs one:
this is a cookie the server issues to itself, not a token for a third party to read. Details that
matter if you touch it:

- **The signing key is derived from the password itself** (`sha256("…:v1:" + STAFF_PASSWORD)`). So
  there is no second secret to configure, changing the password **invalidates every existing
  session** — which is how you revoke access on the day someone leaves — and a restart or redeploy
  does *not* sign the kitchen out.
- **12-hour expiry.** Longer than the longest shift; a tablet left on overnight signs in again in
  the morning.
- Cookie is `httpOnly`, `SameSite=Lax`, `Path=/` (it has two consumers under different prefixes),
  and `Secure` whenever `PUBLIC_BASE_URL` is https.
- The password is compared in constant time, over sha256 digests so a length mismatch cannot throw
  and leak the real length.
- **Failed logins are throttled** per client address: 8 in 10 minutes and the endpoint 429s without
  looking at the password at all. In-memory, per-process — a speed bump against online guessing of a
  shared password on a public URL, not a defence against one that has leaked.

**The gate is mounted at the prefix** (`server.use("/api/staff", requireStaffApi)`), above every
staff route, so **a route added later is protected without anyone having to remember**. `/login`,
`/logout` and `/session` are exempted inside the middleware rather than by sitting above it, so
reordering `app.ts` cannot quietly open a hole. Page guarding is `requireStaffPage` on each view's
route — server-side on purpose: a guard running in the page's own script can only hide a document
that has already been sent. The shared assets stay ungated; they are code, not data, and the login
screen needs its own stylesheet.

Login page is `src/staff-web/login.html` (`data-staff-view="login"`, no nav — there is nothing to
navigate to yet). It honours `?next=` only for same-site paths: an absolute URL there would be an
open redirect, on exactly the sort of page a phisher would want one.

**What this still is not.** There is no audit trail — every action is "a staff member", which is why
kitchen status stays freely reversible. There is no lockout for a leaked password other than
changing it. And the customer API is untouched and stays open, which is the point.

### Staff HTTP surface

Everything below requires a valid session cookie; without one they answer 401 `staff_auth_required`.

```
POST   /api/staff/login                         { password } -> sets staff_session cookie
POST   /api/staff/logout                        # clears it
GET    /api/staff/session                       # { authenticated, authRequired } for the login page

GET    /api/staff/overview                      # board + today's takings (polled by the pages)
PATCH  /api/staff/orders/:orderId/status        { status: received|cooking|ready|collected }
GET    /api/staff/sales-report?start_date=&end_date=

GET    /api/staff/qr-codes?tables=1-12&base_url=  # table codes as PNG data URIs

GET    /api/staff/menu-items                    # every item, sold-out ones included
POST   /api/staff/menu-items                    # multipart: image? + name, priceSen, category, …
PUT    /api/staff/menu-items/:id                # multipart; patches whatever is sent
PATCH  /api/staff/menu-items/:id/availability   { available }
DELETE /api/staff/menu-items/:id
```

- `PATCH …/status` is the verb the pages use. `POST` to the same path still works — it shipped
  first, and a kitchen tablet holding a cached page must not break on a deploy.
- `sales-report` buckets **paid** orders by the day their money landed, in the shop's own timezone,
  one query for the whole window. Both dates default to today; one date means one day. Every day in
  range comes back, quiet ones as zeroes — a week missing its quiet Monday reads as a six-day week.
  Range is capped at 366 days. Errors: `invalid_date`, `invalid_date_range`, `range_too_long`.
- `PUT` patches rather than replaces, so an edit form that only changes the price does not have to
  resend the description. `removeImage=true` clears a photo without uploading a replacement.
- Errors carry a machine-readable code: `unknown_menu_item` (404), `missing_field`, `field_too_long`,
  `invalid_price`, `invalid_category`, `unsupported_image_type`, `invalid_upload` (400).

### Availability is shown, not hidden

`GET /api/menu` — what the customer app reads — **includes** sold-out items, with `categoryId` and
`available` on every item. The customer page groups by category and renders an unavailable item
greyed out, not clickable, with "Currently unavailable" (and the reason) where the price would be.
Hiding it only moves "do you still do the cod?" to the counter.

The agent's own `get_menu` tool still hides them by default, because it must never offer something
the fryer cannot make. That is the one deliberate difference between the two.

## Totals: one function, tax included

`orderTotals(subtotalSen)` in `src/orders/pricing.ts` is **the only place an order total is worked
out**. `subtotalSen` is the sum of the priced lines (item price + option deltas, × quantity);
`taxSen = Math.round(subtotalSen * TAX_RATE)` with `TAX_RATE = 0.1`; `totalSen` is the two added.
Sen are integers throughout — the single `Math.round` is the only place a fraction ever exists.

- **Tax is rounded once, on the order's subtotal, never per line.** Rounding each line and summing
  gives a different answer; the one a customer can check against what is on their screen is this one.
- **The order stores all three** plus the `taxRate` they were computed at, so a receipt reprinted
  after a rate change still adds up. Orders written before tax existed read back with `taxSen: 0` —
  filled in on read, never by rewriting the record of what was actually charged.
- **`order.totalSen` is what gets charged.** Stripe receives the tax as its own line item, because a
  Checkout Session's total is the sum of its lines and nothing else — and `PaymentService` refuses
  any webhook whose `amount_total` is not `order.totalSen`, so charging the subtotal would reject
  the customer's own payment. Revenue Monster is handed `order.totalSen` directly.
- Customer-facing surfaces show three lines (Subtotal / Tax (10%) / Total): the cart sheet, the
  checkout page, the receipt, and `renderTotals` for the agent's text. The rate is read from the
  payload, never written into the page.
- **The staff sales report counts what was collected, so its takings include tax.**

Changing the rate, or adding a service charge, is a change to `orderTotals` and nothing else.

## The customer cart is two states, never three

`src/web/`. **Empty cart: nothing on screen.** No bar, no sheet, and no reserved strip at the foot of
the menu. **Something in it: a slim bar** pinned to the bottom — count, running total, "View order".
**Tapped: a bottom sheet** with the lines, quantity steppers, total and Checkout.

Rules worth keeping if you touch this:

- **The sheet only ever opens from a tap.** It does not open on load, and it deliberately does not
  open after adding an item either — that put a wall in front of someone who was about to add a
  second thing. The bar's new count and total are the confirmation.
- **It closes four ways:** the X, the dimmed background, Escape, and a swipe down on the grip. The
  swipe is bound to the grip alone, never the scrolling list, so it cannot fight a scroll.
- **The item options sheet is the same sheet** — same `.sheet-grip`, same `.sheet-head` with its X,
  same four dismissals through one `trackSheetDrag(sheet, grip, dismiss)`. It stays a `<dialog>`
  underneath, because `showModal()` gives Escape, a focus trap and an inert page for free; the
  backdrop click is the one thing `<dialog>` does not do, and it is detected as a click whose target
  is the dialog element itself. Every dismissal goes through `dismissItem()`, so an abandoned ice
  level or quantity is discarded in exactly one place — nothing is ordered unless Add is tapped.
  **Add a third sheet by reusing this chrome, not by inventing a second dismiss mechanism.**
- **"View cart (N items)" in the options sheet** stands that sheet down (`close()`, *not* the
  dismiss path) and opens the cart, then reopens it when the cart closes. A `<dialog>` opened with
  `showModal()` sits in the top layer, above every z-index on the page, so the cart cannot be drawn
  over it — and standing it down costs nothing, because `close()` leaves its DOM as it was: the ice
  level stays checked and the quantity stays put, with no state to save and restore. Navigating away
  clears the stand-down first, so the options sheet cannot reappear over the checkout page. Hidden
  while the cart is empty.
- **Emptying the cart from inside the sheet closes the sheet**, because there is nothing left to
  look at.
- The order and checkout views call `setCartVisible(false)`: those pages are about an order that is
  already placed, and a bar over the pay button is the worst place for one.
- `.cart-foot` sits **outside** the scrolling `.cart-body`, so Checkout is on screen at any order
  length; the sheet's ceiling is `82dvh`, not `vh`, because `vh` counts a mobile browser's
  collapsing address bar as visible screen and pushes the button below the fold.
- `body.has-cart` adds exactly `--cart-bar-h` to the menu's bottom padding. The bar is `position:
  fixed`, so without it the last item of the last section is unreachable underneath.

**`[hidden] { display: none !important }` is load-bearing** (top of `styles.css`). The whole page
uses the `hidden` attribute as its visibility state, and the browser's own `[hidden]` rule is a
plain UA rule that *any* class setting `display` outranks. `.cart-panel { display: flex }` did
exactly that: the panel sat open over the menu on load and the close button looked dead, because
`hidden = true` was being set and quietly overruled. Do not remove that rule, and do not reach for
an `.open` class instead — one visibility mechanism, not two.

## Session & Sales Behavior (applies to every phase, not just one)
- **Cart ownership:** the cart belongs to the customer's own browser session — never stored server-side keyed only by `table_id`. `table_id` is a routing tag for kitchen/staff, never a shared "current order" store.
- **Fresh start per scan:** when a new customer scans the same table's QR, they always get an empty cart. A previous customer's order must never appear on a new session.
- **Clear on payment:** once `confirm_order`/payment succeeds, the cart clears and the customer sees a confirmation screen — never returned to a lingering cart.
- **Daily sales total:** every order that reaches `paid` status feeds a running Daily Sales Total for the current business day, visible on the staff dashboard/POS view. This updates immediately on payment success, independent of whether POS integration (Phase 4) is live or still mocked.

## AI Ordering Agent — "Order & Track" (future phase, spec for reference)
- Functions: `get_menu`, `add_to_cart`, `confirm_order`, `get_order_status`, `register_account`, `submit_review_proof`, `submit_social_proof`, `get_chances`, `play_fishing_game`, `redeem_voucher`
- Embedded as a chat widget in the web menu — handles both conversational questions ("what's gluten-free") and button-driven ordering
- Description: guides the customer through menu → cart → payment → order tracking, then offers bonus chances and the fishing game once the order is confirmed

## Gamification — Fishing Mini-Game (future phase, spec for reference)
- Unlocks only after `confirm_order` succeeds
- **Base chances:** 1 free play per `order_id`
- **Bonus chances** (up to +4, cap 5 total per order), one each for:
  - **Register an account** (phone/email) — call `register_account`, auto-verified, +1 chance
  - **Leave a Google review** — customer submits the review link or a screenshot via `submit_review_proof`, +1 chance once approved
  - **Post a picture** (tag the shop on social) — customer submits the post link or screenshot via `submit_social_proof`, +1 chance once approved. Accepted platforms: Instagram (feed/Story), Facebook (post/Story), TikTok, Xiaohongshu (RED) — tagging the shop handle and/or a set hashtag (e.g. `#ShopNameMY`)
  - **Spend over a set amount** on the order (e.g. RM30+, exact threshold TBD) — auto-verified from `Order.total`, no proof needed, +1 chance
- Review/social submissions need a verification step — simplest version is a staff approval queue (quick yes/no on a screenshot) rather than trying to auto-verify against Google/Instagram APIs
- Call `get_chances(order_id)` so the customer can see how many plays they've unlocked
- Simple interaction per play, 10–20 sec (cast → wait → catch)
- Reward table (tune later): 40% 10%-off next-visit voucher / 30% free drink / 30% free chips
- On a win: unique voucher code + QR, 30-day expiry, single-use
- Staff redemption via `redeem_voucher(code)`

## Data Model
Domain fields are camelCase, and money is always an integer count of sen (1 MYR = 100 sen) — never a
float. See `src/menu/types.ts` and `src/orders/types.ts` for what is actually there.

- `MenuItem`: id, categoryId (staff-editable string), name, description, flavourNotes, priceSen,
  portion, allergens[], mayContain[], dietary[], tags[], optionGroups[], available (bool, default
  true), unavailableReason?, **imageUrl?** (the served `/uploads/menu-items/<file>` path; absent
  when nobody has uploaded a photo)
- `Category`: id (slug), name (as staff typed it), blurb, sortOrder
- `Order`: id, reference, lines[], totals, paymentStatus (pending|paid|failed|expired),
  **kitchenStatus (received|cooking|ready|collected)**, tableNumber?, createdAt, updatedAt
- `Voucher`: code, order_id, type (discount / drink / chips), expiry, redeemed (bool)
- `GamePlay`: order_id, result, voucher_id (nullable)
- `ChanceLedger`: order_id, base_chances (1), bonus_chances[] (type: register/review/social/spend, verified: bool), total_chances, used_chances
- `DailySalesTotal`: date, total_paid_amount, order_count — updated on every order transitioning to `paid`
