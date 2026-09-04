import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import type { RevenueMonsterConfig, StripeConfig } from "../src/config/env.js";
import { createServer } from "../src/http/app.js";
import { MenuService } from "../src/menu/service.js";
import { MenuStore } from "../src/menu/store.js";
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
  // Its own store, so a menu edit in one suite cannot leak into another.
  const menuStore = new MenuStore();
  const menu = new MenuService(menuStore);
  const carts = new CartService(new InMemoryCartRepository(), menu);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menu);
  const payments = new PaymentService(
    orders,
    [new StripeAdapter(stripeConfig, BASE_URL), new RevenueMonsterAdapter(revenueMonsterConfig, BASE_URL)],
    BASE_URL,
  );
  return {
    carts,
    orders,
    payments,
    menu,
    menuStore,
    storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} } as const,
  };
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
  return send("POST", path, body);
}

async function patch(path: string, body?: unknown): Promise<Response> {
  return send("PATCH", path, body);
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Opens a cart, optionally for a table, and returns its id. */
async function openCart(body?: { table?: string }): Promise<string> {
  const { cartId } = await json(await post("/api/carts", body ?? {}));
  return cartId as string;
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
    await expect(json(await fetch(`${base}/health`))).resolves.toEqual({
      ok: true,
      phase: 2,
      storage: "memory",
      indexes: "ready",
      // No STAFF_PASSWORD in the test environment, so the gate is off and says so.
      staffAuth: "disabled",
    });
  });

  it("builds a cart with a running total", async () => {
    const { cartId } = await json(await post("/api/carts"));

    const first = await json(
      await post(`/api/carts/${cartId}/lines`, { itemId: "chips-classic", quantity: 2 }),
    );
    expect(first.cart.subtotalSen).toBe(790 * 2);
    expect(first.text).toContain("Subtotal: RM15.80");
    expect(first.text).toContain("Tax (10%): RM1.58");
    expect(first.text).toContain("Total: RM17.38");

    const second = await json(await post(`/api/carts/${cartId}/lines`, { itemId: "drink-teh-ais" }));
    expect(second.cart.itemCount).toBe(3);
    expect(second.cart.subtotal).toBe("RM20.70");
    expect(second.cart.total).toBe("RM22.77");
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

    expect(added.cart.subtotal).toBe("RM24.90");
    expect(added.cart.total).toBe("RM27.39");

    const confirmed = await json(await post("/api/tools/confirm_order", { cartId }));
    expect(confirmed.order.paymentStatus).toBe("pending");

    const started = await json(
      await post("/api/tools/start_payment", { orderId: confirmed.order.id, method: "ewallet" }),
    );
    expect(started.payment.provider).toBe("revenue_monster");
    expect(started.text).toContain("Pay here:");
  });

  it("serves the customer web page", async () => {
    // "/order" is the QR landing page; "/order/:id" is a placed order. Both
    // are client-rendered from the same document.
    for (const path of ["/", "/checkout", "/order", "/order?table=5", "/order/anything"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      await expect(res.text()).resolves.toContain("Anchor &amp; Batter");
    }
  });

  it("opens a cart for a table, and refuses a malformed one", async () => {
    const opened = await post("/api/carts", { table: "a3" });
    expect(opened.status).toBe(200);
    const { cartId, tableNumber } = (await opened.json()) as { cartId: string; tableNumber: string };
    expect(tableNumber).toBe("A3");

    const read = await fetch(`${base}/api/carts/${cartId}`);
    await expect(read.json()).resolves.toMatchObject({ cart: { tableNumber: "A3" } });

    const bad = await post("/api/carts", { table: "../admin" });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: "invalid_table_number" });
  });

  it("serves every staff view only under the staff path", async () => {
    for (const [path, marker] of [
      ["/staff", "Dashboard — Anchor &amp; Batter"],
      ["/staff/kitchen", "Kitchen &amp; counter — Anchor &amp; Batter"],
      ["/staff/sales", "Sales report — Anchor &amp; Batter"],
      ["/staff/menu", "Menu — Anchor &amp; Batter"],
    ]) {
      const page = await fetch(`${base}${path}`);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");

      const html = await page.text();
      expect(html, path).toContain(marker);
      // The mount path is substituted in, so nothing is left pointing nowhere.
      expect(html, path).not.toContain("{{STAFF_BASE}}");
      expect(html, path).toContain(`href="/staff/assets/staff.css"`);
    }

    // They live outside the customer web root, so express.static cannot serve
    // them under their own filenames and the configurable path means something.
    for (const path of ["/staff.html", "/staff-web/staff.html", "/kitchen.html", "/sales.html", "/menu.html"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
  });

  it("serves the shared staff assets under the staff path and nowhere else", async () => {
    for (const file of ["staff.css", "nav.js", "common.js"]) {
      const asset = await fetch(`${base}/staff/assets/${file}`);
      expect(asset.status, file).toBe(200);
      expect((await fetch(`${base}/assets/${file}`)).status, file).toBe(404);
    }

    // The nav is defined once, in the shared file the three pages import.
    await expect((await fetch(`${base}/staff/assets/nav.js`)).text()).resolves.toContain("Kitchen & Counter");
  });

  it("reports the board and the day's takings", async () => {
    const cartId = await openCart({ table: "6" });
    await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic", quantity: 2 });
    const placed = (await json(await post("/api/orders", { cartId }))) as { order: { id: string } };
    const orderId = placed.order.id;

    type Overview = {
      orders: { id: string; lines: unknown[]; subtotal: string; tax: string; total: string }[];
      sales: { count: number; timeZone: string };
    };
    const before = (await json(await fetch(`${base}/api/staff/overview`))) as Overview;
    expect(before.orders.some((order) => order.id === orderId)).toBe(true);
    const ticket = before.orders.find((order) => order.id === orderId)!;
    expect(ticket).toMatchObject({ tableNumber: "6", kitchenStatus: "received", paymentStatus: "pending" });
    expect(ticket.lines).toHaveLength(1);
    expect(ticket.subtotal).toBe("RM33.80");
    expect(ticket.total).toBe("RM37.18");

    // Pending orders are on the board but not in the takings.
    const countBefore = before.sales.count;

    await post(`/api/orders/${orderId}/payment`, { method: "card" });
    await post(`/api/payments/simulate/${orderId}`, {});

    const after = (await json(await fetch(`${base}/api/staff/overview`))) as Overview;
    expect(after.sales.count).toBe(countBefore + 1);
    expect(after.sales.timeZone).toBeTruthy();
  });

  it("advances an order across the board", async () => {
    const cartId = await openCart({ table: "7" });
    await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const placed = (await json(await post("/api/orders", { cartId }))) as { order: { id: string } };
    const orderId = placed.order.id;

    const cooking = await post(`/api/staff/orders/${orderId}/status`, { status: "cooking" });
    await expect(cooking.json()).resolves.toMatchObject({ order: { kitchenStatus: "cooking" }, changed: true });

    const ready = await post(`/api/staff/orders/${orderId}/status`, { status: "ready" });
    await expect(ready.json()).resolves.toMatchObject({ order: { kitchenStatus: "ready" } });

    const bad = await post(`/api/staff/orders/${orderId}/status`, { status: "incinerated" });
    expect(bad.status).toBe(400);

    const missing = await post("/api/staff/orders/nope/status", { status: "cooking" });
    expect(missing.status).toBe(404);
  });

  it("takes the same status change over PATCH, which is what the pages call", async () => {
    const cartId = await openCart({ table: "8" });
    await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const placed = (await json(await post("/api/orders", { cartId }))) as { order: { id: string } };
    const orderId = placed.order.id;

    for (const status of ["cooking", "ready", "collected"]) {
      const moved = await patch(`/api/staff/orders/${orderId}/status`, { status });
      expect(moved.status, status).toBe(200);
      await expect(moved.json()).resolves.toMatchObject({ order: { kitchenStatus: status }, changed: true });
    }

    // Collected leaves the pass, but the ticket is still today's trade.
    const overview = (await json(await fetch(`${base}/api/staff/overview`))) as {
      orders: { id: string; kitchenStatus: string }[];
    };
    expect(overview.orders.find((order) => order.id === orderId)?.kitchenStatus).toBe("collected");

    expect((await patch(`/api/staff/orders/${orderId}/status`, { status: "eaten" })).status).toBe(400);
    expect((await patch("/api/staff/orders/nope/status", { status: "cooking" })).status).toBe(404);
  });

  it("reports sales for a day and for a range", async () => {
    const cartId = await openCart({ table: "9" });
    await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const placed = (await json(await post("/api/orders", { cartId }))) as { order: { id: string } };
    await post(`/api/orders/${placed.order.id}/payment`, { method: "card" });
    await post(`/api/payments/simulate/${placed.order.id}`, {});

    type Report = {
      startDate: string;
      endDate: string;
      timeZone: string;
      count: number;
      totalSen: number;
      total: string;
      days: { day: string; count: number; totalSen: number; total: string }[];
    };

    // No dates at all: today, in the shop's own timezone.
    const today = (await json(await fetch(`${base}/api/staff/sales-report`))) as Report;
    expect(today.days).toHaveLength(1);
    expect(today.startDate).toBe(today.endDate);
    expect(today.days[0]!.day).toBe(today.startDate);
    expect(today.count).toBeGreaterThan(0);
    expect(today.totalSen).toBe(today.days[0]!.totalSen);

    // A range returns a row per day, quiet days included as zeroes.
    const range = (await json(
      await fetch(`${base}/api/staff/sales-report?start_date=2020-01-01&end_date=2020-01-07`),
    )) as Report;
    expect(range.days.map((day) => day.day)).toEqual([
      "2020-01-01",
      "2020-01-02",
      "2020-01-03",
      "2020-01-04",
      "2020-01-05",
      "2020-01-06",
      "2020-01-07",
    ]);
    expect(range.count).toBe(0);
    expect(range.total).toBe("RM0.00");

    // One date means one day, whichever end it was given as.
    const single = (await json(await fetch(`${base}/api/staff/sales-report?end_date=2020-01-01`))) as Report;
    expect(single.startDate).toBe("2020-01-01");
    expect(single.days).toHaveLength(1);
  });

  it("refuses a range it cannot report on", async () => {
    const cases: [string, string][] = [
      ["?start_date=not-a-date", "invalid_date"],
      ["?start_date=2020-02-31", "invalid_date"],
      ["?start_date=2020-01-08&end_date=2020-01-01", "invalid_date_range"],
      ["?start_date=2020-01-01&end_date=2024-01-01", "range_too_long"],
    ];

    for (const [query, error] of cases) {
      const response = await fetch(`${base}/api/staff/sales-report${query}`);
      expect(response.status, query).toBe(400);
      await expect(response.json(), query).resolves.toMatchObject({ error });
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
