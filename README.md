# fish-chips-order

QR scan-to-order system for a fish & chips shop, with an AI ordering agent ("Order & Track").
The agent's behaviour is defined in `.claude/skills/order-track-agent/SKILL.md`.

| Phase | Skill stage | Status |
| --- | --- | --- |
| 1 | 1 — Menu guidance | Done |
| 2 | 2–3 — Cart, checkout, **real payments** | Done |
| 3+ | 4–6 — Bonus chances, fishing game, order status | Not started |

**360 tests, 15 files.** `npm test`.

## Run it

```bash
npm install
cp .env.example .env     # optional — see "Running without keys" below
npm test
npm run typecheck
npm run dev              # http://localhost:3000
```

### Building for deployment

```bash
npm run build            # tsc -p tsconfig.build.json && node scripts/copy-web.mjs
npm start                # node dist/http/server.js
```

Three configs, deliberately separate — the build one is what makes `npm start`'s path correct:

| Config | Used by | Why |
| --- | --- | --- |
| `tsconfig.json` | `typecheck` | Covers `src/` **and** `tests/`. Never emits. |
| `tsconfig.build.json` | `build` | `rootDir: "src"` so output is `dist/http/…`, not `dist/src/http/…`. Excludes tests. |
| `tsconfig.web-tests.json` | `typecheck` | DOM lib for the jsdom page test only; adding `DOM` globally collides with `@types/node`'s fetch types. |

`copy-web.mjs` exists because `tsc` emits JS and nothing else — without it the customer page's
HTML and CSS never reach `dist/`. With it, `dist/` is self-contained and runs from any working
directory, which is what a pruned container deploy needs.

Open `http://localhost:3000` for the customer page. `npm run menu` still drives the menu
tools straight to stdout (`-- --item fish-dory-classic`, `-- --exclude gluten`, `-- --suggest`).

### Running without keys

Every provider credential is optional. With no keys configured, both payment adapters drop into
**simulated mode**: no HTTP call leaves the process, the checkout page is a local stand-in, and
each session is flagged `simulated: true`. The full flow — browse, cart, checkout, pay, order
paid — works end to end on a clean clone.

Simulated settlement is refused the moment a provider has real credentials, so this cannot become
a way to mark a genuine order paid.

### Going live on a provider

```bash
npm run providers    # which adapters are configured, and which variable is missing
```

It prints per-variable status and whether each adapter is `LIVE` or `simulated`, without echoing
any secret. A value still left as `xxx` is reported as a placeholder rather than counted as set.

1. **Stripe** — test keys from the dashboard's API keys page (test mode). `STRIPE_SECRET_KEY` is
   the `sk_test_…` secret key. For `STRIPE_WEBHOOK_SECRET`, the quickest route locally is the
   Stripe CLI: `stripe listen --forward-to localhost:3000/api/payments/webhook/stripe` prints a
   `whsec_…` on startup. A dashboard-registered endpoint has its own signing secret; they are not
   interchangeable, and a mismatch shows up as `signature mismatch`.
2. **Revenue Monster** — sandbox credentials from their merchant portal. Drop the PEM they issue at
   `secrets/revenue-monster-private.pem` and point `REVENUE_MONSTER_PRIVATE_KEY_PATH` at it;
   request signing switches on by itself. `secrets/`, `*.pem` and `.env*` are all gitignored.

Set `PUBLIC_BASE_URL` to a publicly reachable URL before expecting webhooks — providers cannot
reach `localhost`.

## The customer web app

`src/web/` — no framework, no build step, because this page is opened by scanning a QR code at the
table and has to load on a bad connection.

- Menu grouped by section; tap an item for flavour, portion, allergens and options
- Options priced live in the sheet before adding, which dismisses the same four ways the cart does —
  X, dimmed background, Escape, swipe down — discarding the selection unless **Add** is tapped
- Cart in two states: a slim bar with the count and running total while browsing, expanding to a
  bottom sheet with quantity controls when tapped. Empty cart, no bar — nothing floats over the menu
  until there is something to float. The sheet closes on the X, the dimmed background, Escape, or a
  swipe down on its handle.
- Checkout with the **payment method picker** — Card (Stripe) or E-wallet/QR (Revenue Monster)
- Order page polling payment status, since payment settles on a webhook

The options sheet also carries **View cart (N items)** once there is something in the cart. It stands
the sheet down and brings the cart up, then puts it back exactly as it was — a `<dialog>` in the top
layer cannot be drawn over, and `close()` leaves its DOM untouched, so the ice level stays checked
and the quantity stays put with no state to save and restore.

