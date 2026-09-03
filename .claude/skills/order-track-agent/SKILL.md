---
name: fish-chips-order
description: QR scan-to-order system for a fish & chips shop, with POS integration and an AI ordering agent ("Order & Track") that includes a fishing mini-game rewards mechanic. Use this skill whenever building, extending, or debugging any part of the fish-chips-order system (backend, customer-facing web order app, POS adapter, or gamification).
---

## Project Overview
QR-scan-to-order system for a fish & chips shop. Customer scans a table QR, orders from a web menu, order goes to the POS/kitchen, and after checkout the customer can play a short fishing mini-game for a chance at a reward voucher (discount, free drink, or free chips) redeemable on their next visit.

## Stack
Same pattern as `cattery-care`:
- **Backend:** Python FastAPI + MongoDB (Beanie ODM)
- **Web:** Next.js 15 + React 19 + Tailwind — mobile-first PWA
- **Auth:** JWT for staff/admin only; customers order without logging in, tracked by table/session
- **Hosting:** Railway
- **Optional later:** React Native/Expo for a staff kitchen-display (KDS) app

## Current Status — BUILD PHASE 1 ONLY

Only build what's listed under Phase 1 below. Do not implement payment, POS integration, order status tracking, or the fishing game yet — those are scoped for later phases and listed here for context only.

### Phase 1 (active)
- Project setup: FastAPI + Beanie/MongoDB backend, Next.js 15 + React 19 + Tailwind frontend — same structure as cattery-care
- QR-linked order page at `/order?table=<table_id>`
- Menu display: categories, items, options (fish type, chips size, sauces), prices
- Cart: add/remove items, adjust quantities, running total
- Mock checkout: "Place Order" button creates an `Order` record, returns an `order_id` — no real payment, no POS call yet
- Confirmation screen showing `order_id` and items ordered

Ask before deciding anything not specified here (exact menu items, styling details, etc.).

### Later phases (do not build yet)
2. Live staff dashboard (kitchen + cashier) — real-time order feed, mark Received/Cooking/Ready, running daily sales total
3. Real payment integration — dual gateway: **Stripe** (cards) + **Revenue Monster** (local e-wallets/DuitNow), behind a `PaymentAdapter` interface, customer picks a method at checkout
4. POS adapter — behind a `POSAdapter` interface so the backend is swappable. **[DECISION NEEDED]** Loyverse, Square, something local, or none yet — start with a mock adapter that logs + prints a ticket
5. Customer-facing order status tracking (Received / Cooking / Ready) via polling or websocket — reuses the same status field the staff dashboard updates
6. Fishing mini-game + voucher generation. **[DECISION NEEDED]** guaranteed reward per order vs. true random chance of nothing
7. Staff voucher redemption screen
8. AI agent conversational layer ("Order & Track") on top of the above

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
- `MenuItem`: name, category, price, options[], available (bool)
- `Order`: order_id, table_id, items[], status, total, created_at
- `Voucher`: code, order_id, type (discount / drink / chips), expiry, redeemed (bool)
- `GamePlay`: order_id, result, voucher_id (nullable)
- `ChanceLedger`: order_id, base_chances (1), bonus_chances[] (type: register/review/social/spend, verified: bool), total_chances, used_chances
- `DailySalesTotal`: date, total_paid_amount, order_count — updated on every order transitioning to `paid`
