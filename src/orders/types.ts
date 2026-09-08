import type { Reward } from "../game/rewards.js";
import type { Allergen } from "../menu/types.js";
import type { ProcessedBy } from "../staff/accounts.js";

/**
 * Cart and order types (Phase 2).
 *
 * Deliberately absent: kitchen status (Received / Cooking / Ready). That is a
 * later phase and belongs to the POS, not to us. The only lifecycle an order has
 * here is its *payment* lifecycle.
 */

/**
 * The money's lifecycle.
 *
 * `refunded` is deliberately here and not on `KitchenStatus`: money and food
 * move independently in this system, and what happened to the payment is a fact
 * about the payment. A cancelled-and-refunded order carries both — the food is
 * `cancelled`, the money is `refunded` — which is also what makes the revenue
 * fix a one-word change rather than a new rule in the report.
 *
 * `unpaid_counter` is a customer who chose to settle with staff before leaving:
 * nothing has been charged, no provider was ever asked, and there is no webhook
 * coming. It is distinct from `pending` precisely because `pending` means "a
 * gateway is mid-flight" — the counter needs to tell the two apart to know
 * which orders to go and collect money for.
 *
 * **Only `paid` counts as revenue.** `paidBetween` is the single gate, in both
 * the in-memory repository and the Mongo one, so a status that is not `paid` is
 * out of the day's takings by construction rather than by a filter somebody has
 * to remember to add. That is what keeps an unsettled counter order out of the
 * report until somebody actually takes the money.
 */
export const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "expired",
  "refunded",
  "unpaid_counter",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Which rail the customer chose. `card` is Stripe; `ewallet` is Revenue Monster. */
export const PAYMENT_METHODS = ["card", "ewallet"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_PROVIDERS = ["stripe", "revenue_monster"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * How far along the kitchen is. Separate from `paymentStatus` on purpose: money
 * and food move independently, and the counter needs to see both at once.
 *
 * In order: an order is `received` when it is placed, and staff walk it along
 * the pass to `collected` — handed to the customer, and off the board.
 */
export const PASS_STATUSES = ["received", "cooking", "ready", "collected"] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

/**
 * Every state an order's food can be in.
 *
 * `cancelled` is deliberately **not** part of `PASS_STATUSES`: it is a place an
 * order lands, never a step along the pass. Keeping the two lists apart is what
 * stops "Mark collected" from offering "cancel" as the next tap, and what keeps
 * the ordinary status endpoint from being a way to cancel an order — and skip
 * the refund — by sending one word.
 */
export const KITCHEN_STATUSES = [...PASS_STATUSES, "cancelled"] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];

/**
 * The statuses that still need someone to do something — the columns on the
 * board. `collected` is deliberately not one of them: the food has left the
 * counter, so the ticket leaves the view rather than piling up on it.
 */
export const ACTIVE_KITCHEN_STATUSES = ["received", "cooking", "ready"] as const;
export type ActiveKitchenStatus = (typeof ACTIVE_KITCHEN_STATUSES)[number];

/** The status one step further along the pass, or undefined at the end of it. */
export function nextKitchenStatus(status: KitchenStatus): PassStatus | undefined {
  const index = (PASS_STATUSES as readonly string[]).indexOf(status);
  // A cancelled order is not on the pass, so there is no next step from it.
  return index === -1 ? undefined : PASS_STATUSES[index + 1];
}

/**
 * The kitchen statuses a customer may still call off.
 *
 * `ready` is the cut-off, and the reason is the fryer: once the food is up it
 * has been cooked, plated and is sitting on the pass. Anything past that is a
 * conversation with a staff member, not a button.
 */
export const CANCELLABLE_STATUSES = ["received", "cooking"] as const;

/**
 * How far along staff may still call an order off themselves.
 *
 * Wider than the customer's window on purpose: the food being ready is exactly
 * when a counter cancellation is most likely — the customer never came back for
 * it. `collected` is the end, because by then the food has been handed over and
 * cancelling would be a story about something that already happened.
 */
export const STAFF_CANCELLABLE_STATUSES = ["received", "cooking", "ready"] as const;

export function isCancellable(order: Order): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(order.kitchenStatus);
}

/** Whether this order is waiting on a staff decision. Undefined reads as "no". */
export function cancellationPending(order: Order): boolean {
  return order.cancellationRequested === true;
}

/** A customer's choice within one option group, before pricing. */
export interface OptionSelection {
  groupId: string;
  choiceId: string;
}

/** A line as the customer described it. */
export interface CartLine {
  lineId: string;
  itemId: string;
  quantity: number;
  selections: OptionSelection[];
  note?: string;
  /**
   * Set when the line came from a won reward rather than from a tap.
   *
   * Prices at zero, options included: a free drink is free however it is
   * garnished. Holds the reward id so removing the reward removes the line.
   */
  freeFromReward?: string;
}

/**
 * The one-time things a session can claim a fishing chance for.
 *
 * Kept as a list of claimed keys rather than four booleans so a proof can claim
 * under its own id — a second review screenshot is a different proof, but the
 * *review* slot is still only good once.
 */
