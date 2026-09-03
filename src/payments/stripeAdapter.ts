import { isPlaceholder, type StripeConfig } from "../config/env.js";
import type { PaymentMethod } from "../orders/types.js";
import { hmacHex, simulatedSession, timingSafeEqualHex } from "./simulation.js";
import {
  PaymentProviderError,
  headerValue,
  type CreatePaymentRequest,
  type PaymentAdapter,
  type PaymentEvent,
  type PaymentSession,
  type WebhookHeaders,
  type WebhookVerification,
} from "./types.js";

/** Reject signatures older than this. Stripe's own recommended tolerance. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Card payments via Stripe Checkout.
 *
 * Talks to the REST API with `fetch` rather than pulling in the `stripe` SDK —
 * two endpoints and one HMAC check is not worth a dependency, and it keeps the
 * adapter's surface identical in shape to the Revenue Monster one.
 *
 * NOTE: written against Stripe's documented API but not yet exercised against a
 * live test account — no sandbox keys were available when this was built.
 */
export class StripeAdapter implements PaymentAdapter {
  readonly provider = "stripe" as const;
  readonly methods = ["card"] as const satisfies readonly PaymentMethod[];
  readonly displayName = "Card";
  readonly brands = ["Visa", "Mastercard", "Amex"];

  constructor(
    private readonly config: StripeConfig,
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return !isPlaceholder(this.config.secretKey);
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentSession> {
    const secretKey = this.config.secretKey;
    if (!this.isConfigured() || secretKey === undefined) {
      return simulatedSession(this.provider, request.order, this.publicBaseUrl);
    }

    const body = this.checkoutSessionParams(request);

    const response = await this.fetchImpl(`${this.config.apiBase}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        // Stripe dedupes on this, so a retry cannot create a second session.
        "idempotency-key": request.idempotencyKey,
      },
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    };

    if (!response.ok || !payload.id) {
      throw new PaymentProviderError(
        payload.error?.message ?? `Stripe rejected the checkout session (${response.status}).`,
        this.provider,
        response.status,
        payload,
      );
    }

    const session: PaymentSession = {
      provider: this.provider,
      providerPaymentId: payload.id,
      status: "pending",
      simulated: false,
    };
    // A JSON `null` is not a link. `!== undefined` would store one anyway.
    if (payload.url) session.checkoutUrl = payload.url;
    return session;
  }

  /** Form-encodes the order as Stripe line items. Prices come from our own totals. */
  private checkoutSessionParams(request: CreatePaymentRequest): URLSearchParams {
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", request.returnUrl);
    params.set("cancel_url", request.cancelUrl);
    params.set("client_reference_id", request.order.id);
    params.set("metadata[order_id]", request.order.id);
    params.set("metadata[order_reference]", request.order.reference);
    params.set("payment_method_types[0]", "card");

    request.order.lines.forEach((line, index) => {
      const options = line.options.map((option) => option.choiceName).join(", ");
      params.set(`line_items[${index}][price_data][currency]`, "myr");
      params.set(
        `line_items[${index}][price_data][product_data][name]`,
        options.length > 0 ? `${line.name} (${options})` : line.name,
      );
      params.set(`line_items[${index}][price_data][unit_amount]`, String(line.unitPriceSen));
      params.set(`line_items[${index}][quantity]`, String(line.quantity));
    });

    return params;
  }

  verifyAndParseWebhook(rawBody: string, headers: WebhookHeaders): WebhookVerification {
    const secret = this.config.webhookSecret;
    if (isPlaceholder(secret) || secret === undefined) {
      return { valid: false, reason: "STRIPE_WEBHOOK_SECRET is not configured" };
    }

    const header = headerValue(headers, "stripe-signature");
    if (!header) return { valid: false, reason: "missing stripe-signature header" };

    const parts = new Map<string, string[]>();
    for (const segment of header.split(",")) {
      const [key, value] = segment.split("=", 2);
      if (key === undefined || value === undefined) continue;
      const bucket = parts.get(key.trim()) ?? [];
      bucket.push(value.trim());
      parts.set(key.trim(), bucket);
    }

    const timestamp = parts.get("t")?.[0];
    const signatures = parts.get("v1") ?? [];
    if (timestamp === undefined || signatures.length === 0) {
      return { valid: false, reason: "malformed stripe-signature header" };
    }

    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      return { valid: false, reason: "signature timestamp outside tolerance" };
    }

    const expected = hmacHex(secret, `${timestamp}.${rawBody}`);
    if (!signatures.some((signature) => timingSafeEqualHex(signature, expected))) {
      return { valid: false, reason: "signature mismatch" };
    }

    try {
      return { valid: true, event: parseStripeEvent(rawBody) };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "unparseable event" };
    }
  }
}

interface StripeEventShape {
  id?: string;
  type?: string;
  created?: number;
  data?: {
    object?: {
      id?: string;
      payment_status?: string;
      amount_total?: number;
      currency?: string;
      client_reference_id?: string;
      metadata?: Record<string, string>;
    };
  };
}

function parseStripeEvent(rawBody: string): PaymentEvent {
  const parsed = JSON.parse(rawBody) as StripeEventShape;
  const object = parsed.data?.object;

  if (!parsed.id || !parsed.type || !object?.id) {
    throw new Error("event missing id, type or data.object");
  }

  const event: PaymentEvent = {
    provider: "stripe",
    eventId: parsed.id,
    type: stripeEventType(parsed.type, object.payment_status),
    providerPaymentId: object.id,
    occurredAt: new Date((parsed.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };

  const orderId = object.metadata?.order_id ?? object.client_reference_id;
  if (orderId !== undefined) event.orderId = orderId;
  if (object.amount_total !== undefined) event.amountSen = object.amount_total;
  if (object.currency !== undefined) event.currency = object.currency.toUpperCase();

  return event;
}

function stripeEventType(type: string, paymentStatus: string | undefined): PaymentEvent["type"] {
  switch (type) {
    case "checkout.session.completed":
      // An unpaid completed session means an async method is still settling.
      return paymentStatus === "unpaid" ? "ignored" : "payment_succeeded";
    case "checkout.session.async_payment_succeeded":
      return "payment_succeeded";
    case "checkout.session.expired":
      return "payment_expired";
    case "checkout.session.async_payment_failed":
    case "payment_intent.payment_failed":
      return "payment_failed";
    default:
      return "ignored";
  }
}
