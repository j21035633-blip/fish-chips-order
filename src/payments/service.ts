import { randomUUID } from "node:crypto";

import { config } from "../config/env.js";
import { OrderService } from "../orders/service.js";
import {
  OrderValidationError,
  type Order,
  type OrderPayment,
  type OrderRefund,
  type PaymentMethod,
  type PaymentProvider,
} from "../orders/types.js";
import type { ProcessedBy } from "../staff/accounts.js";
import { RevenueMonsterAdapter } from "./revenueMonsterAdapter.js";
import { isSimulatedPaymentId } from "./simulation.js";
import { StripeAdapter } from "./stripeAdapter.js";
import type { PaymentAdapter, PaymentEvent, PaymentMethodOption, WebhookHeaders } from "./types.js";

export interface WebhookOutcome {
  handled: boolean;
  /** Why we did nothing, when we did nothing. */
  reason?: string;
  event?: PaymentEvent;
  order?: Order;
  /** False when the order was already in this state — a redelivery. */
  changed: boolean;
}

/**
 * Owns the payment lifecycle: pick an adapter for the chosen method, record the
 * attempt on the order, and settle it when the provider's webhook arrives.
 *
 * An order only ever moves pending → paid through `handleWebhook`. The redirect
 * the customer follows back from a provider is *not* proof of payment — anyone
 * can open that URL — so the success page only ever reads status, never sets it.
 */
