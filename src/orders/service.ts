import { randomUUID } from "node:crypto";

import { menuService, type MenuService } from "../menu/service.js";
import { priceCart } from "./pricing.js";
import {
  InMemoryCartRepository,
  InMemoryOrderRepository,
  type CartRepository,
  type OrderRepository,
} from "./repository.js";
import {
  OrderValidationError,
  type Cart,
  type CartLine,
  type OptionSelection,
  type Order,
  type OrderPayment,
  type PricedCart,
} from "./types.js";

export const MAX_CART_LINES = 40;

export interface AddLineInput {
  itemId: string;
  quantity?: number | undefined;
  selections?: OptionSelection[] | undefined;
  note?: string | undefined;
}

/**
 * Stage 2 of the skill: build the cart.
 *
 * Every mutation returns the freshly priced cart, because the skill requires the
 * agent to confirm each add and keep the running total visible — handing the
 * total back on every call is what makes that cheap to do.
 */
export class CartService {
  constructor(
    private readonly carts: CartRepository = new InMemoryCartRepository(),
    private readonly menu: MenuService = menuService,
  ) {}

  create(): Cart {
    const now = new Date().toISOString();
    const cart: Cart = { id: randomUUID(), lines: [], createdAt: now, updatedAt: now };
    this.carts.save(cart);
    return cart;
  }

  get(cartId: string): Cart {
    const cart = this.carts.get(cartId);
    if (!cart) {
      throw new OrderValidationError(`No cart "${cartId}".`, "unknown_cart", { cartId });
    }
    return cart;
  }

  price(cartId: string): PricedCart {
    const cart = this.get(cartId);
    return priceCart(cart.id, cart.lines, this.menu);
  }

  /** Adds a line. Prices it first, so an invalid selection never reaches the cart. */
  addLine(cartId: string, input: AddLineInput): PricedCart {
    const cart = this.get(cartId);
    if (cart.lines.length >= MAX_CART_LINES) {
      throw new OrderValidationError(`A cart holds at most ${MAX_CART_LINES} lines.`, "cart_full", { cartId });
    }

    const line: CartLine = {
      lineId: randomUUID(),
      itemId: input.itemId,
      quantity: input.quantity ?? 1,
      selections: input.selections ?? [],
    };
    if (input.note !== undefined) line.note = input.note;

    const next = [...cart.lines, line];
    const priced = priceCart(cart.id, next, this.menu);

    this.commit(cart, next);
    return priced;
  }

  /** Changes a line's quantity. Quantity 0 removes it, which is what a customer means. */
  updateQuantity(cartId: string, lineId: string, quantity: number): PricedCart {
    const cart = this.get(cartId);
    if (quantity === 0) return this.removeLine(cartId, lineId);

    const existing = cart.lines.find((line) => line.lineId === lineId);
    if (!existing) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    const next = cart.lines.map((line) => (line.lineId === lineId ? { ...line, quantity } : line));
    const priced = priceCart(cart.id, next, this.menu);

    this.commit(cart, next);
    return priced;
  }

  removeLine(cartId: string, lineId: string): PricedCart {
    const cart = this.get(cartId);
    if (!cart.lines.some((line) => line.lineId === lineId)) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    const next = cart.lines.filter((line) => line.lineId !== lineId);
    const priced = priceCart(cart.id, next, this.menu);

    this.commit(cart, next);
    return priced;
  }

  clear(cartId: string): PricedCart {
    const cart = this.get(cartId);
    this.commit(cart, []);
    return priceCart(cart.id, [], this.menu);
  }

  private commit(cart: Cart, lines: CartLine[]): void {
    cart.lines = lines;
    cart.updatedAt = new Date().toISOString();
    this.carts.save(cart);
  }
}

export interface ConfirmOrderInput {
  cartId: string;
  customerName?: string | undefined;
}

export interface MarkPaidResult {
  order: Order;
  /** False when the order was already paid — a redelivered webhook, not a second payment. */
  changed: boolean;
}

