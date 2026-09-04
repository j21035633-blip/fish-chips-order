import { randomUUID } from "node:crypto";

import { config } from "../config/env.js";
import { menuService, type MenuService } from "../menu/service.js";
import { formatSen } from "../menu/money.js";
import { businessDay, businessDayRange, businessDaysBetween, isBusinessDay } from "./businessDay.js";
import { priceCart } from "./pricing.js";
import {
  InMemoryCartRepository,
  InMemoryOrderRepository,
  type CartRepository,
  type OrderRepository,
} from "./repository.js";
import {
  KITCHEN_STATUSES,
  OrderValidationError,
  parseTableNumber,
  settledAt,
  type Cart,
  type CartLine,
  type OptionSelection,
  type KitchenStatus,
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

  async create(tableNumber?: string): Promise<Cart> {
    const now = new Date().toISOString();
    const cart: Cart = { id: randomUUID(), lines: [], createdAt: now, updatedAt: now };
    if (tableNumber !== undefined) cart.tableNumber = parseTableNumber(tableNumber);
    await this.carts.save(cart);
    return cart;
  }

  async get(cartId: string): Promise<Cart> {
    const cart = await this.carts.get(cartId);
    if (!cart) {
      throw new OrderValidationError(`No cart "${cartId}".`, "unknown_cart", { cartId });
    }
    return cart;
  }

  async price(cartId: string): Promise<PricedCart> {
    const cart = await this.get(cartId);
    return priceCart(cart.id, cart.lines, this.menu, cart.tableNumber);
  }

  /** Adds a line. Prices it first, so an invalid selection never reaches the cart. */
  async addLine(cartId: string, input: AddLineInput): Promise<PricedCart> {
    const cart = await this.get(cartId);
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
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber);

    await this.commit(cart, next);
    return priced;
  }

  /** Changes a line's quantity. Quantity 0 removes it, which is what a customer means. */
  async updateQuantity(cartId: string, lineId: string, quantity: number): Promise<PricedCart> {
    const cart = await this.get(cartId);
    if (quantity === 0) return this.removeLine(cartId, lineId);

    const existing = cart.lines.find((line) => line.lineId === lineId);
    if (!existing) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    const next = cart.lines.map((line) => (line.lineId === lineId ? { ...line, quantity } : line));
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber);

    await this.commit(cart, next);
    return priced;
  }

  async removeLine(cartId: string, lineId: string): Promise<PricedCart> {
    const cart = await this.get(cartId);
    if (!cart.lines.some((line) => line.lineId === lineId)) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    const next = cart.lines.filter((line) => line.lineId !== lineId);
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber);

    await this.commit(cart, next);
    return priced;
  }

  async clear(cartId: string): Promise<PricedCart> {
    const cart = await this.get(cartId);
    await this.commit(cart, []);
    return priceCart(cart.id, [], this.menu, cart.tableNumber);
  }

  private async commit(cart: Cart, lines: CartLine[]): Promise<void> {
    cart.lines = lines;
    cart.updatedAt = new Date().toISOString();
    await this.carts.save(cart);
  }
}

export interface ConfirmOrderInput {
  cartId: string;
  customerName?: string | undefined;
}

export interface DailySales {
  /** `YYYY-MM-DD` in the shop's own timezone. */
  day: string;
  timeZone: string;
  count: number;
  totalSen: number;
  total: string;
}

/** One row of the sales report — a single business day's takings. */
export interface SalesReportDay {
  /** `YYYY-MM-DD` in the shop's own timezone. */
  day: string;
  count: number;
  totalSen: number;
  total: string;
}

/**
 * Takings over a range of days, with the per-day breakdown a chart needs.
 *
 * `days` covers every day in the range, quiet ones included as zeroes — a chart
 * with gaps in its x-axis lies about the shape of a week.
 */
export interface SalesReport {
  startDate: string;
  endDate: string;
  timeZone: string;
  /** Totals across the whole range, for the summary cards. */
  count: number;
  totalSen: number;
  total: string;
  days: SalesReportDay[];
}