export class PaymentService {
  private readonly byProvider = new Map<PaymentProvider, PaymentAdapter>();
  private readonly byMethod = new Map<PaymentMethod, PaymentAdapter>();
  /** Event ids already applied, so a redelivery is a no-op. */
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly orders: OrderService,
    adapters: PaymentAdapter[],
    private readonly publicBaseUrl: string = config.publicBaseUrl,
  ) {
    for (const adapter of adapters) {
      this.byProvider.set(adapter.provider, adapter);
      for (const method of adapter.methods) {
        this.byMethod.set(method, adapter);
      }
    }
  }

  /** What the checkout picker renders. */
  availableMethods(): PaymentMethodOption[] {
    return [...this.byMethod.entries()].map(([method, adapter]) => ({
      method,
      provider: adapter.provider,
      label: adapter.displayName,
      description:
        method === "card" ? "Pay by debit or credit card" : "Scan or tap with your e-wallet app",
      brands: adapter.brands,
      available: true,
      simulated: !adapter.isConfigured(),
    }));
  }

  adapterFor(method: PaymentMethod): PaymentAdapter {
    const adapter = this.byMethod.get(method);
    if (!adapter) {
      throw new OrderValidationError(`No payment provider handles "${method}".`, "unsupported_method", { method });
    }
    return adapter;
  }

  /**
   * Starts a payment for an order and records the attempt.
   *
   * Re-initiating a pending order is allowed — a customer who closed the Stripe
   * tab needs a fresh link — but a paid order is refused by `attachPayment`.
   */
  async initiate(orderId: string, method: PaymentMethod): Promise<Order> {
    const order = await this.orders.get(orderId);
    const adapter = this.adapterFor(method);

    const session = await adapter.createPayment({
      order,
      method,
      returnUrl: `${this.publicBaseUrl}/order/${order.id}`,
      cancelUrl: `${this.publicBaseUrl}/order/${order.id}?cancelled=1`,
      // New key per attempt: a retry of *this* call is deduped, a deliberate
      // second attempt is not.
      idempotencyKey: `${order.id}:${randomUUID()}`,
    });

    if (!session.simulated && !session.checkoutUrl && !session.qrCodeUrl) {
      // The provider accepted the payment but gave the customer nowhere to go.
      // Nothing downstream can recover from that on its own, and without a line
      // here there is no trace of it in the logs at all.
      console.error(
        `[payments] ${session.provider} returned no checkout URL or QR for order ${order.reference} ` +
          `(payment ${session.providerPaymentId}) — the customer cannot pay from this session.`,
      );
    }

    const payment: OrderPayment = {
      method,
      provider: session.provider,
      providerPaymentId: session.providerPaymentId,
      status: session.status,
      simulated: session.simulated,
      createdAt: new Date().toISOString(),
    };
    if (session.checkoutUrl !== undefined) payment.checkoutUrl = session.checkoutUrl;
    if (session.qrCodeUrl !== undefined) payment.qrCodeUrl = session.qrCodeUrl;

    return this.orders.attachPayment(order.id, payment);
  }

  /**
   * The only path from pending to paid.
   *
   * Verifies the provider's signature, drops redeliveries, checks the amount
   * matches what we charged, then transitions the order.
   */
  async handleWebhook(
    provider: PaymentProvider,
    rawBody: string,
    headers: WebhookHeaders,
  ): Promise<WebhookOutcome> {
    const adapter = this.byProvider.get(provider);
    if (!adapter) {
      return { handled: false, reason: `unknown provider "${provider}"`, changed: false };
    }

    const verification = adapter.verifyAndParseWebhook(rawBody, headers);
    if (!verification.valid) {
      return { handled: false, reason: verification.reason, changed: false };
    }

    const event = verification.event;

    if (this.seenEvents.has(event.eventId)) {
      return { handled: true, reason: "duplicate event", event, changed: false };
    }

    if (event.type === "ignored") {
      this.seenEvents.add(event.eventId);
      return { handled: true, reason: "event type not actionable", event, changed: false };
    }

    const order = await this.findOrder(event);
    if (!order) {
      // Do not mark seen: the order may simply not have been saved yet, and the
      // provider will retry.
      return { handled: false, reason: "no matching order", event, changed: false };
    }

    // An amount that does not match what we charged means the event is not for
    // this order, or the order was tampered with. Never settle on it.
    if (event.amountSen !== undefined && event.amountSen !== order.totalSen) {
      return {
        handled: false,
        reason: `amount mismatch: event ${event.amountSen}, order ${order.totalSen}`,
        event,
        order,
        changed: false,
      };
    }

    this.seenEvents.add(event.eventId);

    if (event.type === "payment_succeeded") {
      // The intent rides along because this is the only message that carries
      // it, and a refund later cannot be taken without it.
      const result = await this.orders.markPaid(
        order.id,
        event.occurredAt,
        event.providerPaymentIntentId,
      );
      return { handled: true, event, order: result.order, changed: result.changed };
    }

    const reason = event.type === "payment_expired" ? "payment expired" : "payment failed";
    const result = await this.orders.markFailed(order.id, reason);
    return { handled: true, reason, event, order: result.order, changed: result.changed };
  }

  /**
   * Settles a *simulated* payment, for local development without provider keys.
   *
   * Refuses anything that is not a simulated session, so this can never settle a
   * real order even if the route is left mounted.
   */
  async settleSimulated(orderId: string): Promise<Order> {
    const order = await this.orders.get(orderId);
    const payment = order.payment;

    if (!payment || !payment.simulated || !isSimulatedPaymentId(payment.providerPaymentId)) {
      throw new OrderValidationError(
        "That order has no simulated payment to settle.",
        "not_simulated",
        { orderId },
      );
    }

    const adapter = this.byProvider.get(payment.provider);
    if (adapter?.isConfigured()) {
      throw new OrderValidationError(
        `${payment.provider} has real credentials configured — simulated settlement is disabled.`,
        "simulation_disabled",
        { orderId, provider: payment.provider },
      );
    }

    return (await this.orders.markPaid(order.id)).order;
  }

  /**
   * Staff approve a cancellation: the order is called off and the money goes
   * back.
   *
   * It lives here rather than on `OrderService` because it is the one
   * cancellation step that has to talk to a provider, and this class is already
   * the only thing in the app that does. The order of operations is the point:
   *
   *   1. check the order is really waiting to be cancelled — **before** any
   *      money moves, so a double-tap cannot refund twice;
   *   2. refund, and find out what happened;
   *   3. write the cancellation *and* the receipt for the money together.
   *
   * A refund that fails does **not** abandon the cancellation. The staff member
   * has already told the customer it is off, and an order left half-cancelled
   * because Stripe had a bad minute is worse than one recorded as cancelled
   * with "the refund failed, do it by hand" written on it in plain sight.
   */
  async approveCancellation(orderId: string): Promise<{ order: Order; refund: OrderRefund }> {
    return this.cancelAndRefund(await this.orders.cancellationTarget(orderId));
  }

