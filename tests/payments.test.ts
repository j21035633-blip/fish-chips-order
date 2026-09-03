import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RevenueMonsterConfig, StripeConfig } from "../src/config/env.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError, type Order } from "../src/orders/types.js";
import { RevenueMonsterAdapter } from "../src/payments/revenueMonsterAdapter.js";
import { PaymentService } from "../src/payments/service.js";
import { hmacHex } from "../src/payments/simulation.js";
import { StripeAdapter } from "../src/payments/stripeAdapter.js";

const BASE_URL = "http://localhost:3000";
const STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
const RM_WEBHOOK_SECRET = "rm_test_secret";

const liveStripe: StripeConfig = {
  secretKey: "sk_test_live",
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  apiBase: "https://api.stripe.test",
};

const unconfiguredStripe: StripeConfig = {
  secretKey: undefined,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  apiBase: "https://api.stripe.test",
};

const liveRevenueMonster: RevenueMonsterConfig = {
  apiKey: "rm_api_key",
  clientId: "rm_client",
  clientSecret: "rm_secret",
  webhookSecret: RM_WEBHOOK_SECRET,
  storeId: "store_1",
  apiBase: "https://rm.test",
  privateKeyPath: undefined,
};

const unconfiguredRevenueMonster: RevenueMonsterConfig = {
  ...liveRevenueMonster,
  clientId: undefined,
  clientSecret: undefined,
  storeId: undefined,
};

let carts: CartService;
let orders: OrderService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
});

function anOrder(): Order {
  const cart = carts.create();
  carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stripeSignature(rawBody: string, secret = STRIPE_WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

function stripeEvent(order: Order, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        amount_total: order.totalSen,
        currency: "myr",
        metadata: { order_id: order.id },
        ...overrides,
      },
    },
  });
}

// ---------------------------------------------------------------- adapters