Prices are never computed in the browser. It sends item and choice *ids*; the server re-derives
every price. `tests/web.test.ts` boots this page in jsdom against the real server, so a broken
selector or renamed field fails in CI rather than in front of a customer.

## Payments

### The adapter contract

`PaymentAdapter` (`src/payments/types.ts`) is the whole surface. Nothing outside `src/payments/`
imports Stripe or Revenue Monster, so adding a third rail or dropping one is a registry change —
the same shape the POSAdapter will take.

```ts
interface PaymentAdapter {
  readonly provider: PaymentProvider;
  readonly methods: readonly PaymentMethod[];
  isConfigured(): boolean;
  createPayment(request: CreatePaymentRequest): Promise<PaymentSession>;
  verifyAndParseWebhook(rawBody: string, headers: WebhookHeaders): WebhookVerification;
}
```

| Method | Provider | Rails |
| --- | --- | --- |
| `card` | `StripeAdapter` | Visa, Mastercard, Amex via Stripe Checkout |
| `ewallet` | `RevenueMonsterAdapter` | DuitNow, Touch 'n Go, GrabPay, Boost, ShopeePay |

### How an order gets paid

```
confirm_order          → Order { paymentStatus: "pending" }
start_payment(method)  → adapter.createPayment() → checkoutUrl / QR
customer pays at the provider
provider webhook       → verify signature → check amount → markPaid()
```

**`pending → paid` happens only through a verified webhook.** The redirect the customer follows
back from a provider is not proof of payment — anyone can open that URL — so the order page only
ever reads status, never sets it.

Three things guard the transition:

- **Signature verification** over the raw request bytes. The webhook route is mounted *before*
  `express.json()`, because re-serialising parsed JSON changes key order and whitespace and breaks
  every signature scheme there is. Stripe's timestamp tolerance is enforced, so a captured payload
  cannot be replayed later.
- **Amount matching.** An event whose amount differs from what we charged is refused outright.
- **Idempotency.** Event ids are deduped and `markPaid` is a no-op on an already-paid order, so a
  redelivery reports `changed: false` rather than looking like a second payment. An event with *no
  matching order* is deliberately not marked seen — the order may not have been saved yet, and the
  provider's retry has to be able to land.

A late failure never downgrades a paid order.

### Revenue Monster request signing

RM authenticates each v3 call twice: an OAuth2 bearer token *and* an RSA signature over a canonical
form of the request. That signing is implemented in `src/payments/revenueMonsterSigning.ts` and
switches on the moment `REVENUE_MONSTER_PRIVATE_KEY_PATH` points at a PEM key — no other change.

The canonical plaintext is the fragile part, since both sides must derive byte-identical strings:

```
data=<base64 of compact, deep-key-sorted JSON body>   # omitted when there is no body
&method=<lowercase verb>&nonceStr=<nonce>&requestUrl=<absolute url>
&signType=sha256&timestamp=<unix seconds>
```

signed with RSA-SHA256 and sent as `X-Signature: sha256 <base64>` alongside `X-Nonce-Str` and
`X-Timestamp`. `buildSignaturePlaintext` is exported separately precisely so it can be diffed
against RM's signature debugger if they ever reject a call.

A configured-but-unreadable key throws rather than silently sending an unsigned request.

## Layout

```
src/menu/          menu domain, filtering, suggestions, allergen reporting   (Phase 1)
src/orders/        cart, pricing, orders, payment lifecycle                  (Phase 2)
src/payments/      PaymentAdapter + Stripe + Revenue Monster + signing       (Phase 2)
src/tools/         agent tools, Zod-validated
src/app/           service container
src/http/          routes (app.ts) and listener (server.ts)
src/web/           customer page
src/staff-web/     staff area — five views, a login screen, and the shared nav in assets/
src/cli/           menu stdout harness
```

## Tool surface

Every result carries a `text` field — short, spoken-ready. The agent reads from that rather than
re-formatting the payload, which is what keeps replies short as the skill requires.