export const CHANCE_TRIGGERS = ["spend", "register", "review", "share"] as const;
export type ChanceTrigger = (typeof CHANCE_TRIGGERS)[number];

/** Spend this much on food, before tax, and the session earns a cast. */
export const SPEND_CHANCE_THRESHOLD_SEN = 5000;

export interface Cart {
  id: string;
  lines: CartLine[];
  /**
   * The table whose QR opened this session, when there was one. A routing tag
   * for the kitchen and the counter — never an identity, and never a key
   * anything is stored under: the cart belongs to the browser session, so two
   * customers at one table have two carts.
   */
  tableNumber?: string;
  createdAt: string;
  updatedAt: string;

  /**
   * Fishing chances, held on the cart because the cart *is* the session: it is
   * created by the scan, keyed to the browser, and already the thing every
   * other per-customer fact hangs off. Nothing here is keyed by table, so two
   * people at one table earn and spend their own casts.
   */
  chances: number;
  /** Submitted, waiting on a staff member to look at the screenshot. */
  chancesPending: number;
  chancesUsed: number;
  /** Which one-time triggers this session has already claimed. */
  claimed: ChanceTrigger[];
  /**
   * A phone number or an email, captured in exchange for a chance.
   *
   * Stored as the customer typed it and nothing more — no consent flag, no
   * unsubscribe, no marketing list. It is a contact for *this order*, and
   * anything beyond that would need a consent model this does not have.
   */
  contact?: string;
  /** What has been caught. Frozen at the moment of the catch — see `Reward`. */
  rewards: Reward[];
}

/**
 * What a table label may look like: short, because it is printed on a sticker
 * and read back by staff. "5", "12", "A3", "PATIO-1".
 */
const TABLE_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,7}$/;

/**
 * Normalises a table label from a QR's query string, or throws.
 *
 * Uppercased so "a3" and "A3" are one table rather than two, and so what the
 * kitchen reads matches what is printed on the sticker.
 */
export function parseTableNumber(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!TABLE_NUMBER_PATTERN.test(value)) {
    throw new OrderValidationError(
      `"${String(raw)}" is not a table number.`,
      "invalid_table_number",
      { table: raw },
    );
  }
  return value;
}

/** A selection with its menu names and price resolved. */
export interface PricedOption {
  groupId: string;
  groupName: string;
  choiceId: string;
  choiceName: string;
  priceDeltaSen: number;
}

export interface PricedLine {
  lineId: string;
  itemId: string;
  name: string;
  quantity: number;
  /** Menu price before options. */
  unitBasePriceSen: number;
  options: PricedOption[];
  /** Base + option deltas, for one unit. */
  unitPriceSen: number;
  unitPrice: string;
  lineTotalSen: number;
  lineTotal: string;
  /** Item allergens plus any the chosen options bring. */
  allergens: Allergen[];
  note?: string;
}

export interface PricedCart {
  cartId: string;
  /** Echoed back so the page can show which table it is ordering for. */
  tableNumber?: string;
  lines: PricedLine[];
  /** Number of physical items, not number of lines. */
  itemCount: number;
  subtotalSen: number;
  subtotal: string;
  /** What the fishing rewards take off, before tax. Zero when nothing was won. */
  discountSen: number;
  discount: string;
  /** The rewards behind that discount, so the page can name each one. */
  rewards: Reward[];
  /** Tax on the subtotal *after* the discount, rounded once. See `orderTotals`. */
  taxSen: number;
  tax: string;
  /** The fraction `taxSen` was worked out at, so a stored order still explains
   *  its own arithmetic after the rate changes. */
  taxRate: number;
  /** Subtotal plus tax. This is what gets charged. */
  totalSen: number;
  total: string;
}

export interface OrderPayment {
  method: PaymentMethod;
  provider: PaymentProvider;
  /** The provider's id for the payment (Stripe session id, RM transaction id). */
  providerPaymentId: string;
  /**
   * Stripe only, and only once the money has landed: the PaymentIntent behind
   * the Checkout Session.
   *
   * Refunds are taken against the intent, never the session, so without this a
   * refund has to go and fetch the session first. The webhook carries it, so it
   * is cheaper to keep it than to ask again — but it is optional, and the
   * adapter still knows how to look it up when an older order does not have it.
   */
  providerPaymentIntentId?: string;
  status: PaymentStatus;
  /** Where we sent the customer to pay. */
  checkoutUrl?: string;
  /** QR payload for e-wallet rails that show a code instead of redirecting. */
  qrCodeUrl?: string;
  /** True when no provider credentials were configured and this was simulated. */
  simulated: boolean;
  createdAt: string;
  paidAt?: string;
  failureReason?: string;
}

/**
 * How the money came back, or why it did not.
 *
 * Recorded on the order rather than worked out on demand, because it is a
 * statement about something that happened once: a receipt for the refund, or a
 * note explaining that there was nothing to refund. Staff read it off the
 * ticket and the customer is shown a plain-language version of the same thing.
 */
export const REFUND_OUTCOMES = ["refunded", "pending", "none", "manual", "failed"] as const;
export type RefundOutcome = (typeof REFUND_OUTCOMES)[number];

