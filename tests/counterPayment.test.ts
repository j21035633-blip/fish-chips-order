/**
 * "Pay at counter": a third way to pay, and the only one where the food goes
 * out before the money comes in.
 *
 * Two rules carry the whole thing, and they pull against each other:
 *
 *  - the ticket reaches the kitchen **immediately**, because nothing is waiting
 *    on a gateway — there is no gateway;
 *  - the money reaches the **report** only when somebody actually takes it,
 *    because until then the shop is holding food, not cash.
 *
 * Everything below is one of those two.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Services } from "../src/app/container.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { InMemoryStaffAccountRepository, StaffAccountService } from "../src/staff/accounts.js";
import { DeviceCheckInService, InMemoryDeviceCheckInRepository } from "../src/staff/checkIns.js";
import { InMemoryRoleRepository, RoleService } from "../src/staff/roles.js";
import { createServer } from "../src/http/app.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError, type Order } from "../src/orders/types.js";
import { PaymentService } from "../src/payments/service.js";
import { StripeAdapter } from "../src/payments/stripeAdapter.js";
import { RevenueMonsterAdapter } from "../src/payments/revenueMonsterAdapter.js";

const BASE_URL = "http://localhost:3000";
/**
 * Whoever is on the till. `settleAtCounter` takes an already-verified person —
 * checking that they are real is the HTTP layer's job, exercised in
 * staffAccounts.test.ts — so these tests hand it one and get on with the money.
 */
const CASHIER = { staffId: "AR47", name: "Aisyah Rahman", at: "2026-03-01T10:00:00.000Z" };
const NO_KEYS = { secretKey: undefined, webhookSecret: undefined, apiBase: "https://api.stripe.test" };

let carts: CartService;
let orders: OrderService;
let payments: PaymentService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
  // No credentials, so both adapters simulate — which is exactly the shape a
  // counter settlement takes locally, and keeps the webhook the only way to paid.
  payments = new PaymentService(
    orders,
    [
      new StripeAdapter(NO_KEYS, BASE_URL),
      new RevenueMonsterAdapter(
        { apiKey: undefined, clientId: undefined, clientSecret: undefined, webhookSecret: undefined, storeId: undefined, apiBase: "https://rm.test", privateKeyPath: undefined },
        BASE_URL,
      ),
    ],
    BASE_URL,
  );
});

/** An order the customer chose to settle with staff. */
async function counterOrder(): Promise<Order> {
  const cart = await carts.create();
  await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id, payAtCounter: true });
}

/** An ordinary gateway order, for contrast. */
async function gatewayOrder(): Promise<Order> {
  const cart = await carts.create();
  await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id });
}

const takings = async () => (await orders.dailySales()).totalSen;

describe("an order placed to be paid at the counter", () => {
  it("is marked as owed at the counter, not as a gateway payment mid-flight", () => {
    // The distinction the counter needs: `pending` means a provider is working
    // on it, and this one has no provider and never will until somebody settles.
    return counterOrder().then((order) => {
      expect(order.paymentStatus).toBe("unpaid_counter");
      expect(order.payment).toBeUndefined();
      expect(order.paidInCash).toBeUndefined();
    });
  });

  it("reaches the kitchen immediately", async () => {
    const order = await counterOrder();

    expect(order.kitchenStatus).toBe("received");
    // No hold: that exists for a card takeaway where the customer is standing
    // at the terminal, and there is no terminal here.
    expect(order.holdForPayment).toBeUndefined();

    const feed = await orders.feed();
    expect(feed.map((entry) => entry.id)).toContain(order.id);
  });

  it("counts for nothing until somebody takes the money", async () => {
    const order = await counterOrder();

    expect(await takings()).toBe(0);
    const report = await orders.salesReport({});
    expect(report.days[0]!.totalSen).toBe(0);
    expect(report.days[0]!.count).toBe(0);
    expect(order.totalSen).toBeGreaterThan(0);
  });

  it("leaves the ordinary gateway order exactly as it was", async () => {
    // The path this must not disturb.
    const order = await gatewayOrder();
    expect(order.paymentStatus).toBe("pending");
    expect(order.holdForPayment).toBeUndefined();
  });
});