| Tool | For |
| --- | --- |
| `get_menu` | The menu, filtered by section, tag, dietary, allergen, price or free text |
| `get_menu_item` | One dish: flavour, portion, allergens, and which options add an allergen |
| `suggest_items` | Signature/popular picks with a reason each, for the undecided customer |
| `create_cart` | Open a cart (one per QR scan) |
| `add_to_cart` | Add an item with options; returns the repriced cart and running total |
| `view_cart` / `update_cart_line` / `remove_from_cart` | Correct the cart |
| `confirm_order` | Turn the cart into an order |
| `get_payment_methods` | What the customer can pay with |
| `start_payment` | Create the payment session; returns the link or QR |
| `get_order` | Read an order and its **payment** status |

## HTTP API

```
GET    /health
GET    /api/menu?category=fish&exclude=gluten,milk&search=cod&maxPriceSen=2000
GET    /api/menu/items/:itemId
GET    /api/menu/suggestions?limit=3

POST   /api/carts
GET    /api/carts/:cartId
POST   /api/carts/:cartId/lines
PATCH  /api/carts/:cartId/lines/:lineId      { quantity }   # 0 removes
DELETE /api/carts/:cartId/lines/:lineId

POST   /api/orders                           { cartId, customerName? }
GET    /api/orders/:orderId
GET    /api/payments/methods
POST   /api/orders/:orderId/payment          { method: "card" | "ewallet" }

POST   /api/staff/login                      { password }   # sets the staff_session cookie
POST   /api/staff/logout                     # clears it
GET    /api/staff/session                    # { authenticated, authRequired }

# Everything below needs that cookie; without it, 401 staff_auth_required.
GET    /api/staff/overview                   # board + today's takings
PATCH  /api/staff/orders/:orderId/status     { status: "received"|"cooking"|"ready"|"collected" }
GET    /api/staff/sales-report?start_date=2026-09-01&end_date=2026-09-07

POST   /api/staff/orders/takeaway            { cartId, payment: "cash" | "card" }
GET    /api/staff/qr-codes?tables=1-12       # table codes as PNG data URIs

GET    /api/staff/menu-items                 # every item, sold-out ones included
POST   /api/staff/menu-items                 # multipart: image? + name, priceSen, category, …
PUT    /api/staff/menu-items/:id             # multipart; patches whatever is sent
PATCH  /api/staff/menu-items/:id/availability  { available }
DELETE /api/staff/menu-items/:id
GET    /uploads/menu-items/:file             # uploaded photos, read-only

POST   /api/payments/webhook/stripe
POST   /api/payments/webhook/revenue_monster
POST   /api/payments/simulate/:orderId       # dev only; refuses configured providers

POST   /api/tools/:name                      # every tool above, for the agent runtime
```

`GET /api/menu` **includes** sold-out items, with `categoryId` and `available` on each, because the
customer page lists them greyed out rather than hiding them — hiding one only moves "do you still do
the cod?" to the counter. The agent's own `get_menu` tool still hides them by default, since it must
never offer something the fryer cannot make.

Prices are an integer count of sen everywhere, including the staff form (`priceSen`). Nothing on the
wire is a float.

Validation failures return 400 with a machine-readable code (`unknown_option_choice`,
`empty_cart`, `item_unavailable`, `missing_field`, `invalid_price`, `unsupported_image_type`, …) so
the UI can branch on it. A provider failure is 502 — that one is not the customer's fault.

## Environment

SCREAMING_SNAKE_CASE, no spaces around `=`. See `.env.example`; all provider values are optional.

```
PORT, PUBLIC_BASE_URL
BUSINESS_TIMEZONE, STAFF_DASHBOARD_PATH, STAFF_PASSWORD, UPLOADS_DIR
MONGODB_URI, MONGODB_DB
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
REVENUE_MONSTER_API_KEY, REVENUE_MONSTER_CLIENT_ID, REVENUE_MONSTER_CLIENT_SECRET,
REVENUE_MONSTER_WEBHOOK_SECRET, REVENUE_MONSTER_STORE_ID, REVENUE_MONSTER_API_BASE,
REVENUE_MONSTER_PRIVATE_KEY_PATH
```

A value left as the literal `xxx` from `.env.example` counts as unset — a placeholder that made an
adapter think it was live would fail against the provider instead of falling back cleanly.

`MONGODB_URI` is the one worth getting right. Without it the app falls back to in-memory storage,
which loses every order on restart; it says so loudly at startup and `GET /health` reports
`"storage": "memory"` so an accidental in-memory deploy is visible from outside.

`UPLOADS_DIR` defaults to `uploads` beside the working directory, which on Railway resolves to
`/app/uploads`. **That path needs a persistent volume mounted on it** — see the menu management
section below.

