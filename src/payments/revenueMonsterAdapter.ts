import { isPlaceholder, type RevenueMonsterConfig } from "../config/env.js";
import type { PaymentMethod } from "../orders/types.js";
import {
  loadPrivateKey,
  newNonce,
  nowTimestamp,
  signRequest,
  type SignatureInput,
} from "./revenueMonsterSigning.js";
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

/** Refresh the token slightly early so a request never races its expiry. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * E-wallet and QR payments via Revenue Monster — DuitNow, Touch 'n Go, GrabPay,
 * Boost, ShopeePay and the rest of the Malaysian rails behind one hosted page.
 *
 * Same contract as `StripeAdapter`; nothing above `PaymentAdapter` knows which
 * of the two it is talking to.
 *
 * NOTE: written against Revenue Monster's documented v3 Open API but not yet
 * exercised against a live sandbox account — no credentials were available when
 * this was built. Two things to confirm before going live, both isolated below:
 *   1. RSA request signing is implemented in `revenueMonsterSigning.ts` and
 *      switches on as soon as REVENUE_MONSTER_PRIVATE_KEY_PATH points at a key.
 *      If RM rejects a signature, diff `buildSignaturePlaintext` against their
 *      debugger — the canonical plaintext is the only part that can drift.
 *   2. Webhook verification here assumes HMAC-SHA256 over the raw body against
 *      REVENUE_MONSTER_WEBHOOK_SECRET, carried in `x-signature`. If the account
 *      is configured for RSA callback signatures instead, only
 *      `verifyAndParseWebhook` changes.
 */
export class RevenueMonsterAdapter implements PaymentAdapter {
  readonly provider = "revenue_monster" as const;
  readonly methods = ["ewallet"] as const satisfies readonly PaymentMethod[];
  readonly displayName = "E-wallet / QR";
  readonly brands = ["DuitNow", "Touch 'n Go", "GrabPay", "Boost", "ShopeePay"];

  private token: CachedToken | undefined;

  constructor(
    private readonly config: RevenueMonsterConfig,
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return (
      !isPlaceholder(this.config.clientId) &&
      !isPlaceholder(this.config.clientSecret) &&
      !isPlaceholder(this.config.storeId)
    );
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentSession> {
    if (!this.isConfigured()) {
      return simulatedSession(this.provider, request.order, this.publicBaseUrl);
    }

    const accessToken = await this.accessToken();
    const requestUrl = `${this.config.apiBase}/v3/payment/online`;

    const payload = {
      order: {
        id: request.order.reference,
        title: `Order ${request.order.reference}`,
        detail: summarise(request.order.lines),
        // RM takes the smallest currency unit, same as our sen.
        amount: request.order.totalSen,
        currencyType: "MYR",
      },
      storeId: this.config.storeId,
      redirectUrl: request.returnUrl,
      notifyUrl: `${this.publicBaseUrl}/api/payments/webhook/revenue_monster`,
      layoutVersion: "v3",
      type: "WEB_PAYMENT",
      // Echoed back on the callback so we can find the order without a lookup table.
      metadata: { orderId: request.order.id, orderReference: request.order.reference },
    };

    const response = await this.fetchImpl(requestUrl, {
      method: "POST",
      headers: this.signedHeaders(accessToken, request.idempotencyKey, {
        method: "POST",
        requestUrl,
        body: payload,
      }),
      // Signed and sent must be the same object; the signature canonicalises it.
      body: JSON.stringify(payload),
    });

    const result = (await response.json().catch(() => ({}))) as {
      item?: { checkoutId?: string; url?: string; qrCodeUrl?: string };
      error?: { message?: string; code?: string };
    };

    const checkoutId = result.item?.checkoutId;
    if (!response.ok || !checkoutId) {
      throw new PaymentProviderError(
        result.error?.message ?? `Revenue Monster rejected the payment (${response.status}).`,
        this.provider,
        response.status,
        result,
      );
    }

    const session: PaymentSession = {
      provider: this.provider,
      providerPaymentId: checkoutId,
      status: "pending",
      simulated: false,
    };
    if (result.item?.url !== undefined) session.checkoutUrl = result.item.url;
    if (result.item?.qrCodeUrl !== undefined) session.qrCodeUrl = result.item.qrCodeUrl;
    return session;
  }

  /**
   * OAuth2 client-credentials token, cached until just before it expires.
   */
  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - TOKEN_EXPIRY_SKEW_SECONDS > now) {
      return this.token.accessToken;
    }

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.config.apiBase}/v1/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
      body: JSON.stringify({ grantType: "client_credentials" }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      accessToken?: string;
      expiresIn?: number;
      error?: { message?: string };
    };

    if (!response.ok || !payload.accessToken) {
      throw new PaymentProviderError(
        payload.error?.message ?? `Revenue Monster token request failed (${response.status}).`,
        this.provider,
        response.status,
        payload,
      );
    }

    this.token = {
      accessToken: payload.accessToken,
      expiresAt: now + (payload.expiresIn ?? 3600),
    };
    return this.token.accessToken;
  }

  /**
   * Request headers, including RM's RSA signature when a private key is configured.
   *
   * Signing is driven entirely by REVENUE_MONSTER_PRIVATE_KEY_PATH: drop a real
   * key in and every v3 call is signed from the next request onward, with no
   * other change. Without a key the call goes out unsigned — workable locally,
   * rejected by RM in production.
   */
  private signedHeaders(
    accessToken: string,
    idempotencyKey: string,
    signing: { method: string; requestUrl: string; body?: unknown },
  ): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    };
    if (!isPlaceholder(this.config.apiKey) && this.config.apiKey !== undefined) {
      headers["x-api-key"] = this.config.apiKey;
    }

    const keyPath = this.config.privateKeyPath;
    if (isPlaceholder(keyPath) || keyPath === undefined) return headers;

    const input: SignatureInput = {
      method: signing.method,
      requestUrl: signing.requestUrl,
      nonceStr: newNonce(),
      timestamp: nowTimestamp(),
    };
    // Only set `body` when there is one: its presence decides whether the
    // signed plaintext carries a `data=` segment at all.
    if (signing.body !== undefined) input.body = signing.body;

    try {
      return { ...headers, ...signRequest(loadPrivateKey(keyPath), input) };
    } catch (error) {
      // A configured-but-broken key is a deployment fault, not a customer one.
      // Failing loudly beats sending an unsigned request RM will reject anyway.
      throw new PaymentProviderError(
        error instanceof Error ? error.message : "could not sign the request",
        this.provider,
      );
    }
  }

  verifyAndParseWebhook(rawBody: string, headers: WebhookHeaders): WebhookVerification {
    const secret = this.config.webhookSecret;
    if (isPlaceholder(secret) || secret === undefined) {
      return { valid: false, reason: "REVENUE_MONSTER_WEBHOOK_SECRET is not configured" };
    }

    const signature = headerValue(headers, "x-signature");
    if (!signature) return { valid: false, reason: "missing x-signature header" };

    const expected = hmacHex(secret, rawBody);
    if (!timingSafeEqualHex(signature.trim().toLowerCase(), expected)) {
      return { valid: false, reason: "signature mismatch" };
    }

    try {
      return { valid: true, event: parseRevenueMonsterEvent(rawBody) };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "unparseable event" };
    }
  }
}

