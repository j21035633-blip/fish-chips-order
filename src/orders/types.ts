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
  createdAt: string;
  updatedAt: string;
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
  lines: PricedLine[];
  /** Number of physical items, not number of lines. */
  itemCount: number;
  subtotalSen: number;
  subtotal: string;
  /** No tax or service charge modelled yet, so total === subtotal. Kept separate
   *  so adding SST later does not change every caller. */
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
  totalSen: number;
  subtotal: string;
  total: string;
  paymentStatus: PaymentStatus;
  payment?: OrderPayment;
  customerName?: string;
  createdAt: string;
  updatedAt: string;
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