describe("StripeAdapter", () => {
  it("reports itself unconfigured without a secret key", () => {
    expect(new StripeAdapter(unconfiguredStripe, BASE_URL).isConfigured()).toBe(false);
    expect(new StripeAdapter(liveStripe, BASE_URL).isConfigured()).toBe(true);
  });

  it("treats a placeholder key as unconfigured", () => {
    const adapter = new StripeAdapter({ ...liveStripe, secretKey: "sk_test_xxx" }, BASE_URL);
    expect(adapter.isConfigured()).toBe(false);
  });

  it("falls back to a simulated session with no key, without calling out", async () => {
    const fetchImpl = vi.fn();
    const adapter = new StripeAdapter(unconfiguredStripe, BASE_URL, fetchImpl as unknown as typeof fetch);

    const session = await adapter.createPayment(request(anOrder()));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(session.simulated).toBe(true);
    expect(session.providerPaymentId).toMatch(/^sim_stripe_/);
    expect(session.checkoutUrl).toContain("/simulated-checkout");
  });

  it("creates a checkout session with our own line prices", async () => {
    const order = anOrder();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "cs_test_1", url: "https://pay.stripe/x" }));
    const adapter = new StripeAdapter(liveStripe, BASE_URL, fetchImpl as unknown as typeof fetch);

    const session = await adapter.createPayment(request(order));

    expect(session).toMatchObject({
      provider: "stripe",
      providerPaymentId: "cs_test_1",
      checkoutUrl: "https://pay.stripe/x",
      simulated: false,
      status: "pending",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.test/v1/checkout/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_live");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();

    const body = new URLSearchParams(init.body as string);
    expect(body.get("mode")).toBe("payment");
    expect(body.get("metadata[order_id]")).toBe(order.id);
    expect(body.get("line_items[0][price_data][currency]")).toBe("myr");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe(String(order.lines[0]!.unitPriceSen));
  });

  it("surfaces a provider rejection", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "No such price" } }, 400));
    const adapter = new StripeAdapter(liveStripe, BASE_URL, fetchImpl as unknown as typeof fetch);

    await expect(adapter.createPayment(request(anOrder()))).rejects.toThrow("No such price");
  });

  // Stripe answering with `"url": null` used to be stored as a checkout URL,
  // which reads as a usable link everywhere downstream.
  it("stores no checkout URL when the session comes back without one", async () => {
    for (const body of [{ id: "cs_test_1" }, { id: "cs_test_1", url: null }]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
      const adapter = new StripeAdapter(liveStripe, BASE_URL, fetchImpl as unknown as typeof fetch);

      const session = await adapter.createPayment(request(anOrder()));

      expect(session.providerPaymentId).toBe("cs_test_1");
      expect(session.checkoutUrl).toBeUndefined();
    }
  });

  it("accepts a correctly signed webhook", () => {
    const order = anOrder();
    const body = stripeEvent(order);
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    const result = adapter.verifyAndParseWebhook(body, { "stripe-signature": stripeSignature(body) });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.event.type).toBe("payment_succeeded");
    expect(result.event.orderId).toBe(order.id);
    expect(result.event.amountSen).toBe(order.totalSen);
  });

  it("rejects a tampered body", () => {
    const order = anOrder();
    const body = stripeEvent(order);
    const signature = stripeSignature(body);
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    const tampered = body.replace(String(order.totalSen), "1");
    const result = adapter.verifyAndParseWebhook(tampered, { "stripe-signature": signature });

    expect(result).toEqual({ valid: false, reason: "signature mismatch" });
  });

  it("rejects a signature from the wrong secret", () => {
    const body = stripeEvent(anOrder());
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    const result = adapter.verifyAndParseWebhook(body, {
      "stripe-signature": stripeSignature(body, "whsec_attacker"),
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a replayed old signature", () => {
    const body = stripeEvent(anOrder());
    const stale = Math.floor(Date.now() / 1000) - 600;
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    const result = adapter.verifyAndParseWebhook(body, {
      "stripe-signature": stripeSignature(body, STRIPE_WEBHOOK_SECRET, stale),
    });
    expect(result).toEqual({ valid: false, reason: "signature timestamp outside tolerance" });
  });

  it("rejects a missing or malformed signature header", () => {
    const body = stripeEvent(anOrder());
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    expect(adapter.verifyAndParseWebhook(body, {}).valid).toBe(false);
    expect(adapter.verifyAndParseWebhook(body, { "stripe-signature": "garbage" }).valid).toBe(false);
  });

  it("maps event types", () => {
    const order = anOrder();
    const adapter = new StripeAdapter(liveStripe, BASE_URL);

    const check = (raw: string) => {
      const result = adapter.verifyAndParseWebhook(raw, { "stripe-signature": stripeSignature(raw) });
      return result.valid ? result.event.type : "invalid";
    };

    expect(check(stripeEvent(order))).toBe("payment_succeeded");
    expect(check(stripeEvent(order, { payment_status: "unpaid" }))).toBe("ignored");
    expect(
      check(JSON.stringify({ id: "evt_2", type: "checkout.session.expired", data: { object: { id: "cs_1" } } })),
    ).toBe("payment_expired");
    expect(
      check(
        JSON.stringify({ id: "evt_3", type: "payment_intent.payment_failed", data: { object: { id: "pi_1" } } }),
      ),
    ).toBe("payment_failed");
    expect(
      check(JSON.stringify({ id: "evt_4", type: "customer.created", data: { object: { id: "cus_1" } } })),
    ).toBe("ignored");
  });
});

