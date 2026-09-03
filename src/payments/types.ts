import type { Order, PaymentMethod, PaymentProvider, PaymentStatus } from "../orders/types.js";

/**
 * The payment provider contract.
 *
 * Written the same way `MenuRepository` is, and the way the POSAdapter will be:
 * the application talks to this interface only. Nothing outside `src/payments/`
 * imports Stripe or Revenue Monster, so adding a third rail (or dropping one) is
 * a registry change.
 */

export interface CreatePaymentRequest {
  order: Order;
  method: PaymentMethod;
  /** Where the provider sends the customer once they are done. */
  returnUrl: string;
  cancelUrl: string;
  /** Stable per order+attempt, so a retried request cannot double-charge. */
  idempotencyKey: string;
}

export interface PaymentSession {
  provider: PaymentProvider;
  /** The provider's own id. What a webhook will quote back at us. */
  providerPaymentId: string;
  status: PaymentStatus;
  /** Redirect rail (Stripe Checkout, RM's hosted page). */
  checkoutUrl?: string;
  /** Scan rail — DuitNow and friends show a code instead of redirecting. */
  qrCodeUrl?: string;
  /** True when no credentials were configured and this was faked locally. */
  simulated: boolean;
}

export type PaymentEventType = "payment_succeeded" | "payment_failed" | "payment_expired" | "ignored";

export interface PaymentEvent {
  provider: PaymentProvider;
  /** Provider's event id. Used to drop redeliveries. */
  eventId: string;
  type: PaymentEventType;
  providerPaymentId: string;
  /** Our order id, when the provider echoes back the metadata we sent. */
  orderId?: string;
  amountSen?: number;
  currency?: string;
  occurredAt: string;
}

export type WebhookVerification =
  | { valid: true; event: PaymentEvent }
  | { valid: false; reason: string };

/** What the picker needs to render a method without hardcoding provider names. */
export interface PaymentMethodOption {
  method: PaymentMethod;
  provider: PaymentProvider;
  label: string;
  description: string;
  /** e.g. ["Visa", "Mastercard"] or ["DuitNow", "Touch 'n Go", "GrabPay"] */
  brands: string[];
  available: boolean;
  /** True when this will be faked because credentials are missing. */
  simulated: boolean;
}

export interface PaymentAdapter {
  readonly provider: PaymentProvider;
  /** Which rails this adapter can serve. */
  readonly methods: readonly PaymentMethod[];
  readonly displayName: string;
  readonly brands: string[];

  /** False when credentials are missing or still placeholders. */
  isConfigured(): boolean;

  createPayment(request: CreatePaymentRequest): Promise<PaymentSession>;

  /**
   * Verifies the signature over the *raw* body and parses the event.
   *
   * Takes the raw bytes, not a parsed object: re-serialising JSON changes key
   * order and whitespace, which breaks every signature scheme there is.
   */
  verifyAndParseWebhook(rawBody: string, headers: WebhookHeaders): WebhookVerification;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Raised for provider-side failures — network, credentials, a rejected request. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly provider: PaymentProvider,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