/**
 * Stage 3 of the skill: turn a confirmed cart into an order.
 *
 * The order carries a *payment* lifecycle only. Kitchen status
 * (Received / Cooking / Ready) is a later phase and is not modelled here.
 */
export class OrderService {
  constructor(
    private readonly orders: OrderRepository = new InMemoryOrderRepository(),
    private readonly carts: CartService = new CartService(),
    private readonly menu: MenuService = menuService,
  ) {}

  /** Re-prices the cart at confirmation time, so a menu change mid-session cannot be exploited. */
  confirm(input: ConfirmOrderInput): Order {
    const cart = this.carts.get(input.cartId);
    if (cart.lines.length === 0) {
      throw new OrderValidationError("The cart is empty.", "empty_cart", { cartId: input.cartId });
    }

    const priced = priceCart(cart.id, cart.lines, this.menu);
    const now = new Date().toISOString();

    const order: Order = {
      id: randomUUID(),
      reference: this.nextReference(),
      lines: priced.lines,
      itemCount: priced.itemCount,
      subtotalSen: priced.subtotalSen,
      totalSen: priced.totalSen,
      subtotal: priced.subtotal,
      total: priced.total,
      paymentStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (input.customerName !== undefined) order.customerName = input.customerName;

    this.orders.save(order);
    // The cart is spent. Emptying it stops a double-submit from creating a twin order.
    this.carts.clear(cart.id);

    return order;
  }

  get(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new OrderValidationError(`No order "${orderId}".`, "unknown_order", { orderId });
    }
    return order;
  }

  findByReference(reference: string): Order | undefined {
    return this.orders.findByReference(reference);
  }

  findByProviderPaymentId(providerPaymentId: string): Order | undefined {
    return this.orders.findByProviderPaymentId(providerPaymentId);
  }

  /** Records the payment attempt returned by an adapter. */
  attachPayment(orderId: string, payment: OrderPayment): Order {
    const order = this.get(orderId);
    if (order.paymentStatus === "paid") {
      throw new OrderValidationError("That order is already paid.", "already_paid", { orderId });
    }

    order.payment = payment;
    order.paymentStatus = payment.status;
    order.updatedAt = new Date().toISOString();
    this.orders.save(order);
    return order;
  }

  /**
   * Idempotent. Providers retry webhooks, and a redelivery must not look like a
   * second payment — `changed: false` says we had already seen it.
   */
  markPaid(orderId: string, paidAt = new Date().toISOString()): MarkPaidResult {
    const order = this.get(orderId);
    if (order.paymentStatus === "paid") {
      return { order, changed: false };
    }

    order.paymentStatus = "paid";
    order.updatedAt = paidAt;
    if (order.payment) {
      order.payment.status = "paid";
      order.payment.paidAt = paidAt;
    }
    this.orders.save(order);
    return { order, changed: true };
  }

  markFailed(orderId: string, reason: string): MarkPaidResult {
    const order = this.get(orderId);
    // A late failure for an order already paid is noise; never downgrade a paid order.
    if (order.paymentStatus === "paid") {
      return { order, changed: false };
    }

    order.paymentStatus = "failed";
    order.updatedAt = new Date().toISOString();
    if (order.payment) {
      order.payment.status = "failed";
      order.payment.failureReason = reason;
    }
    this.orders.save(order);
    return { order, changed: true };
  }

  /** "AB-4821" — short enough to read out at the counter. */
  private nextReference(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const letters = randomLetters(2);
      const digits = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
      const reference = `${letters}-${digits}`;
      if (!this.orders.findByReference(reference)) return reference;
    }
    // Vanishingly unlikely; fall back to something guaranteed unique over pretty.
    return `ZZ-${Date.now().toString().slice(-6)}`;
  }
}

function randomLetters(count: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, they read as 1 and 0
  let out = "";
  for (let index = 0; index < count; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