describe("RevenueMonsterAdapter", () => {
  it("simulates when credentials are missing", async () => {
    const fetchImpl = vi.fn();
    const adapter = new RevenueMonsterAdapter(
      unconfiguredRevenueMonster,
      BASE_URL,
      fetchImpl as unknown as typeof fetch,
    );

    const session = await adapter.createPayment(request(anOrder(), "ewallet"));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(session.simulated).toBe(true);
    // The e-wallet rail shows a code rather than redirecting.
    expect(session.qrCodeUrl).toBeTruthy();
  });

  it("fetches a token then creates the payment", async () => {
    const order = anOrder();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: "tok_1", expiresIn: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse({ item: { checkoutId: "chk_1", url: "https://rm.pay/x", qrCodeUrl: "https://rm.pay/qr" } }),
      );

    const adapter = new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL, fetchImpl as unknown as typeof fetch);
    const session = await adapter.createPayment(request(order, "ewallet"));

    expect(session).toMatchObject({
      provider: "revenue_monster",
      providerPaymentId: "chk_1",
      checkoutUrl: "https://rm.pay/x",
      qrCodeUrl: "https://rm.pay/qr",
      simulated: false,
    });

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://rm.test/v1/token");
    expect((tokenInit.headers as Record<string, string>).authorization).toMatch(/^Basic /);

    const [payUrl, payInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(payUrl).toBe("https://rm.test/v3/payment/online");
    const payload = JSON.parse(payInit.body as string);
    expect(payload.order.amount).toBe(order.totalSen);
    expect(payload.order.currencyType).toBe("MYR");
    expect(payload.metadata.orderId).toBe(order.id);
    expect(payload.notifyUrl).toContain("/api/payments/webhook/revenue_monster");
  });

  it("reuses a cached token across payments", async () => {
    // A fresh Response per call — a body can only be read once.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accessToken: "tok_1", expiresIn: 3600 }))
      .mockImplementation(async () => jsonResponse({ item: { checkoutId: "chk_n" } }));

    const adapter = new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL, fetchImpl as unknown as typeof fetch);
    await adapter.createPayment(request(anOrder(), "ewallet"));
    await adapter.createPayment(request(anOrder(), "ewallet"));

    const tokenCalls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/v1/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("verifies an HMAC-signed callback", () => {
    const order = anOrder();
    const body = JSON.stringify({
      eventId: "rm_evt_1",
      eventType: "PAYMENT",
      data: { checkoutId: "chk_1", status: "SUCCESS", amount: order.totalSen, metadata: { orderId: order.id } },
    });

    const adapter = new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL);
    const result = adapter.verifyAndParseWebhook(body, {
      "x-signature": hmacHex(RM_WEBHOOK_SECRET, body),
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.event.type).toBe("payment_succeeded");
    expect(result.event.orderId).toBe(order.id);
  });

  it("rejects a bad callback signature", () => {
    const body = JSON.stringify({ data: { checkoutId: "chk_1", status: "SUCCESS" } });
    const adapter = new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL);

    expect(adapter.verifyAndParseWebhook(body, { "x-signature": "deadbeef" }).valid).toBe(false);
    expect(adapter.verifyAndParseWebhook(body, {}).valid).toBe(false);
  });

  it("maps failure and expiry statuses", () => {
    const adapter = new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL);
    const check = (status: string) => {
      const body = JSON.stringify({ data: { checkoutId: "chk_1", status } });
      const result = adapter.verifyAndParseWebhook(body, { "x-signature": hmacHex(RM_WEBHOOK_SECRET, body) });
      return result.valid ? result.event.type : "invalid";
    };

    expect(check("SUCCESS")).toBe("payment_succeeded");
    expect(check("FAILED")).toBe("payment_failed");
    expect(check("CANCELLED")).toBe("payment_failed");
    expect(check("EXPIRED")).toBe("payment_expired");
    expect(check("PENDING")).toBe("ignored");
  });
});

// --------------------------------------------------------- payment service