describe("settling one at the counter", () => {
  it("takes cash on the spot", async () => {
    const order = await counterOrder();

    const { order: settled, settled: done } = await payments.settleAtCounter(order.id, "cash", CASHIER);

    expect(done).toBe(true);
    expect(settled.paymentStatus).toBe("paid");
    expect(settled.paidInCash).toBe(true);
    // No provider was asked, because there is nothing to ask.
    expect(settled.payment).toBeUndefined();
    // And it lands in the day's takings the moment it is taken.
    expect(await takings()).toBe(order.totalSen);
  });

  for (const method of ["card", "ewallet"] as const) {
    it(`opens a ${method} session and waits for the webhook before it counts`, async () => {
      const order = await counterOrder();

      const { order: started, settled } = await payments.settleAtCounter(order.id, method, CASHIER);

      // Something to turn round to the customer...
      expect(settled).toBe(false);
      expect(started.payment).toBeDefined();
      expect(started.payment!.method).toBe(method);
      expect(started.payment!.checkoutUrl ?? started.payment!.qrCodeUrl).toBeTruthy();

      // ...and emphatically not money yet. A staff member watching somebody tap
      // a phone is not proof of payment; the provider saying so is.
      expect(started.paymentStatus).not.toBe("paid");
      expect(await takings()).toBe(0);

      // The webhook is what moves it, exactly as for a customer paying at the table.
      await orders.markPaid(order.id);
      expect((await orders.get(order.id)).paymentStatus).toBe("paid");
      expect(await takings()).toBe(order.totalSen);
    });
  }

  it("refuses an order that is not owed at the counter", async () => {
    // A gateway order mid-flight is somebody else's: settling it here would take
    // the money twice when its own webhook lands.
    const gateway = await gatewayOrder();
    await expect(payments.settleAtCounter(gateway.id, "cash", CASHIER)).rejects.toThrow(/not waiting to be paid/i);
    await expect(payments.settleAtCounter(gateway.id, "cash", CASHIER)).rejects.toThrow(OrderValidationError);
  });

  it("refuses to take the money twice", async () => {
    const order = await counterOrder();
    await payments.settleAtCounter(order.id, "cash", CASHIER);

    await expect(payments.settleAtCounter(order.id, "cash", CASHIER)).rejects.toThrow(/already paid/i);
    expect(await takings()).toBe(order.totalSen);
  });

  it("still owes at the counter if the gateway session is never paid", async () => {
    // The realistic failure: the customer walks off mid-QR. The order must go
    // back to being collectable rather than being stuck or silently counted.
    const order = await counterOrder();
    await payments.settleAtCounter(order.id, "ewallet", CASHIER);

    expect(await takings()).toBe(0);
    expect((await orders.get(order.id)).paymentStatus).toBe("unpaid_counter");
  });

  it("will not take cash on top of a QR that may already have gone through", async () => {
    // Tempting, and wrong. Once a session is open the customer may have paid it
    // seconds ago with the webhook still in flight, and notes in the till on top
    // of that is a double charge. `takeCash` has refused this since it was
    // written for takeaways, and it goes on refusing it here.
    const order = await counterOrder();
    await payments.settleAtCounter(order.id, "ewallet", CASHIER);

    await expect(payments.settleAtCounter(order.id, "cash", CASHIER)).rejects.toThrow(/already has a card payment/i);

    // Still owed, still off the report, still on the boards as Unpaid — which
    // is what a staff member needs in order to sort it out with the customer.
    expect((await orders.get(order.id)).paymentStatus).toBe("unpaid_counter");
    expect(await takings()).toBe(0);
  });
});

