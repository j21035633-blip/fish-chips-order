import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import type { RevenueMonsterConfig, StripeConfig } from "../src/config/env.js";
import { createServer } from "../src/http/app.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { RevenueMonsterAdapter } from "../src/payments/revenueMonsterAdapter.js";
import { PaymentService } from "../src/payments/service.js";
import { hmacHex } from "../src/payments/simulation.js";
import { StripeAdapter } from "../src/payments/stripeAdapter.js";

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
const RM_WEBHOOK_SECRET = "rm_test_secret";
const BASE_URL = "http://localhost:3000";

/**
 * The webhook secrets are configured but the API keys are not, so payments are
 * simulated while signature verification is exercised for real — which is the
 * combination this end-to-end path needs.
 */
const stripeConfig: StripeConfig = {
  secretKey: undefined,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
  apiBase: "https://api.stripe.test",
};

const revenueMonsterConfig: RevenueMonsterConfig = {
  apiKey: undefined,
  clientId: undefined,
  clientSecret: undefined,
  webhookSecret: RM_WEBHOOK_SECRET,
  storeId: undefined,
  apiBase: "https://rm.test",
  privateKeyPath: undefined,
};

let server: Server;
let base: string;
let app: Services;

function buildServices(): Services {
  const carts = new CartService(new InMemoryCartRepository(), menuService);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
  const payments = new PaymentService(
    orders,
    [new StripeAdapter(stripeConfig, BASE_URL), new RevenueMonsterAdapter(revenueMonsterConfig, BASE_URL)],
    BASE_URL,
  );
  return { carts, orders, payments, storage: { kind: "memory", ready: true, async connect() {}, async close() {} } };
}

