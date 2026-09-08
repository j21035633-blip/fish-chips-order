import { randomUUID } from "node:crypto";

import { config } from "../config/env.js";
import { menuService, type MenuService } from "../menu/service.js";
import { formatSen } from "../menu/money.js";
import { businessDay, businessDayRange, businessDaysBetween, isBusinessDay } from "./businessDay.js";
import { rollTier, toReward, type Reward } from "../game/rewards.js";
import type { ProcessedBy } from "../staff/accounts.js";
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
  SPEND_CHANCE_THRESHOLD_SEN,
  type Cart,
  type ChanceTrigger,
  type CartLine,
  type OptionSelection,
  type KitchenStatus,
  type Order,
  type OrderPayment,
  type PricedCart,
  isCancellable,
  cancellationPending,
  type OrderRefund,
  STAFF_CANCELLABLE_STATUSES,
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
    const cart: Cart = {
      id: randomUUID(),
      lines: [],
      createdAt: now,
      updatedAt: now,
      chances: 0,
      chancesPending: 0,
      chancesUsed: 0,
      claimed: [],
      rewards: [],
    };
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
    return priceCart(cart.id, cart.lines, this.menu, cart.tableNumber, cart.rewards);
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
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber, cart.rewards);

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
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber, cart.rewards);

    await this.commit(cart, next);
    return priced;
  }

  /**
   * Changes what a line *is* — its choices, and optionally its quantity — where
   * it already sits.
   *
   * Separate from `updateQuantity` because they answer different questions: the
   * stepper says "two of these" and this says "actually, no ice". Rebuilt with
   * `map`, so the line keeps its id and its **position** among the others; the
   * client used to do this by adding a new line and deleting the old one, which
   * worked and quietly sent the edited item to the bottom of the order.
   *
   * A line won from the fishing game is refused. It prices at zero because it
   * was a prize, and re-choosing its options would have to re-price it — at
   * which point the customer either loses the reward or gets to keep choosing
   * new free drinks. The page already hides Edit on those; this is the same
   * rule where it cannot be skipped by calling the API directly.
   */
  async editLine(
    cartId: string,
    lineId: string,
    changes: { quantity?: number | undefined; selections?: OptionSelection[] | undefined },
  ): Promise<PricedCart> {
    const cart = await this.get(cartId);
    const existing = cart.lines.find((line) => line.lineId === lineId);
    if (!existing) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    if (existing.freeFromReward !== undefined && changes.selections !== undefined) {
      throw new OrderValidationError(
        "That drink was won from the fishing game and cannot be changed.",
        "reward_line_not_editable",
        { cartId, lineId },
      );
    }

    const next = cart.lines.map((line) =>
      line.lineId === lineId
        ? {
            ...line,
            ...(changes.quantity === undefined ? {} : { quantity: changes.quantity }),
            ...(changes.selections === undefined ? {} : { selections: changes.selections }),
          }
        : line,
    );

    // Priced before it is committed, so an option id that does not exist is
    // refused here rather than saved and discovered at checkout.
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber, cart.rewards);

    await this.commit(cart, next);
    return priced;
  }

  async removeLine(cartId: string, lineId: string): Promise<PricedCart> {
    const cart = await this.get(cartId);
    if (!cart.lines.some((line) => line.lineId === lineId)) {
      throw new OrderValidationError(`No line "${lineId}" in this cart.`, "unknown_line", { cartId, lineId });
    }

    const next = cart.lines.filter((line) => line.lineId !== lineId);
    const priced = priceCart(cart.id, next, this.menu, cart.tableNumber, cart.rewards);

    await this.commit(cart, next);
    return priced;
  }

  async clear(cartId: string): Promise<PricedCart> {
    const cart = await this.get(cartId);
    await this.commit(cart, []);
    return priceCart(cart.id, [], this.menu, cart.tableNumber, cart.rewards);
  }

  private async commit(cart: Cart, lines: CartLine[]): Promise<void> {
    cart.lines = lines;
    cart.updatedAt = new Date().toISOString();
    // Checked on every mutation rather than only on add: a customer who crosses
    // the threshold by bumping a quantity has crossed it just the same.
    awardSpendChance(cart, priceCart(cart.id, lines, this.menu, cart.tableNumber, cart.rewards).subtotalSen);
    await this.carts.save(cart);
  }

  // ------------------------------------------------------------- the chances

  /**
   * Hands over a contact in exchange for a cast.
   *
   * Once per session — a second call returns the same ledger untouched rather
   * than erroring, because the customer did nothing wrong and the answer to
   * "did I get my chance?" is yes either way.
   */
  async registerContact(cartId: string, contact: string): Promise<Cart> {
    const cart = await this.get(cartId);
    const trimmed = contact.trim();

    if (trimmed.length === 0) {
      throw new OrderValidationError("Enter a phone number or an email.", "invalid_contact", { cartId });
    }

    cart.contact = trimmed;
    claim(cart, "register");
    await this.save(cart);
    return cart;
  }

  /** A proof has been submitted: one chance moves into the pending column. */
  async holdChanceForProof(cartId: string, trigger: ChanceTrigger): Promise<Cart> {
    const cart = await this.get(cartId);

    if (cart.claimed.includes(trigger)) {
      throw new OrderValidationError(
        `This order has already claimed its ${trigger} chance.`,
        "chance_already_claimed",
        { cartId, trigger },
      );
    }

    // Claimed at submission, not at approval: the slot is spent either way, so a
    // rejected screenshot cannot be resubmitted until the staff member says no.
    cart.claimed.push(trigger);
    cart.chancesPending += 1;
    await this.save(cart);
    return cart;
  }

  /** Staff said yes: pending becomes available on *this* session and no other. */
  async approveChance(cartId: string): Promise<Cart> {
    const cart = await this.get(cartId);
    if (cart.chancesPending <= 0) return cart;

    cart.chancesPending -= 1;
    cart.chances += 1;
    await this.save(cart);
    return cart;
  }

  /**
   * Staff said no. The pending chance goes away and none is granted — and the
   * trigger is released, so a better screenshot can be sent.
   */
  async rejectChance(cartId: string, trigger: ChanceTrigger): Promise<Cart> {
    const cart = await this.get(cartId);
    if (cart.chancesPending > 0) cart.chancesPending -= 1;
    cart.claimed = cart.claimed.filter((claimed) => claimed !== trigger);
    await this.save(cart);
    return cart;
  }

  /**
   * One cast.
   *
   * The server rolls, the server applies, and the client is told what happened
   * so it can animate it. Nothing the browser sends influences the outcome, and
   * the reward is on the cart before this returns — so the total the customer
   * sees next, and the amount Stripe is later asked for, already include it.
   */
  /**
   * One cast.
   *
   * `performance` is how well the client says the player reeled, 0–100. It
   * tilts the weighted roll and does nothing else — it cannot name a tier and
   * cannot reach the money. See `rollTier`. A play that reports nothing rolls
   * the base table, which is what every play did before the reel had a score.
   */
  async play(
    cartId: string,
    random: () => number = Math.random,
    performance = 0,
  ): Promise<{ cart: PricedCart; reward: Reward }> {
    const cart = await this.get(cartId);

    if (cart.chances <= 0) {
      throw new OrderValidationError(
        "No chances left. Earn one by spending RM50, leaving a review, sharing, or leaving a contact.",
        "no_chances",
        { cartId, chances: cart.chances, chancesPending: cart.chancesPending },
      );
    }

    const reward = toReward(rollTier(random, performance), randomUUID(), new Date().toISOString());
    cart.chances -= 1;
    cart.chancesUsed += 1;
    cart.rewards.push(reward);

    // A free item is a real line, so it prints on the kitchen ticket and the
    // customer can see what they won sitting in their order.
    if (reward.kind === "free_item" && reward.itemId && this.menu.getItem(reward.itemId)?.available) {
      cart.lines = [
        ...cart.lines,
        {
          lineId: randomUUID(),
          itemId: reward.itemId,
          quantity: 1,
          selections: [],
          freeFromReward: reward.id,
        },
      ];
    } else if (reward.kind === "free_item") {
      // The item was deleted or is sold out. Losing an earned reward to a menu
      // edit would be the wrong way round, so it becomes money off instead.
      reward.kind = "discount_fixed";
      reward.amountSen = this.menu.getItem(reward.itemId ?? "")?.priceSen ?? 490;
      reward.label = `${formatSen(reward.amountSen)} off`;
      delete reward.itemId;
    }

    cart.updatedAt = new Date().toISOString();
    await this.carts.save(cart);

    return { cart: priceCart(cart.id, cart.lines, this.menu, cart.tableNumber, cart.rewards), reward };
  }

  private async save(cart: Cart): Promise<void> {
    cart.updatedAt = new Date().toISOString();
    await this.carts.save(cart);
  }
}