/**
   * Settle an order the customer chose to pay for at the counter.
   *
   * Three ways, and they are not variations on one thing:
   *
   * - **cash** is over and done with. There is no provider to ask and no
   *   webhook coming, so `takeCash` marks it paid on the spot — the money is
   *   in the till and the till is the record.
   * - **card** and **ewallet** open a real gateway session for the order total
   *   and hand back a link or a QR for the staff member to turn round to the
   *   customer. It is **not** paid at that point, and deliberately: the money
   *   only counts when the provider's webhook says so, which is the same rule
   *   every other card order in this system follows. A staff member watching a
   *   customer tap a phone is not proof of payment.
   *
   * The eligibility check comes first, so an order that is already paid, or one
   * with a gateway of its own mid-flight, cannot be settled twice.
   *
   * `processedBy` is required rather than optional: taking money at the counter
   * is exactly the act this shop wanted attributable, and an optional parameter
   * is one forgetful call site away from an unattributed transaction. Verifying
   * the person stays at the HTTP edge, where their typed id and name arrive —
   * this takes the answer, not the question.
   */
  async settleAtCounter(
    orderId: string,
    method: "cash" | PaymentMethod,
    processedBy: ProcessedBy,
  ): Promise<{ order: Order; settled: boolean }> {
    await this.orders.counterSettlementTarget(orderId);
    // Eligibility first, attribution second, money third. An order that cannot
    // be settled must not end up stamped with the name of whoever tried.
    await this.orders.recordProcessedBy(orderId, processedBy);

    if (method === "cash") {
      return { order: await this.orders.takeCash(orderId), settled: true };
    }

    // The customer's own path, reused whole: same adapters, same idempotency,
    // same webhook. Nothing about how this order gets paid differs from one
    // paid on a phone at the table — only who is holding the phone.
    await this.initiate(orderId, method);
    // ...but it goes on owing until the webhook says otherwise. `initiate`
    // leaves an order `pending`, which would take the Unpaid badge off the
    // boards and make it look, to everyone on shift, like money already on its
    // way — while it was still sitting uncollected.
    return { order: await this.orders.keepOwingAtCounter(orderId), settled: false };
  }

  /**
   * A staff member cancels an order themselves, without being asked.
   *
   * The faster path for the counter — a customer who never came back for a
   * ready order, an order rung up twice — and it runs through **exactly** the
   * same money as the approval above. That sharing is the point: a second
   * refund implementation is a second place for the confirmation rule to be got
   * wrong, and getting it wrong means either keeping a customer's money or
   * writing off takings the shop still holds.
   *
   * The only difference is which orders are eligible. This one needs no
   * customer request, and reaches a `ready` order that the customer's own
   * window has already closed on — which is exactly when the counter needs it.
   */
  async cancelByStaff(orderId: string): Promise<{ order: Order; refund: OrderRefund }> {
    return this.cancelAndRefund(await this.orders.staffCancellationTarget(orderId));
  }

  /**
   * Refund, then write the cancellation and the receipt together.
   *
   * Shared so the order of operations cannot drift between the two entry
   * points: eligibility has already been checked by the caller — **before** any
   * money moves, so a double-tap cannot refund twice — and the order is only
   * marked cancelled once the provider has answered.
   */
  private async cancelAndRefund(target: Order): Promise<{ order: Order; refund: OrderRefund }> {
    const refund = await this.refundFor(target);
    const order = await this.orders.completeCancellation(target.id, refund);
    return { order, refund };
  }

  /**
   * What giving the money back means for this particular order.
   *
   * Four honest answers, and the one that matters most is `manual`: money was
   * really taken, on a rail this cannot refund itself, and somebody has to do
   * it by hand. Recording that loudly is the whole reason this returns a record
   * rather than a boolean — the failure mode to design against is a customer
   * told their order is cancelled while the shop quietly keeps the money.
   */
  private async refundFor(order: Order): Promise<OrderRefund> {
    const at = new Date().toISOString();

    if (order.paymentStatus !== "paid") {
      return { outcome: "none", reason: "This order was never paid, so there is nothing to refund.", at };
    }

    if (order.paidInCash) {
      return {
        outcome: "none",
        reason: "Paid in cash — hand the money back at the till.",
        amountSen: order.totalSen,
        amount: order.total,
        at,
      };
    }

    const provider = order.payment?.provider;
    const adapter = provider ? this.byProvider.get(provider) : undefined;

    if (!adapter?.refund) {
      return {
        outcome: "manual",
        reason: provider
          ? `Paid by ${adapter?.displayName ?? provider}, which has to be refunded by hand in the provider's dashboard.`
          : "Marked paid with no payment record — refund this one by hand.",
        amountSen: order.totalSen,
        amount: order.total,
        ...(provider ? { provider } : {}),
        at,
      };
    }

    try {
      const result = await adapter.refund({
        order,
        // The full amount, always: this is a cancellation, not a partial credit.
        amountSen: order.totalSen,
        // Stable per order, so a second Approve cannot send the money twice.
        idempotencyKey: `refund_${order.id}`,
      });

      // Accepted is not settled. A refund the provider has queued but not put
      // through is money the shop still holds, so it stays `paid` and stays in
      // the day's takings until it is confirmed — under-reporting real revenue
      // is its own kind of wrong.
      const outcome = result.confirmed ? "refunded" : "pending";

      return {
        outcome,
        reason: !result.confirmed
          ? `Refund of ${order.total} accepted by the provider but not settled yet — check it has gone through.`
          : result.simulated
            ? `Simulated refund of ${order.total} — no provider credentials are configured.`
            : `${order.total} refunded to the card it was paid with.`,
        amountSen: result.amountSen,
        amount: order.total,
        provider: result.provider,
        providerRefundId: result.providerRefundId,
        simulated: result.simulated,
        at,
      };
    } catch (error) {
      // Deliberately swallowed into a record rather than thrown: see the note
      // on `approveCancellation`. The order still gets cancelled, and this is
      // what tells somebody the money did not follow it.
      return {
        outcome: "failed",
        reason: `The refund failed and has to be done by hand: ${
          error instanceof Error ? error.message : String(error)
        }`,
        amountSen: order.totalSen,
        amount: order.total,
        ...(provider ? { provider } : {}),
        at,
      };
    }
  }

  private async findOrder(event: PaymentEvent): Promise<Order | undefined> {
    if (event.orderId !== undefined) {
      const byId = await this.orders.findByProviderPaymentId(event.providerPaymentId);
      if (byId) return byId;
      try {
        return await this.orders.get(event.orderId);
      } catch {
        // Fall through to the payment-id lookup below.
      }
    }
    return this.orders.findByProviderPaymentId(event.providerPaymentId);
  }
}

/** Wires the two adapters from environment config. */
export function createPaymentService(orders: OrderService): PaymentService {
  return new PaymentService(
    orders,
    [
      new StripeAdapter(config.stripe, config.publicBaseUrl),
      new RevenueMonsterAdapter(config.revenueMonster, config.publicBaseUrl),
    ],
    config.publicBaseUrl,
  );
}