export interface OrderRefund {
  /**
   * - `refunded` — **confirmed**: the provider says the money has gone back.
   *                 This is the only outcome that takes the order out of the
   *                 day's revenue.
   * - `pending`  — the provider accepted the refund but has not settled it yet.
   *                 The shop still holds the money, so the order still counts:
   *                 dropping it here would under-report takings that are real.
   * - `none`     — there was nothing to refund: unpaid, or paid in cash and
   *                 handed back over the counter.
   * - `manual`   — real money was taken on a rail this cannot refund itself.
   *                 **Somebody has to do it by hand**, and this is the flag
   *                 that says so rather than quietly keeping the money.
   * - `failed`   — the refund was attempted and the provider refused it.
   *
   * The last three all leave the money where it is, which is exactly why they
   * leave `paymentStatus` at `paid`.
   */
  outcome: RefundOutcome;
  /** One sentence, written for a person: shown to staff and to the customer. */
  reason: string;
  amountSen?: number;
  amount?: string;
  provider?: PaymentProvider;
  providerRefundId?: string;
  /** True when no provider credentials were configured and this was simulated. */
  simulated?: boolean;
  at: string;
}

export interface Order {
  id: string;
  /** Short human reference read out at the counter, e.g. "AB-4821". */
  reference: string;
  lines: PricedLine[];
  itemCount: number;
  subtotalSen: number;
  /** Carried from the cart, so the receipt shows what was knocked off and why. */
  discountSen: number;
  discount: string;
  rewards: Reward[];
  taxSen: number;
  totalSen: number;
  /** The rate this order was taxed at, kept with it so a receipt reprinted after
   *  a rate change still adds up. */
  taxRate: number;
  subtotal: string;
  tax: string;
  total: string;
  paymentStatus: PaymentStatus;
  payment?: OrderPayment;
  customerName?: string;
  /** Carried from the cart, so the kitchen knows where the food goes. */
  tableNumber?: string;
  /**
   * The daily takeaway sequence, on staff-rung takeaway orders only.
   *
   * Resets to 1 with each business day, so it is the number called across the
   * counter — "Takeaway #3" — not a global id. `reference` remains the unique
   * one; this is deliberately the friendly, repeating one.
   */
  takeawayNumber?: number;
  /**
   * Paid in cash at the counter.
   *
   * Deliberately *not* a `PaymentMethod`: cash has no provider, no session and
   * no webhook, and adding it to that union would put "Cash" in the customer's
   * payment picker, which is the one place it must never appear. It carries no
   * `payment` record for the same reason — `settledAt` already falls back to
   * `updatedAt`, so the takings still land on the right day.
   */
  paidInCash?: boolean;
  /**
   * Keeps a ticket off the pass until its money lands.
   *
   * Set on staff takeaway orders paid by card, where the customer is standing
   * at the counter with a card in hand: there is no reason to start frying
   * before the terminal says yes. QR orders do not set it — the shop's existing
   * choice is that a table's order goes to the kitchen the moment it is placed,
   * paid or not — so this changes nothing about the customer flow.
   */
  holdForPayment?: boolean;
  /** Kitchen progress. Every order starts `received`; staff move it on. */
  kitchenStatus: KitchenStatus;
  /**
   * Which member of staff took the money for this one.
   *
   * Set on the two flows where a person behind the counter handles a payment:
   * settling a pay-at-counter order, and ringing up a takeaway. The shared
   * password says somebody on shift did it; this says who.
   *
   * The name is a **copy** taken at the time, not a pointer to be resolved
   * later — the account can be renamed or deactivated afterwards and this order
   * still says who was on the till that day. Absent on every order nobody
   * behind the counter touched, which is every ordinary QR order.
   */
  processedBy?: ProcessedBy;

  /**
   * The customer has asked for this order to be called off, and nobody behind
   * the counter has answered yet.
   *
   * A *request*, not a cancellation: the fryer may already be halfway through
   * it, and only a person at the pass can see that. Staff approve or deny, and
   * either way this goes back to false — it is the flag that raises the badge
   * on the boards, so it must not survive the decision that answers it.
   *
   * Optional because orders written before this existed have no such field;
   * everything reads it through `cancellationPending`, which treats a missing
   * value as "no".
   */
  cancellationRequested?: boolean;
  cancellationRequestedAt?: string;
  /**
   * When staff said no. Kept, where the request flag is not, because it is the
   * only thing that tells the customer's page the difference between "never
   * asked" and "asked, and the kitchen was already cooking it".
   */
  cancellationDeniedAt?: string;
  cancelledAt?: string;
  /** What happened to the money when it was cancelled. See `OrderRefund`. */
  refund?: OrderRefund;

  createdAt: string;
  updatedAt: string;
}

/**
 * When an order's money landed.
 *
 * `payment.paidAt` is the truth; `updatedAt` covers an order marked paid without
 * a provider payment attached, which is what a counter-settled order looks like.
 */
export function settledAt(order: Order): string {
  return order.payment?.paidAt ?? order.updatedAt;
}

/** Thrown for anything the customer could fix by choosing differently. */
export class OrderValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OrderValidationError";
  }
}