interface RevenueMonsterCallbackShape {
  eventId?: string;
  eventType?: string;
  data?: {
    checkoutId?: string;
    transactionId?: string;
    status?: string;
    amount?: number;
    currencyType?: string;
    createdAt?: string;
    metadata?: Record<string, string>;
  };
}

function parseRevenueMonsterEvent(rawBody: string): PaymentEvent {
  const parsed = JSON.parse(rawBody) as RevenueMonsterCallbackShape;
  const data = parsed.data;

  const providerPaymentId = data?.checkoutId ?? data?.transactionId;
  if (!providerPaymentId) {
    throw new Error("callback missing checkoutId");
  }

  const event: PaymentEvent = {
    provider: "revenue_monster",
    // RM does not always send an event id; the transaction id is stable enough to dedupe on.
    eventId: parsed.eventId ?? `rm_${providerPaymentId}_${data?.status ?? "unknown"}`,
    type: revenueMonsterEventType(parsed.eventType, data?.status),
    providerPaymentId,
    occurredAt: data?.createdAt ?? new Date().toISOString(),
  };

  const orderId = data?.metadata?.orderId;
  if (orderId !== undefined) event.orderId = orderId;
  if (data?.amount !== undefined) event.amountSen = data.amount;
  if (data?.currencyType !== undefined) event.currency = data.currencyType.toUpperCase();

  return event;
}

function revenueMonsterEventType(eventType: string | undefined, status: string | undefined): PaymentEvent["type"] {
  const normalised = (status ?? eventType ?? "").toUpperCase();
  if (normalised.includes("SUCCESS") || normalised === "PAID") return "payment_succeeded";
  if (normalised.includes("FAIL") || normalised.includes("CANCEL")) return "payment_failed";
  if (normalised.includes("EXPIRE")) return "payment_expired";
  return "ignored";
}

function summarise(lines: { name: string; quantity: number }[]): string {
  return lines.map((line) => `${line.quantity}x ${line.name}`).join(", ").slice(0, 200);
}