/**
 * The spend trigger, checked wherever the subtotal might have moved.
 *
 * Idempotent by the claim list, so crossing RM50, dropping back under it and
 * crossing again is still one chance — the reward is for the order, not for the
 * number of times a quantity was tapped.
 */
function awardSpendChance(cart: Cart, subtotalSen: number): void {
  if (subtotalSen >= SPEND_CHANCE_THRESHOLD_SEN) claim(cart, "spend");
}

/** Grants a chance for a one-time trigger, or does nothing if it is already spent. */
function claim(cart: Cart, trigger: ChanceTrigger): boolean {
  if (cart.claimed.includes(trigger)) return false;
  cart.claimed.push(trigger);
  cart.chances += 1;
  return true;
}

export interface ConfirmOrderInput {
  cartId: string;
  customerName?: string | undefined;
  /**
   * Rung up at the counter by staff rather than scanned at a table.
   *
   * Gives the order its daily `takeawayNumber`, and — when the customer is
   * paying by card — holds it off the pass until the payment settles.
   */
  takeaway?: { holdForPayment: boolean } | undefined;
  /**
   * The customer chose to settle with staff before leaving.
   *
   * Deliberately **not** a hold: nothing was charged, so there is nothing to
   * wait for, and the ticket reaches the kitchen the moment it is placed — the
   * same as any other QR order. The hold exists for card takeaways, where the
   * customer is standing at the terminal with a card in their hand.
   */
  payAtCounter?: boolean | undefined;
}