describe("PaymentService", () => {
  function simulatedService() {
    return new PaymentService(
      orders,
      [
        new StripeAdapter(unconfiguredStripe, BASE_URL),
        new RevenueMonsterAdapter(unconfiguredRevenueMonster, BASE_URL),
      ],
      BASE_URL,
    );
  }

  function liveService() {
    return new PaymentService(
      orders,
      [new StripeAdapter(liveStripe, BASE_URL), new RevenueMonsterAdapter(liveRevenueMonster, BASE_URL)],
      BASE_URL,
    );
  }

  it("offers both rails to the picker", () => {
    const methods = simulatedService().availableMethods();

    expect(methods.map((option) => option.method).sort()).toEqual(["card", "ewallet"]);
    expect(methods.find((option) => option.method === "card")?.provider).toBe("stripe");
    expect(methods.find((option) => option.method === "ewallet")?.provider).toBe("revenue_monster");
    expect(methods.every((option) => option.simulated)).toBe(true);
  });

  it("logs when a live provider returns a session the customer cannot pay from", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "cs_test_1", url: null }));
    const payments = new PaymentService(
      orders,
      [new StripeAdapter(liveStripe, BASE_URL, fetchImpl as unknown as typeof fetch)],
      BASE_URL,
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const order = anOrder();

    const updated = await payments.initiate(order.id, "card");

    // The attempt is still recorded — the webhook may yet settle it — but there
    // is nowhere to send the customer, and the log says so.
    expect(updated.payment?.providerPaymentId).toBe("cs_test_1");
    expect(updated.payment?.checkoutUrl).toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("no checkout URL"));
    expect(logged.mock.calls[0]?.[0]).toContain(order.reference);
    logged.mockRestore();
  });

  it("routes each method to its provider", () => {
    const payments = simulatedService();
    expect(payments.adapterFor("card").provider).toBe("stripe");
    expect(payments.adapterFor("ewallet").provider).toBe("revenue_monster");
  });

  it("attaches the payment attempt to the order", async () => {
    const payments = simulatedService();
    const order = anOrder();

    const updated = await payments.initiate(order.id, "ewallet");

    expect(updated.payment?.provider).toBe("revenue_monster");
    expect(updated.payment?.method).toBe("ewallet");
    expect(updated.paymentStatus).toBe("pending");
  });

  it("moves the order to paid on a verified webhook", () => {
    const payments = liveService();
    const order = anOrder();
    orders.attachPayment(order.id, {
      method: "card",
      provider: "stripe",
      providerPaymentId: "cs_test_1",
      status: "pending",
      simulated: false,
      createdAt: new Date().toISOString(),
    });

    const body = stripeEvent(order);
    const outcome = payments.handleWebhook("stripe", body, { "stripe-signature": stripeSignature(body) });

    expect(outcome.handled).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(orders.get(order.id).paymentStatus).toBe("paid");
  });

  it("treats a redelivered webhook as a no-op", () => {
    const payments = liveService();
    const order = anOrder();
    const body = stripeEvent(order);
    const headers = { "stripe-signature": stripeSignature(body) };

    expect(payments.handleWebhook("stripe", body, headers).changed).toBe(true);
    const second = payments.handleWebhook("stripe", body, headers);

    expect(second.handled).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe("duplicate event");
  });

  it("refuses an unverified webhook and leaves the order pending", () => {
    const payments = liveService();
    const order = anOrder();
    const body = stripeEvent(order);

    const outcome = payments.handleWebhook("stripe", body, { "stripe-signature": "t=1,v1=bad" });

    expect(outcome.handled).toBe(false);
    expect(orders.get(order.id).paymentStatus).toBe("pending");
  });

  it("refuses to settle when the amount does not match the order", () => {
    const payments = liveService();
    const order = anOrder();
    const body = stripeEvent(order, { amount_total: 1 });

    const outcome = payments.handleWebhook("stripe", body, { "stripe-signature": stripeSignature(body) });

    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toContain("amount mismatch");
    expect(orders.get(order.id).paymentStatus).toBe("pending");
  });

  it("does not mark an unmatched event as seen, so a retry can still land", () => {
    const payments = liveService();
    const body = JSON.stringify({
      id: "evt_orphan",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_unknown", payment_status: "paid" } },
    });
    const headers = { "stripe-signature": stripeSignature(body) };

    expect(payments.handleWebhook("stripe", body, headers).reason).toBe("no matching order");
    // Same event again still gets a real attempt rather than "duplicate".
    expect(payments.handleWebhook("stripe", body, headers).reason).toBe("no matching order");
  });

  it("marks an order failed on a failure event", () => {
    const payments = liveService();
    const order = anOrder();
    orders.attachPayment(order.id, {
      method: "card",
      provider: "stripe",
      providerPaymentId: "cs_test_1",
      status: "pending",
      simulated: false,
      createdAt: new Date().toISOString(),
    });

    const body = JSON.stringify({
      id: "evt_fail",
      type: "checkout.session.expired",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test_1", metadata: { order_id: order.id } } },
    });

    payments.handleWebhook("stripe", body, { "stripe-signature": stripeSignature(body) });
    expect(orders.get(order.id).paymentStatus).toBe("failed");
  });

  it("settles a simulated payment locally", async () => {
    const payments = simulatedService();
    const order = await payments.initiate(anOrder().id, "card");

    expect(payments.settleSimulated(order.id).paymentStatus).toBe("paid");
  });

  it("refuses to settle an order that has no payment attempt", () => {
    const payments = simulatedService();
    expect(() => payments.settleSimulated(anOrder().id)).toThrow(OrderValidationError);
  });

  it("disables simulated settlement once real credentials exist", async () => {
    // Start the payment while unconfigured, then bring the provider online.
    const simulated = simulatedService();
    const order = await simulated.initiate(anOrder().id, "card");

    const live = liveService();
    try {
      live.settleSimulated(order.id);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as OrderValidationError).code).toBe("simulation_disabled");
    }
    expect(orders.get(order.id).paymentStatus).toBe("pending");
  });

  it("ignores an unknown provider", () => {
    const outcome = simulatedService().handleWebhook(
      "paypal" as never,
      "{}",
      {},
    );
    expect(outcome.handled).toBe(false);
  });
});

function request(order: Order, method: "card" | "ewallet" = "card") {
  return {
    order,
    method,
    returnUrl: `${BASE_URL}/order/${order.id}`,
    cancelUrl: `${BASE_URL}/order/${order.id}?cancelled=1`,
    idempotencyKey: `${order.id}:test`,
  };
}
