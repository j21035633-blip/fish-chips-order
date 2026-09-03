import { randomUUID } from "node:crypto";

import { config } from "../config/env.js";
import { OrderService } from "../orders/service.js";
import {
  OrderValidationError,
  type Order,
  type OrderPayment,
  type PaymentMethod,
  type PaymentProvider,
} from "../orders/types.js";
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
      const result = await this.orders.markPaid(order.id, event.occurredAt);
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