export interface DailySales {
  /** `YYYY-MM-DD` in the shop's own timezone. */
  day: string;
  timeZone: string;
  count: number;
  totalSen: number;
  total: string;
}

/** Takings from one of the two ways an order reaches the kitchen. */
export interface ChannelSplit {
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
  /** The same takings split by how the order was taken. */
  dineIn: ChannelSplit;
  takeaway: ChannelSplit;
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
  /** Range totals per channel, for the summary cards. */
  dineIn: ChannelSplit;
  takeaway: ChannelSplit;
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

    const priced = priceCart(cart.id, cart.lines, this.menu, cart.tableNumber, cart.rewards);
    const now = new Date().toISOString();

    const order: Order = {
      id: randomUUID(),
      reference: await this.nextReference(),
      lines: priced.lines,
      itemCount: priced.itemCount,
      // Carried across whole rather than recomputed: the order is charged the
      // number the customer was shown, and there is only one place that number
      // is worked out.
      subtotalSen: priced.subtotalSen,
      // The rewards ride along onto the order, so the receipt and the amount
      // the provider is asked for both already have them in.
      discountSen: priced.discountSen,
      discount: priced.discount,
      rewards: priced.rewards,
      taxSen: priced.taxSen,
      totalSen: priced.totalSen,
      taxRate: priced.taxRate,
      subtotal: priced.subtotal,
      tax: priced.tax,
      total: priced.total,
      // `pending` means a gateway is mid-flight. A counter order has no gateway
      // and never will until somebody settles it, and the counter has to be
      // able to tell those two apart to know whose money to go and collect.
      paymentStatus: input.payAtCounter ? "unpaid_counter" : "pending",
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

    if (input.takeaway) {
      order.takeawayNumber = await this.nextTakeawayNumber();
      // Only ever set true; an absent flag is what every other order carries.
      if (input.takeaway.holdForPayment) order.holdForPayment = true;
    }

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
  async markPaid(
    orderId: string,
    paidAt = new Date().toISOString(),
    providerPaymentIntentId?: string,
  ): Promise<MarkPaidResult> {
    const order = await this.get(orderId);
    if (order.paymentStatus === "paid") {
      return { order, changed: false };
    }
    // A webhook that lands after the money has already gone back must not put
    // it into the takings again. Stripe redelivers for days, and a refunded
    // order quietly flipping to `paid` is the exact leak this status exists to
    // close, reopened from the other end.
    if (order.paymentStatus === "refunded") {
      return { order, changed: false };
    }

    order.paymentStatus = "paid";
    order.updatedAt = paidAt;
    if (order.payment) {
      order.payment.status = "paid";
      order.payment.paidAt = paidAt;
      // Kept now because it is only ever offered now: a refund needs the
      // PaymentIntent, and the webhook that says "paid" is the one thing that
      // carries it. Asking Stripe again later works, but costs a round trip at
      // the moment a staff member is standing there waiting.
      if (providerPaymentIntentId !== undefined) {
        order.payment.providerPaymentIntentId = providerPaymentIntentId;
      }
    }
    await this.orders.save(order);
    return { order, changed: true };
  }

  /**
   * Cash over the counter: paid the moment it is rung up.
   *
   * There is no provider to ask and no webhook to wait for — the money is in
   * the till — so this is the one path that may set `paid` without one. It
   * refuses an order that already has a payment session, because that one is
   * mid-flight with a provider and a second settlement would be a lie about
   * which of them the customer actually paid.
   */
  async takeCash(orderId: string): Promise<Order> {
    const order = await this.get(orderId);
    if (order.payment) {
      throw new OrderValidationError(
        "That order already has a card payment in progress.",
        "payment_already_started",
        { orderId, provider: order.payment.provider },
      );
    }

    order.paidInCash = true;
    await this.orders.save(order);
    const { order: paid } = await this.markPaid(orderId);
    return paid;
  }

/**
   * Keeps an order owing at the counter after a gateway session is opened on it.
   *
   * `initiate` moves an order to `pending`, which is right for a customer paying
   * on their own phone and wrong here. A counter order that has had a QR put in
   * front of it has still not been paid, and if it stopped saying so the Unpaid
   * badge would come off the boards — and the order would look, to everyone on
   * shift, like money that was already on its way — while it was still owed.
   *
   * The payment record stays attached, so the webhook still finds it and still
   * settles it. Only the status is held back.
   *
   * Note this does **not** re-open cash: `takeCash` still refuses an order with
   * a live card session, because taking notes on top of a QR that may already
   * have gone through is a double charge. A customer who walks off mid-payment
   * is a cancellation, not a second settlement.
   */
  async keepOwingAtCounter(orderId: string): Promise<Order> {
    const order = await this.get(orderId);
    if (order.paymentStatus !== "pending") return order;

    order.paymentStatus = "unpaid_counter";
    order.updatedAt = new Date().toISOString();
    await this.orders.save(order);
    return order;
  }

  /**
   * Stamps who is handling this transaction onto the order.
   *
   * Called *after* the eligibility check and *before* the money moves, so an
   * order that could not be settled anyway is never attributed to the person who
   * tried — and so every step that follows re-reads an order that already
   * carries the name.
   *
   * The last person to touch it wins, which is the honest answer: a counter
   * order that had a QR put in front of it and was then paid in cash by someone
   * else on the next shift was processed by the second person.
   */
  async recordProcessedBy(orderId: string, processedBy: ProcessedBy): Promise<Order> {
    const order = await this.get(orderId);
    order.processedBy = processedBy;
    order.updatedAt = new Date().toISOString();
    await this.orders.save(order);
    return order;
  }

  /**
   * The order a staff member is about to settle at the counter.
   *
   * Refuses anything that is not actually owed at the counter: an order already
   * paid must not be charged twice, and a card order mid-flight with a gateway
   * is somebody else's problem — settling that one here would take the money
   * twice when its webhook lands.
   */
  async counterSettlementTarget(orderId: string): Promise<Order> {
    const order = await this.get(orderId);

    if (order.paymentStatus === "paid") {
      throw new OrderValidationError("That order is already paid.", "already_paid", { orderId });
    }
    if (order.paymentStatus !== "unpaid_counter") {
      throw new OrderValidationError(
        "That order is not waiting to be paid at the counter.",
        "not_a_counter_order",
        { orderId, paymentStatus: order.paymentStatus },
      );
    }
    return order;
  }

  async markFailed(orderId: string, reason: string): Promise<MarkPaidResult> {
    const order = await this.get(orderId);
    // A late failure for an order already paid is noise; never downgrade a paid
    // order — nor a refunded one, whose record of where the money went is worth
    // more than a stale failure notice.
    if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
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

  /**
   * The customer asks for the order to be called off.
   *
   * A *request*. Nothing about the order changes except that a badge appears on
   * the boards: only somebody at the pass can see whether the fryer is already
   * halfway through it, so only they can answer. The customer is told plainly
   * that they are waiting.
   *
   * Idempotent — asking twice is the same as asking once, because a customer
   * tapping again because nothing has happened yet is not an error worth
   * showing them.
   */
  async requestCancellation(orderId: string): Promise<Order> {
    const order = await this.get(orderId);

    if (order.kitchenStatus === "cancelled") {
      throw new OrderValidationError("This order has already been cancelled.", "already_cancelled", {
        orderId,
        kitchenStatus: order.kitchenStatus,
      });
    }
    if (!isCancellable(order)) {
      // Past `cooking` the food exists. This is the refusal the whole endpoint
      // is built around, and it names the status so the page can explain why.
      throw new OrderValidationError(
        order.kitchenStatus === "collected"
          ? "This order has already been collected."
          : "Your order is already being prepared and can no longer be cancelled here. Please speak to a member of staff.",
        "cancellation_too_late",
        { orderId, kitchenStatus: order.kitchenStatus },
      );
    }

    if (cancellationPending(order)) return order;

    order.cancellationRequested = true;
    order.cancellationRequestedAt = new Date().toISOString();
    // A fresh request clears the last refusal, or the page would go on showing
    // "could not be cancelled" over a request nobody has looked at yet.
    delete order.cancellationDeniedAt;
    order.updatedAt = order.cancellationRequestedAt;
    await this.orders.save(order);
    return order;
  }

  /**
   * Staff say no: the food is already happening.
   *
   * The order carries on exactly as it was — same status, same place in the
   * queue, nothing rewound. Only the flag comes down, and a timestamp goes on
   * so the customer's page can say what happened rather than silently losing
   * the request it made.
   */
  async denyCancellation(orderId: string): Promise<Order> {
    const order = await this.get(orderId);
    if (!cancellationPending(order)) {
      throw new OrderValidationError(
        "There is no cancellation request on this order.",
        "no_cancellation_request",
        { orderId },
      );
    }

    order.cancellationRequested = false;
    order.cancellationDeniedAt = new Date().toISOString();
    order.updatedAt = order.cancellationDeniedAt;
    await this.orders.save(order);
    return order;
  }

  /**
   * The order a staff member is about to cancel, checked before any money moves.
   *
   * Split from `completeCancellation` because a refund sits between the two: the
   * provider call must not be made against an order that is already cancelled,
   * and the order must not be marked cancelled before the provider has answered.
   */
  async cancellationTarget(orderId: string): Promise<Order> {
    const order = await this.get(orderId);
    if (order.kitchenStatus === "cancelled") {
      throw new OrderValidationError("This order has already been cancelled.", "already_cancelled", {
        orderId,
      });
    }
    if (!cancellationPending(order)) {
      throw new OrderValidationError(
        "There is no cancellation request on this order.",
        "no_cancellation_request",
        { orderId },
      );
    }
    return order;
  }

  /**
   * The order a staff member is about to cancel off their own bat.
   *
   * The counterpart to `cancellationTarget`, and deliberately a separate method
   * rather than a flag on it: this one does **not** require the customer to have
   * asked. What it still refuses is an order that has already gone — cancelled
   * twice, or handed over — because both would be a lie about something that
   * already happened, and the first would try to refund twice.
   */
  async staffCancellationTarget(orderId: string): Promise<Order> {
    const order = await this.get(orderId);

    if (order.kitchenStatus === "cancelled") {
      throw new OrderValidationError("This order has already been cancelled.", "already_cancelled", {
        orderId,
      });
    }
    if (!(STAFF_CANCELLABLE_STATUSES as readonly string[]).includes(order.kitchenStatus)) {
      throw new OrderValidationError(
        "This order has already been collected and cannot be cancelled.",
        "cancellation_after_collection",
        { orderId, kitchenStatus: order.kitchenStatus },
      );
    }
    return order;
  }

  /**
   * Writes the cancellation, and the receipt for whatever happened to the money.
   *
   * The food and the money are set together but decided separately: the order
   * is always `cancelled`, and its payment becomes `refunded` **only** when the
   * refund is confirmed. That one condition is the whole revenue fix — takings
   * are `paymentStatus === "paid"` and nothing else, in both repositories, so a
   * confirmed refund leaves the report by construction while a pending, failed
   * or manual one stays in it, because the shop still has the money.
   */
  async completeCancellation(orderId: string, refund: OrderRefund): Promise<Order> {
    const order = await this.get(orderId);

    order.kitchenStatus = "cancelled";
    // Down, not left true: the badge on the boards means "waiting on a
    // decision", and this *is* the decision.
    order.cancellationRequested = false;
    order.cancelledAt = new Date().toISOString();
    order.refund = refund;

    if (refund.outcome === "refunded" && order.paymentStatus === "paid") {
      order.paymentStatus = "refunded";
      if (order.payment) order.payment.status = "refunded";
    }

    order.updatedAt = order.cancelledAt;
    await this.orders.save(order);
    return order;
  }

  /** Today's orders, newest first — what the staff board shows. */
  async feed(timeZone: string = config.businessTimeZone): Promise<Order[]> {
    const { start } = businessDayRange(businessDay(new Date(), timeZone), timeZone);
    const today = await this.orders.createdSince(start);
    // A staff takeaway paid by card is not a ticket until the money lands; the
    // customer is at the counter and the terminal has not answered yet. Nothing
    // else is filtered — a table's order reaches the kitchen unpaid, as it
    // always has.
    return today.filter((order) => !(order.holdForPayment && order.paymentStatus !== "paid"));
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

    const empty = () => ({ count: 0, totalSen: 0, dineIn: tally(), takeaway: tally() });
    const takings = new Map(days.map((day) => [day, empty()]));

    for (const order of paid) {
      // The query bounds the range, so every settled order lands in a bucket —
      // but a clock skewed past the last boundary should be dropped, not thrown.
      const bucket = takings.get(businessDay(settledAt(order), timeZone));
      if (!bucket) continue;
      bucket.count += 1;
      bucket.totalSen += order.totalSen;

      // Split by where the food went, not by who typed the order in: a QR order
      // with no table is a counter order and belongs with the takeaways.
      const channel = order.tableNumber === undefined ? bucket.takeaway : bucket.dineIn;
      channel.count += 1;
      channel.totalSen += order.totalSen;
    }

    const breakdown: SalesReportDay[] = days.map((day) => {
      const { count, totalSen, dineIn, takeaway } = takings.get(day)!;
      return {
        day,
        count,
        totalSen,
        total: formatSen(totalSen),
        dineIn: split(dineIn),
        takeaway: split(takeaway),
      };
    });

    const totalSen = breakdown.reduce((sum, day) => sum + day.totalSen, 0);
    const sum = (pick: (day: SalesReportDay) => ChannelSplit): ChannelSplit =>
      split(
        breakdown.reduce(
          (running, day) => ({
            count: running.count + pick(day).count,
            totalSen: running.totalSen + pick(day).totalSen,
          }),
          { count: 0, totalSen: 0 },
        ),
      );

    return {
      startDate,
      endDate,
      timeZone,
      count: breakdown.reduce((sum_, day) => sum_ + day.count, 0),
      totalSen,
      total: formatSen(totalSen),
      dineIn: sum((day) => day.dineIn),
      takeaway: sum((day) => day.takeaway),
      days: breakdown,
    };
  }

  /** "AB-4821" — short enough to read out at the counter. */
  /**
   * The next "Takeaway #N" for today.
   *
   * Counted from the day's own orders rather than held in a counter, so it
   * resets at the business-day boundary by construction and survives a restart
   * — a stored counter would have to be reset by something, and that something
   * would be a scheduled job that can fail quietly overnight.
   *
   * Two staff ringing up at the same instant can land on the same number. That
   * is a label shouted across a counter, not an identity: `reference` is the
   * unique one, and it is what every lookup and every payment uses.
   */
  private async nextTakeawayNumber(timeZone: string = config.businessTimeZone): Promise<number> {
    const { start } = businessDayRange(businessDay(new Date(), timeZone), timeZone);
    const today = await this.orders.createdSince(start);
    const highest = today.reduce((max, order) => Math.max(max, order.takeawayNumber ?? 0), 0);
    return highest + 1;
  }

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

/** A running channel tally, before it is given its formatted total. */
function tally(): { count: number; totalSen: number } {
  return { count: 0, totalSen: 0 };
}

function split(counted: { count: number; totalSen: number }): ChannelSplit {
  return { count: counted.count, totalSen: counted.totalSen, total: formatSen(counted.totalSen) };
}