beforeAll(async () => {
  app = buildServices();
  // The container is captured at construction, so rebuild the server per suite.
  server = createServer(app).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Walks the happy path up to a pending order. */
async function placeOrder(method: "card" | "ewallet" = "card") {
  const { cartId } = await json(await post("/api/carts"));

  await post(`/api/carts/${cartId}/lines`, {
    itemId: "chips-classic",
    quantity: 2,
    selections: [{ groupId: "size", choiceId: "large" }],
  });
  const { cart } = await json(await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" }));

  const { order } = await json(await post("/api/orders", { cartId, customerName: "Aisyah" }));
  const paid = await json(await post(`/api/orders/${order.id}/payment`, { method }));

  return { cartId, cart, order, payment: paid.payment as { providerPaymentId: string; simulated: boolean } };
}

function stripeSigned(body: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { "stripe-signature": `t=${timestamp},v1=${hmacHex(STRIPE_WEBHOOK_SECRET, `${timestamp}.${body}`)}` };
}

describe("checkout flow", async () => {
  it("reports phase 2 on health", async () => {
    await expect(json(await fetch(`${base}/health`))).resolves.toEqual({ ok: true, phase: 2, storage: "memory" });
  });

  it("builds a cart with a running total", async () => {
    const { cartId } = await json(await post("/api/carts"));

    const first = await json(
      await post(`/api/carts/${cartId}/lines`, { itemId: "chips-classic", quantity: 2 }),
    );
    expect(first.cart.subtotalSen).toBe(790 * 2);
    expect(first.text).toContain("Total: RM15.80");

    const second = await json(await post(`/api/carts/${cartId}/lines`, { itemId: "drink-teh-ais" }));
    expect(second.cart.itemCount).toBe(3);
    expect(second.cart.total).toBe("RM20.70");
  });

  it("prices options server-side, ignoring anything the client sends", async () => {
    const { cartId } = await json(await post("/api/carts"));
    const { cart } = await json(
      await post(`/api/carts/${cartId}/lines`, {
        itemId: "chips-classic",
        selections: [{ groupId: "size", choiceId: "large" }],
        unitPriceSen: 1,
        lineTotalSen: 1,
      }),
    );

    expect(cart.lines[0].unitPriceSen).toBe(790 + 400);
    expect(cart.subtotalSen).toBe(1190);
  });

  it("400s an invalid option choice with a code the UI can branch on", async () => {
    const { cartId } = await json(await post("/api/carts"));
    const res = await post(`/api/carts/${cartId}/lines`, {
      itemId: "chips-classic",
      selections: [{ groupId: "size", choiceId: "gigantic" }],
    });

    expect(res.status).toBe(400);
    await expect(json(res)).resolves.toMatchObject({ error: "unknown_option_choice" });
  });

  it("404s an unknown cart", async () => {
    const res = await fetch(`${base}/api/carts/nope`);
    expect(res.status).toBe(404);
    await expect(json(res)).resolves.toMatchObject({ error: "unknown_cart" });
  });

  it("updates and removes cart lines", async () => {
    const { cartId } = await json(await post("/api/carts"));
    const { cart } = await json(await post(`/api/carts/${cartId}/lines`, { itemId: "chips-classic" }));
    const lineId = cart.lines[0].lineId;

    const patched = await fetch(`${base}/api/carts/${cartId}/lines/${lineId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 3 }),
    });
    await expect(json(patched)).resolves.toMatchObject({ cart: { itemCount: 3 } });

    const deleted = await fetch(`${base}/api/carts/${cartId}/lines/${lineId}`, { method: "DELETE" });
    await expect(json(deleted)).resolves.toMatchObject({ cart: { itemCount: 0 } });
  });

  it("confirms an order and empties the cart", async () => {
    const { cartId, order } = await placeOrder();

    expect(order.reference).toMatch(/^[A-Z]{2}-\d{4}$/);
    expect(order.paymentStatus).toBe("pending");
    expect(order.customerName).toBe("Aisyah");

    const { cart } = await json(await fetch(`${base}/api/carts/${cartId}`));
    expect(cart.lines).toHaveLength(0);
  });

  it("refuses to confirm an empty cart", async () => {
    const { cartId } = await json(await post("/api/carts"));
    const res = await post("/api/orders", { cartId });

    expect(res.status).toBe(400);
    await expect(json(res)).resolves.toMatchObject({ error: "empty_cart" });
  });

  it("offers both payment methods to the picker", async () => {
    const { methods } = await json(await fetch(`${base}/api/payments/methods`));

    expect(methods).toHaveLength(2);
    expect(methods.map((option: { method: string }) => option.method).sort()).toEqual(["card", "ewallet"]);
    expect(methods.find((option: { method: string }) => option.method === "card")).toMatchObject({
      provider: "stripe",
      label: "Card",
    });
    expect(methods.find((option: { method: string }) => option.method === "ewallet")).toMatchObject({
      provider: "revenue_monster",
    });
  });

  it("starts a card payment through Stripe", async () => {
    const { payment } = await placeOrder("card");
    expect(payment).toMatchObject({ provider: "stripe", method: "card" });
  });

  it("starts an e-wallet payment through Revenue Monster", async () => {
    const { payment } = await placeOrder("ewallet");
    expect(payment).toMatchObject({ provider: "revenue_monster", method: "ewallet" });
  });

  it("rejects an unknown payment method", async () => {
    const { order } = await placeOrder();
    const res = await post(`/api/orders/${order.id}/payment`, { method: "crypto" });
    expect(res.status).toBe(400);
  });

  it("moves pending → paid on a verified Stripe webhook", async () => {
    const { order, payment } = await placeOrder("card");

    const body = JSON.stringify({
      id: `evt_${order.id}`,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: payment.providerPaymentId,
          payment_status: "paid",
          amount_total: order.totalSen,
          currency: "myr",
          metadata: { order_id: order.id },
        },
      },
    });

    const res = await fetch(`${base}/api/payments/webhook/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", ...stripeSigned(body) },
      body,
    });

    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toMatchObject({ received: true, changed: true, paymentStatus: "paid" });

    const { order: after } = await json(await fetch(`${base}/api/orders/${order.id}`));
    expect(after.paymentStatus).toBe("paid");
    expect(after.payment.paidAt).toBeTruthy();
  });

  it("moves pending → paid on a verified Revenue Monster callback", async () => {
    const { order, payment } = await placeOrder("ewallet");

    const body = JSON.stringify({
      eventId: `rm_${order.id}`,
      eventType: "PAYMENT",
      data: {
        checkoutId: payment.providerPaymentId,
        status: "SUCCESS",
        amount: order.totalSen,
        currencyType: "MYR",
        metadata: { orderId: order.id },
      },
    });

    const res = await fetch(`${base}/api/payments/webhook/revenue_monster`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": hmacHex(RM_WEBHOOK_SECRET, body) },
      body,
    });

    expect(res.status).toBe(200);
    const { order: after } = await json(await fetch(`${base}/api/orders/${order.id}`));
    expect(after.paymentStatus).toBe("paid");
  });

  it("leaves the order pending when the signature does not verify", async () => {
    const { order, payment } = await placeOrder("card");

    const body = JSON.stringify({
      id: `evt_forged_${order.id}`,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: payment.providerPaymentId, payment_status: "paid", metadata: { order_id: order.id } },
      },
    });

    const res = await fetch(`${base}/api/payments/webhook/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=forged" },
      body,
    });

    expect(res.status).toBe(400);
    const { order: after } = await json(await fetch(`${base}/api/orders/${order.id}`));
    expect(after.paymentStatus).toBe("pending");
  });

  it("ignores a webhook whose amount does not match the order", async () => {
    const { order, payment } = await placeOrder("card");

    const body = JSON.stringify({
      id: `evt_amount_${order.id}`,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: payment.providerPaymentId,
          payment_status: "paid",
          amount_total: 1,
          metadata: { order_id: order.id },
        },
      },
    });

    const res = await fetch(`${base}/api/payments/webhook/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", ...stripeSigned(body) },
      body,
    });

    expect(res.status).toBe(400);
    const { order: after } = await json(await fetch(`${base}/api/orders/${order.id}`));
    expect(after.paymentStatus).toBe("pending");
  });

  it("404s an unknown webhook provider", async () => {
    const res = await post("/api/payments/webhook/paypal", {});
    expect(res.status).toBe(404);
  });

  it("settles a simulated payment through the dev route", async () => {
    const { order } = await placeOrder("card");

    const res = await post(`/api/payments/simulate/${order.id}`);
    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toMatchObject({ paymentStatus: "paid" });
  });

  it("exposes the cart and order tools over the tool endpoint", async () => {
    const { cartId } = await json(await post("/api/tools/create_cart"));
    const added = await json(await post("/api/tools/add_to_cart", { cartId, itemId: "combo-classic" }));

    expect(added.cart.total).toBe("RM24.90");

    const confirmed = await json(await post("/api/tools/confirm_order", { cartId }));
    expect(confirmed.order.paymentStatus).toBe("pending");

    const started = await json(
      await post("/api/tools/start_payment", { orderId: confirmed.order.id, method: "ewallet" }),
    );
    expect(started.payment.provider).toBe("revenue_monster");
    expect(started.text).toContain("Pay here:");
  });

  it("serves the customer web page", async () => {
    for (const path of ["/", "/checkout", "/order/anything"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      await expect(res.text()).resolves.toContain("Anchor &amp; Batter");
    }
  });

  it("serves the page assets", async () => {
    await expect((await fetch(`${base}/app.js`)).status).toBe(200);
    await expect((await fetch(`${base}/styles.css`)).status).toBe(200);
  });
});

describe("isolation", async () => {
  // Guards the container wiring: OrderService and the HTTP layer must share one
  // CartService, or confirming an order would not clear the browser's cart.
  beforeEach(() => {
    app = app ?? buildServices();
  });

  it("shares one cart service between the order service and the routes", async () => {
    const { cartId } = await json(await post("/api/carts"));
    await post(`/api/carts/${cartId}/lines`, { itemId: "chips-classic" });
    await post("/api/orders", { cartId });

    expect((await app.carts.price(cartId)).lines).toHaveLength(0);
  });
});