/** The same thing over HTTP, which is the only way either screen touches it. */
describe("over HTTP", () => {
  let server: Server;
  let base: string;

  const accounts = new StaffAccountService(new InMemoryStaffAccountRepository());

  beforeAll(async () => {
    const cartRepo = new InMemoryCartRepository();
    const orderRepo = new InMemoryOrderRepository();
    const cartService = new CartService(cartRepo, menuService);
    const orderService = new OrderService(orderRepo, cartService, menuService);
    const app = {
      carts: cartService,
      orders: orderService,
      menu: menuService,
      menuStore: undefined as never,
      payments: new PaymentService(orderService, [new StripeAdapter(NO_KEYS, BASE_URL)], BASE_URL),
      proofs: new InMemoryProofRepository(),
      staffAccounts: accounts,
      staffRoles: new RoleService(new InMemoryRoleRepository()),
      checkIns: new DeviceCheckInService(new InMemoryDeviceCheckInRepository()),
      storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} },
    } as unknown as Services;

    // The settle endpoint refuses an unattributed payment, so there has to be
    // somebody on the till for these to be about anything else.
    await accounts.create({ staffId: CASHIER.staffId, name: CASHIER.name, password: "till-pass", role: "Cashier" });

    server = createServer(app).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = (res: Response): Promise<any> => res.json() as Promise<any>;

  async function placeAtCounter(): Promise<any> {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const { order } = await json(await call("POST", "/api/orders", { cartId, payAtCounter: true }));
    return order;
  }

  it("places one, shows it on the board, and keeps it out of the takings", async () => {
    const order = await placeAtCounter();
    expect(order.paymentStatus).toBe("unpaid_counter");

    const overview = await json(await call("GET", "/api/staff/overview"));
    const onFeed = overview.orders.find((entry: any) => entry.id === order.id);
    expect(onFeed, "the kitchen should have it straight away").toBeDefined();
    expect(onFeed.kitchenStatus).toBe("received");
    expect(overview.sales.totalSen).toBe(0);
  });

  it("settles for cash and the takings move", async () => {
    const order = await placeAtCounter();
    // A delta, not an absolute: this server is shared across the tests in this
    // block, so the day's total already has other orders in it.
    const before = (await json(await call("GET", "/api/staff/overview"))).sales.totalSen;

    const response = await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash", staffId: CASHIER.staffId, staffName: CASHIER.name });
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({ settled: true, order: { paymentStatus: "paid" } });

    const after = (await json(await call("GET", "/api/staff/overview"))).sales.totalSen;
    expect(after - before).toBe(order.totalSen);
  });

  it("hands back something to show the customer for card, still unpaid", async () => {
    const order = await placeAtCounter();

    const before = (await json(await call("GET", "/api/staff/overview"))).sales.totalSen;
    const body = await json(await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "card", staffId: CASHIER.staffId, staffName: CASHIER.name }));

    expect(body.settled).toBe(false);
    expect(body.payment.checkoutUrl ?? body.payment.qrCodeUrl).toBeTruthy();
    // Still owed, and still saying so — which is what keeps the badge up and
    // leaves cash available if the customer wanders off.
    expect(body.order.paymentStatus).toBe("unpaid_counter");

    const after = (await json(await call("GET", "/api/staff/overview"))).sales.totalSen;
    expect(after - before).toBe(0);
  });

  it("rejects a settle method that is not one of the three", async () => {
    const order = await placeAtCounter();
    expect(
      (await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "crypto", staffId: CASHIER.staffId, staffName: CASHIER.name })).status,
    ).toBe(400);
    expect((await call("PATCH", `/api/staff/orders/${order.id}/settle`, {})).status).toBe(400);
  });

  it("does not put cash in the customer's own payment picker", async () => {
    // The rule on `Order.paidInCash`, still holding: cash is a thing staff do,
    // never an option offered on a phone.
    const { methods } = await json(await call("GET", "/api/payments/methods"));
    expect(methods.map((option: any) => option.method)).not.toContain("cash");
    expect(methods.map((option: any) => option.method)).not.toContain("counter");
  });
});