export interface SalesReportInput {
  /** `YYYY-MM-DD`. Defaults to today in `timeZone`. */
  startDate?: string | undefined;
  /** `YYYY-MM-DD`. Defaults to `startDate`, so one date means one day. */
  endDate?: string | undefined;
  timeZone?: string | undefined;
}

/**
 * A year and a day. Long enough for "last 12 months", short enough that a typo
 * in a URL cannot ask the database to scan everything the shop has ever sold.
 */
export const MAX_SALES_REPORT_DAYS = 366;

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
  async confirm(input: ConfirmOrderInput): Promise<Order> {
    const cart = await this.carts.get(input.cartId);
    if (cart.lines.length === 0) {
      throw new OrderValidationError("The cart is empty.", "empty_cart", { cartId: input.cartId });
    }

    const priced = priceCart(cart.id, cart.lines, this.menu, cart.tableNumber);
    const now = new Date().toISOString();

    const order: Order = {
      id: randomUUID(),
      reference: await this.nextReference(),
      lines: priced.lines,
      itemCount: priced.itemCount,
      subtotalSen: priced.subtotalSen,
      totalSen: priced.totalSen,
      subtotal: priced.subtotal,
      total: priced.total,
      paymentStatus: "pending",
      // The kitchen has the ticket the moment the order exists; whether to cook
      // it before it is paid is the counter's call, not this service's.
      kitchenStatus: "received",
      createdAt: now,
      updatedAt: now,
    };
    if (input.customerName !== undefined) order.customerName = input.customerName;
    // The table rides along from the cart; there is no second place to set it,
    // so a customer cannot check out "as" a table they never scanned.
    if (cart.tableNumber !== undefined) order.tableNumber = cart.tableNumber;

    await this.orders.save(order);
    // The cart is spent. Emptying it stops a double-submit from creating a twin order.
    await this.carts.clear(cart.id);

    return order;
  }

  async get(orderId: string): Promise<Order> {
    const order = await this.orders.get(orderId);
    if (!order) {
      throw new OrderValidationError(`No order "${orderId}".`, "unknown_order", { orderId });
    }
    return order;
  }

  async findByReference(reference: string): Promise<Order | undefined> {
    return this.orders.findByReference(reference);
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<Order | undefined> {
    return this.orders.findByProviderPaymentId(providerPaymentId);
  }

  /** Records the payment attempt returned by an adapter. */
  async attachPayment(orderId: string, payment: OrderPayment): Promise<Order> {
    const order = await this.get(orderId);
    if (order.paymentStatus === "paid") {
      throw new OrderValidationError("That order is already paid.", "already_paid", { orderId });
    }

    order.payment = payment;
    order.paymentStatus = payment.status;
    order.updatedAt = new Date().toISOString();
    await this.orders.save(order);
    return order;
  }

  /**
   * Idempotent. Providers retry webhooks, and a redelivery must not look like a
   * second payment — `changed: false` says we had already seen it.
   */
  async markPaid(orderId: string, paidAt = new Date().toISOString()): Promise<MarkPaidResult> {
    const order = await this.get(orderId);
    if (order.paymentStatus === "paid") {
      return { order, changed: false };
    }

    order.paymentStatus = "paid";
    order.updatedAt = paidAt;
    if (order.payment) {
      order.payment.status = "paid";
      order.payment.paidAt = paidAt;
    }
    await this.orders.save(order);
    return { order, changed: true };
  }

  async markFailed(orderId: string, reason: string): Promise<MarkPaidResult> {
    const order = await this.get(orderId);
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
    await this.orders.save(order);
    return { order, changed: true };
  }

  /**
   * Moves an order along the pass: Received → Cooking → Ready → Collected.
   *
   * Any of the four is accepted rather than forward-only: a mis-tap on a busy
   * pass needs to be undoable — including un-collecting an order handed to the
   * wrong table — and there is no auth to make an audit trail of anyway.
   * Idempotent, so a double-tap is not an error.
   */
  async setKitchenStatus(orderId: string, status: KitchenStatus): Promise<MarkPaidResult> {
    if (!(KITCHEN_STATUSES as readonly string[]).includes(status)) {
      throw new OrderValidationError(`"${status}" is not a kitchen status.`, "invalid_kitchen_status", {
        orderId,
        status,
      });
    }

    const order = await this.get(orderId);
    if (order.kitchenStatus === status) return { order, changed: false };

    order.kitchenStatus = status;
    order.updatedAt = new Date().toISOString();
    await this.orders.save(order);
    return { order, changed: true };
  }

  /** Today's orders, newest first — what the staff board shows. */
  async feed(timeZone: string = config.businessTimeZone): Promise<Order[]> {
    const { start } = businessDayRange(businessDay(new Date(), timeZone), timeZone);
    return this.orders.createdSince(start);
  }

  /**
   * Takings for the current business day.
   *
   * Counts an order once its payment settled, which is the only status the
   * webhook can move it to — so this cannot drift from what was actually paid.
   */
  async dailySales(timeZone: string = config.businessTimeZone): Promise<DailySales> {
    const day = businessDay(new Date(), timeZone);
    // One day is just the narrowest report there is; sharing the implementation
    // is what keeps the header total and the sales page from ever disagreeing.
    const report = await this.salesReport({ startDate: day, endDate: day, timeZone });
    const today = report.days[0]!;

    return { day, timeZone, count: today.count, totalSen: today.totalSen, total: today.total };
  }

  /**
   * Takings per business day across a range, for the sales report.
   *
   * One query for the whole window rather than one per day: paid orders are
   * bucketed here by the day their money landed, using the same rule as
   * `dailySales`. Days with no takings are still returned, as zeroes.
   */
  async salesReport(input: SalesReportInput = {}): Promise<SalesReport> {
    const timeZone = input.timeZone ?? config.businessTimeZone;
    const today = businessDay(new Date(), timeZone);
    // A single date means a single day, whichever end of the range it was given as.
    const startDate = input.startDate ?? input.endDate ?? today;
    const endDate = input.endDate ?? startDate;

    for (const [name, value] of [["start_date", startDate], ["end_date", endDate]] as const) {
      if (!isBusinessDay(value)) {
        throw new OrderValidationError(`"${value}" is not a date (YYYY-MM-DD).`, "invalid_date", {
          field: name,
          value,
        });
      }
    }
    if (endDate < startDate) {
      throw new OrderValidationError("The range ends before it starts.", "invalid_date_range", {
        startDate,
        endDate,
      });
    }

    const days = businessDaysBetween(startDate, endDate);
    if (days.length > MAX_SALES_REPORT_DAYS) {
      throw new OrderValidationError(
        `A report covers at most ${MAX_SALES_REPORT_DAYS} days; that range is ${days.length}.`,
        "range_too_long",
        { startDate, endDate, days: days.length, maxDays: MAX_SALES_REPORT_DAYS },
      );
    }

    const { start } = businessDayRange(startDate, timeZone);
    const { end } = businessDayRange(endDate, timeZone);
    const paid = await this.orders.paidBetween(start, end);

    const takings = new Map(days.map((day) => [day, { count: 0, totalSen: 0 }]));
    for (const order of paid) {
      // The query bounds the range, so every settled order lands in a bucket —
      // but a clock skewed past the last boundary should be dropped, not thrown.
      const bucket = takings.get(businessDay(settledAt(order), timeZone));
      if (!bucket) continue;
      bucket.count += 1;
      bucket.totalSen += order.totalSen;
    }

    const breakdown: SalesReportDay[] = days.map((day) => {
      const { count, totalSen } = takings.get(day)!;
      return { day, count, totalSen, total: formatSen(totalSen) };
    });
    const totalSen = breakdown.reduce((sum, day) => sum + day.totalSen, 0);

    return {
      startDate,
      endDate,
      timeZone,
      count: breakdown.reduce((sum, day) => sum + day.count, 0),
      totalSen,
      total: formatSen(totalSen),
      days: breakdown,
    };
  }

  /** "AB-4821" — short enough to read out at the counter. */
  private async nextReference(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const letters = randomLetters(2);
      const digits = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
      const reference = `${letters}-${digits}`;
      if (!(await this.orders.findByReference(reference))) return reference;
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
