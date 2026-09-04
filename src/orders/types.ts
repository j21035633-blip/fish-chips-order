import type { Allergen } from "../menu/types.js";

/**
 * Cart and order types (Phase 2).
 *
 * Deliberately absent: kitchen status (Received / Cooking / Ready). That is a
 * later phase and belongs to the POS, not to us. The only lifecycle an order has
 * here is its *payment* lifecycle.
 */

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "expired"] as const;
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
export const KITCHEN_STATUSES = ["received", "cooking", "ready", "collected"] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];

/**
 * The statuses that still need someone to do something — the columns on the
 * board. `collected` is deliberately not one of them: the food has left the
 * counter, so the ticket leaves the view rather than piling up on it.
 */
export const ACTIVE_KITCHEN_STATUSES = ["received", "cooking", "ready"] as const;
export type ActiveKitchenStatus = (typeof ACTIVE_KITCHEN_STATUSES)[number];

/** The status one step further along the pass, or undefined at the end of it. */
export function nextKitchenStatus(status: KitchenStatus): KitchenStatus | undefined {
  return KITCHEN_STATUSES[KITCHEN_STATUSES.indexOf(status) + 1];
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
}

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
  /** Tax on the subtotal, rounded once for the whole order. See `orderTotals`. */
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

export interface Order {
  id: string;
  /** Short human reference read out at the counter, e.g. "AB-4821". */
  reference: string;
  lines: PricedLine[];
  itemCount: number;
  subtotalSen: number;
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
  /** Kitchen progress. Every order starts `received`; staff move it on. */
  kitchenStatus: KitchenStatus;
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