## Design decisions worth knowing

**Money is integer sen, never floats.** `formatSen` throws on a fractional value rather than
rounding. Stripe and RM both take the smallest currency unit, so sen passes through untouched.

**The server owns pricing.** The browser sends ids; `priceLine` re-derives everything against the
live menu and re-prices again at `confirm_order`, so a menu change mid-session cannot be exploited.
A tampered payload carrying its own `unitPriceSen` is ignored — there is a test for exactly that.

**One function works out every total.** `orderTotals` in `src/orders/pricing.ts`:

```
subtotalSen = Σ line totals (item price + option deltas, × quantity)
taxSen      = Math.round(subtotalSen * 0.10)
totalSen    = subtotalSen + taxSen
```

Everything goes through it — the cart, the confirmed order, and the amount handed to a provider — so
the number shown and the number charged cannot drift apart. Tax is rounded **once on the subtotal**,
never per line: rounding each line and summing gives a different answer, and the one a customer can
check by adding up what is on screen is this one. All three land on the order as their own fields
(`subtotalSen`, `taxSen`, `totalSen`, plus the `taxRate` they were worked out at), so a receipt
reprinted after a rate change still adds up.

Stripe gets the tax as **its own line item**, because a Checkout Session's total is the sum of its
lines and nothing else — and the webhook refuses any `amount_total` that is not `order.totalSen`, so
charging the subtotal would reject the customer's own payment. Orders written before tax existed
read back with `taxSen: 0`, which is what they actually paid.

Note that **the staff sales report counts what was collected**, so its takings now include tax.

**Allergen exclusion defaults to `strict`.** Excluding gluten also drops plain chips, because they
share a fryer with battered fish. The response includes a `withheld` list with a per-item reason,
so the agent can say "chips are fine ingredient-wise but share our fryer" instead of pretending the
item doesn't exist.

**Confirming an order empties its cart**, so a double submit cannot create a twin order.

**Repositories are interfaces.** Carts and orders sit behind `CartRepository` / `OrderRepository`,
implemented once against MongoDB (`src/storage/mongo.ts`) and once in memory for tests and for a
local run with no `MONGODB_URI`. Swapping either — or the POS, for menu and orders — is a
constructor change. The menu stays in-process; it is static data.

**Documents are keyed by the domain id**, so `_id` *is* `order.id` and every write is an idempotent
upsert: a retried save cannot produce a second row. `reference` is uniquely indexed because the
short code is read out at the counter and two customers must never share one. Carts carry a TTL so
abandoned ones are reaped; orders never expire. `MongoStorage.db` is public so the game and voucher
collections a later phase adds share the same connection.

**A table is a routing tag, not a session.** `/order?table=5` always opens a *new*
cart — a previous customer's order must never appear when the next one scans the same sticker — and
then rewrites the URL to `/` so a refresh resumes that customer's own cart instead of starting a
third. The table rides on the cart and is copied onto the order at confirmation; `confirm_order`
takes no table of its own, so nobody can check out as a table they never scanned. `/order` with no
`table` is the counter/takeaway entry point and keeps whatever cart is already there.

**Payment and kitchen progress are separate fields.** `paymentStatus` moves only on a provider
webhook; `kitchenStatus` (Received / Cooking / Ready) moves only from the staff board. Money and
food travel independently, and the board shows both so the counter can decide whether to cook an
order that has not paid yet. There is still no generic `status`.

**The daily total is keyed on when the money landed**, not when the order was placed: an order taken
at 23:55 and paid at 00:05 is tomorrow's takings. Business days are calendar days in
`BUSINESS_TIMEZONE`, compared as `YYYY-MM-DD` strings, with the UTC bounds found by search rather
than by assuming an offset — the offset for a zone is itself a function of the date.

## Known gaps

- **Neither adapter has touched a live sandbox.** Both are written against published API shapes and
  are thoroughly unit-tested, but no Stripe or RM test credentials were available, so the request
  shapes are unverified against the real services. The signing *mechanics* are verified
  cryptographically against a generated keypair; RM's exact canonicalisation is not.
- **RM webhook verification assumes HMAC-SHA256** over the raw body against
  `REVENUE_MONSTER_WEBHOOK_SECRET` in `x-signature`. If the account is configured for RSA callback
  signatures instead, only `verifyAndParseWebhook` changes.
- **Combos are flat items** — they don't reference their components, so Popcorn Prawns being sold
  out doesn't mark the Trawler Platter unavailable. Worth fixing when the POS feed lands.
