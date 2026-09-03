# fish-chips-order

QR scan-to-order system for a fish & chips shop, with an AI ordering agent ("Order & Track").
The agent's behaviour is defined in `.claude/skills/order-track-agent/SKILL.md`.

| Phase | Skill stage | Status |
| --- | --- | --- |
| 1 | 1 — Menu guidance | Done |
| 2 | 2–3 — Cart, checkout, **real payments** | Done |
| 3+ | 4–6 — Bonus chances, fishing game, order status | Not started |

**168 tests, 7 files.** `npm test`.

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
- Options priced live in the dialog before adding
- Cart drawer with quantity controls and a running total
- Checkout with the **payment method picker** — Card (Stripe) or E-wallet/QR (Revenue Monster)
- Order page polling payment status, since payment settles on a webhook

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

POST   /api/payments/webhook/stripe
POST   /api/payments/webhook/revenue_monster
POST   /api/payments/simulate/:orderId       # dev only; refuses configured providers

POST   /api/tools/:name                      # every tool above, for the agent runtime
```

Validation failures return 400 with a machine-readable code (`unknown_option_choice`,
`empty_cart`, `item_unavailable`, …) so the UI can branch on it. A provider failure is 502 — that
one is not the customer's fault.

## Environment

SCREAMING_SNAKE_CASE, no spaces around `=`. See `.env.example`; all provider values are optional.

```
PORT, PUBLIC_BASE_URL
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
REVENUE_MONSTER_API_KEY, REVENUE_MONSTER_CLIENT_ID, REVENUE_MONSTER_CLIENT_SECRET,
REVENUE_MONSTER_WEBHOOK_SECRET, REVENUE_MONSTER_STORE_ID, REVENUE_MONSTER_API_BASE,
REVENUE_MONSTER_PRIVATE_KEY_PATH
```

A value left as the literal `xxx` from `.env.example` counts as unset — a placeholder that made an
adapter think it was live would fail against the provider instead of falling back cleanly.

## Design decisions worth knowing

**Money is integer sen, never floats.** `formatSen` throws on a fractional value rather than
rounding. Stripe and RM both take the smallest currency unit, so sen passes through untouched.

**The server owns pricing.** The browser sends ids; `priceLine` re-derives everything against the
live menu and re-prices again at `confirm_order`, so a menu change mid-session cannot be exploited.
A tampered payload carrying its own `unitPriceSen` is ignored — there is a test for exactly that.

**Allergen exclusion defaults to `strict`.** Excluding gluten also drops plain chips, because they
share a fryer with battered fish. The response includes a `withheld` list with a per-item reason,
so the agent can say "chips are fine ingredient-wise but share our fryer" instead of pretending the
item doesn't exist.

**Confirming an order empties its cart**, so a double submit cannot create a twin order.

**Repositories are interfaces.** Menu, carts and orders are all in-memory behind
`MenuRepository` / `CartRepository` / `OrderRepository`. Swapping in SQLite — or the POS, for menu
and orders — is a constructor change.

**Orders carry no kitchen status.** Received / Cooking / Ready belongs to the POS and to a later
phase; the only lifecycle modelled here is payment. A test asserts the field's absence.

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
- **In-memory storage.** A restart drops carts and orders. The web app handles a dropped cart
  gracefully; a dropped *order* would strand a paid customer, so this needs real persistence before
  any live traffic.

## Not built yet

Stages 4–6 of the skill: bonus chances (`register_account`, `submit_review_proof`,
`submit_social_proof`, `get_chances`), the fishing mini-game (`play_fishing_game`), and kitchen
status tracking (`get_order_status`), plus the POS adapter.

Two things in the skill are still TBD and need a decision before the phases that depend on them:
the spend threshold for the bonus chance (written as "e.g. RM30+"), and the fishing game's win rate
and voucher values.