- **No migration for orders placed before persistence landed.** Anything created while the app was
  running in memory is gone; there was nowhere to read it from.

## Staff area

Five views under `STAFF_DASHBOARD_PATH` (default `/staff`), behind one shared password, sharing one
nav and one stylesheet:

| Path | View |
| --- | --- |
| `/` | **Dashboard** — today's orders in Received / Cooking / Ready columns, running Today's Sales Total |
| `/kitchen` | **Kitchen & Counter** — live orders as cards, one action each, over an always-visible quick-add panel |
| `/sales` | **Sales Report** — date range, summary cards, sales-by-day chart, daily breakdown table |
| `/menu` | **Menu** — add, edit, delete items; photo upload; one-tap availability toggle |
| `/qr` | **Table QR Codes** — generate, print and download the scan-to-order codes |
| `/login` | **Sign in** — the one page outside the gate; no nav, one password field |

Each view is its own document rather than a client-side router, so a tablet on the pass reloads into
the view it was showing. The nav lives once in `src/staff-web/assets/nav.js`; the mount path is
substituted into each page at serve time, because relative asset URLs would resolve differently on
`/staff` and `/staff/kitchen`.

**Kitchen status** runs Received → Cooking → Ready → **Collected**. Collected is a real status but
not a column: the food has been handed over, so the ticket drops off both boards while staying in
the day's trade for the sales report. Any status is accepted rather than forward-only — a mis-tap on
a busy pass has to be undoable — and the change is idempotent, so a double-tap is not an error.

**Sales report** buckets paid orders by the day their money landed, in the shop's own timezone, one
query for the whole window. Quiet days come back as zeroes rather than gaps: a week missing its
quiet Monday reads as a six-day week. Range is capped at 366 days.

**Menu management** edits the live menu. The menu is one document in Mongo, held in memory and
written through on every edit, so pricing and the customer page see a change immediately and reads
stay synchronous. Categories are staff-editable free text, slugged to an id (`Sides & Dips` →
`sides-dips`) and reused rather than duplicated; a section empties out and disappears, except the
four the shop opened with. The availability toggle is deliberately its own endpoint that can touch
nothing else — it fires on a single tap during service, so it must not be able to carry a stale
price with it. With no database configured the seed menu still serves; edits just do not survive a
restart.

### Uploaded photos need a Railway volume — manual step

Photos are written to `UPLOADS_DIR/menu-items/` and served read-only at `/uploads/...`; the item
stores the served path, not the disk path. A container filesystem is wiped on every redeploy, so
**attach a persistent volume mounted at `/app/uploads`** to the service in the Railway dashboard
(Service → Settings → Volumes), the same pattern as the volume behind the MongoDB service.

Nothing in the code does this, and nothing checks for it: a missing volume looks exactly like a
working directory until the next deploy, when every stored image URL starts 404ing while the menu
still lists the items. Uploads are capped at 5 MB and JPEG/PNG/WebP/GIF/AVIF only — SVG is refused
because it can carry script and these files are served from the same origin as the app.

Updates by short polling every 2s rather than a websocket: one shop, one process, and a dropped
socket on a kitchen tablet that silently stops updating is worse than a request every two seconds.
The header shows `not updating` if the feed stalls, so a frozen board is visible rather than quietly
wrong.

### One shared password, on the pages and the API

Everyone behind the counter signs in with the same password, set in `STAFF_PASSWORD`. Not per-user
accounts: one shop, one tablet on the pass, and individual logins would be ceremony that ends with
the password written on the wall anyway. The gate covers the four pages *and* every `/api/staff/`
route — including the ones that write the menu and accept uploads, which is the part path obscurity
never protected.

**`STAFF_PASSWORD` must be set in the Railway dashboard before any of this protects anything.**
Unset, the gate is off and the staff area is as open as it was before — deliberate, so local
development and the tests run without a secret, but it means a deploy that forgot the variable is
unprotected. It says so out loud: the server warns at startup and `GET /health` reports
`"staffAuth": "disabled"` until it is set.

A browser without a valid session is redirected to `{STAFF_DASHBOARD_PATH}/login?next=…` before the
page is rendered — server-side, because a guard in the page's own script can only hide a document
that has already been sent. An API call that 401s sends the page to the same screen, which is how a
session expiring mid-service is handled. **Log out** sits in the header on every view.

The session is a payload and an HMAC over it, in a `httpOnly` `SameSite=Lax` cookie, valid **12
hours** — longer than the longest shift, short enough that a tablet left on overnight signs in again
in the morning. No JWT library: this is a cookie the server issues to itself, not a token for anyone
else to read. The signing key is **derived from the password**, which has two consequences worth
wanting — nothing else to configure, and changing `STAFF_PASSWORD` invalidates every session issued
under the old one, which is how you revoke access on the day someone leaves. A restart does not sign
the kitchen out. Failed logins are throttled at 8 per 10 minutes per address; that is a speed bump
against online guessing, not a defence against a password that has leaked.

Two things still hold, and neither was ever a substitute for the above:

- The pages live in `src/staff-web/`, outside the customer web root, so `express.static` cannot
  serve them under their own filenames and `STAFF_DASHBOARD_PATH` genuinely controls where they are.
  Still worth setting to something unguessable — it keeps the sign-in screen off a passing
  customer's radar.
- Every staff page is served with `X-Robots-Tag: noindex, nofollow` and a matching meta tag.

What it is not: there is no audit trail. Every action is "a staff member", which is why kitchen
status stays freely reversible. The customer API is untouched and stays open, which is the point.

## Table QR codes

Two ways to the same codes, both from `src/qr/tables.ts`.

**In the staff area**, at `/qr`: type the tables (`1-12`, or `1-8,PATIO-1`), press **Generate
codes**, and the codes appear — with **Print sheet**, which prints the cards and nothing else, and a
**Download PNG** on each. Nothing is stored: a code is a pure function of the public URL and the
table number, so there is nothing to keep and nothing to go stale the day `PUBLIC_BASE_URL` changes.
This is a page now because there is a staff password now — an open route that mints table codes
hands anyone a link that opens an order against someone else's table.

**On the command line**, for a bulk run that lands as files:

```
npm run qr -- --tables 1-12
npm run qr -- --tables 1-8,PATIO-1 --base-url https://order.example.com --out qr
```

Writes a scannable PNG per table plus an `index.html` print sheet — writing forty PNGs into a folder
is a job for a script, not for a browser.

Codes use error-correction level `Q`, which tolerates a smudged sticker, and each points at
`/order?table=N`, which always starts a fresh session. A test decodes both the files and the page's
data URIs with a real QR reader and compares them against the URL they should carry — the risk here
is a code that renders and does not scan.

## Not built yet

Stages 4–6 of the skill: bonus chances (`register_account`, `submit_review_proof`,
`submit_social_proof`, `get_chances`), the fishing mini-game (`play_fishing_game`), and the
customer-facing side of status tracking (`get_order_status` — staff can set the status, but the
customer's order page does not show it yet), plus the POS adapter and staff auth.

Two things in the skill are still TBD and need a decision before the phases that depend on them:
the spend threshold for the bonus chance (written as "e.g. RM30+"), and the fishing game's win rate
and voucher values.

## Takeaway orders at the counter

**Quick add (take away)** sits permanently below the live orders on the Kitchen & Counter page. One
tile per menu category, expanding in place to that section's items; the running order stays beside
it. An item with options opens the customer's own options sheet (ice level, quantity) from
`src/web/menu-browse.js`, the module the customer app imports too; an item with none goes straight
in. **Create order** then asks cash or card.

Category tiles wear a photo, never an icon: categories carry no image of their own, so a section
shows the first photo among its items — upload one on the Menu page to give a section a picture.

The order is built on the customer's own cart endpoints, so pricing, options and tax are one code
path; only the last step is a staff route.

Each one gets **"Takeaway #N"**, counted from the day's own orders so it resets to 1 with every
business day. That label is what gets called across the counter; `reference` is still the unique id.

Then cash or card, and the difference is the point:

- **Cash** — paid the moment it is rung up, straight onto the pass. No provider, no session, no
  webhook. Cash is deliberately *not* a `PaymentMethod`: that union drives the customer's payment
  picker, and "Cash" must never appear there.
- **Card** — the same Stripe flow a QR customer takes, settling on the same webhook. The ticket is
  **held off the pass until the payment confirms**, because the customer is standing at the counter
  and there is no reason to start frying before the terminal says yes.

That last point differs from a QR order, which reaches the kitchen the moment it is placed, paid or
not. That was the existing choice for table orders and is deliberately unchanged.

Both boards badge anything not going to a table, and the sales report splits its takings into
dine-in and takeaway.
