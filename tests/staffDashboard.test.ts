import { beforeEach, describe, expect, it } from "vitest";

import { menuService } from "../src/menu/service.js";
import { businessDay, businessDayRange } from "../src/orders/businessDay.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError, type Order } from "../src/orders/types.js";

const KL = "Asia/Kuala_Lumpur";

let carts: CartService;
let orderRepository: InMemoryOrderRepository;
let orders: OrderService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orderRepository = new InMemoryOrderRepository();
  orders = new OrderService(orderRepository, carts, menuService);
});

async function anOrder(table?: string): Promise<Order> {
  const cart = await carts.create(table);
  await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id });
}

/** Rewrites when an order was placed and settled, to land it on a given day. */
async function backdate(order: Order, createdAt: string, paidAt?: string): Promise<void> {
  const stored = (await orderRepository.get(order.id))!;
  stored.createdAt = createdAt;
  if (paidAt !== undefined) {
    stored.paymentStatus = "paid";
    stored.payment = {
      method: "card",
      provider: "stripe",
      providerPaymentId: `cs_${order.id}`,
      status: "paid",
      simulated: true,
      createdAt,
      paidAt,
    };
  }
  await orderRepository.save(stored);
}

describe("kitchen status", () => {
  it("starts every order at received", async () => {
    expect((await anOrder("3")).kitchenStatus).toBe("received");
  });

  it("advances Received -> Cooking -> Ready", async () => {
    const order = await anOrder("3");

    expect((await orders.setKitchenStatus(order.id, "cooking")).order.kitchenStatus).toBe("cooking");
    expect((await orders.setKitchenStatus(order.id, "ready")).order.kitchenStatus).toBe("ready");
    expect((await orders.get(order.id)).kitchenStatus).toBe("ready");
  });

  it("is idempotent, so a double-tap on the pass is not an error", async () => {
    const order = await anOrder();
    await orders.setKitchenStatus(order.id, "cooking");

    const again = await orders.setKitchenStatus(order.id, "cooking");
    expect(again.changed).toBe(false);
    expect(again.order.kitchenStatus).toBe("cooking");
  });

  it("can go back, because a mis-tap on a busy pass has to be undoable", async () => {
    const order = await anOrder();
    await orders.setKitchenStatus(order.id, "ready");

    expect((await orders.setKitchenStatus(order.id, "cooking")).order.kitchenStatus).toBe("cooking");
  });

  it("rejects a status that is not a status", async () => {
    const order = await anOrder();
    await expect(orders.setKitchenStatus(order.id, "burnt" as never)).rejects.toThrow(OrderValidationError);
  });

  it("leaves payment alone", async () => {
    const order = await anOrder();
    await orders.setKitchenStatus(order.id, "ready");

    // Food and money move independently; the board must not settle anything.
    expect((await orders.get(order.id)).paymentStatus).toBe("pending");
  });
});

describe("staff feed", () => {
  it("shows today's orders, newest first, with the table on them", async () => {
    const first = await anOrder("2");
    const second = await anOrder("9");
    await backdate(first, "2020-01-01T00:00:00.000Z");

    const feed = await orders.feed(KL);

    // The backdated one is not today's trade.
    expect(feed.map((order) => order.id)).toEqual([second.id]);
    expect(feed[0]!.tableNumber).toBe("9");
    expect(feed[0]!.lines).toHaveLength(1);
  });

  it("keeps unpaid orders on the board", async () => {
    // The kitchen still needs the ticket; the board shows payment separately so
    // the counter can decide whether to cook it.
    const order = await anOrder("4");
    expect((await orders.feed(KL)).map((entry) => entry.id)).toContain(order.id);
  });
});

describe("today's sales total", () => {
  it("counts paid orders only", async () => {
    const paid = await anOrder("1");
    await orders.markPaid(paid.id);
    await anOrder("2"); // still pending

    const sales = await orders.dailySales(KL);

    expect(sales.count).toBe(1);
    expect(sales.totalSen).toBe(paid.totalSen);
    expect(sales.total).toBe(paid.total);
    expect(sales.day).toBe(businessDay(new Date(), KL));
  });

  it("sums several orders", async () => {
    for (const table of ["1", "2", "3"]) {
      const order = await anOrder(table);
      await orders.markPaid(order.id);
    }

    const sales = await orders.dailySales(KL);
    expect(sales.count).toBe(3);
    expect(sales.totalSen).toBe(1690 * 3);
    expect(sales.total).toBe("RM50.70");
  });

  it("excludes yesterday's takings", async () => {
    const today = businessDay(new Date(), KL);
    const { start } = businessDayRange(today, KL);
    const justBefore = new Date(new Date(start).getTime() - 60_000).toISOString();

    const yesterday = await anOrder("1");
    await backdate(yesterday, justBefore, justBefore);

    const sales = await orders.dailySales(KL);
    expect(sales.count).toBe(0);
    expect(sales.totalSen).toBe(0);
  });

  it("counts an order placed yesterday but paid today", async () => {
    const today = businessDay(new Date(), KL);
    const { start } = businessDayRange(today, KL);
    const beforeOpen = new Date(new Date(start).getTime() - 3_600_000).toISOString();
    const afterOpen = new Date(new Date(start).getTime() + 60_000).toISOString();

    const order = await anOrder("1");
    // Placed before the day flipped, settled after: it is today's money.
    await backdate(order, beforeOpen, afterOpen);

    const sales = await orders.dailySales(KL);
    expect(sales.count).toBe(1);
    expect(sales.totalSen).toBe(order.totalSen);
  });

  it("uses the shop's timezone, not the server's", async () => {
    const order = await anOrder("1");
    await orders.markPaid(order.id);

    // Somewhere far enough west that "now" is still the previous date there.
    const honolulu = await orders.dailySales("Pacific/Honolulu");
    expect(honolulu.timeZone).toBe("Pacific/Honolulu");
    expect(honolulu.day).toBe(businessDay(new Date(), "Pacific/Honolulu"));
  });

  it("reports zero cleanly before the first sale", async () => {
    const sales = await orders.dailySales(KL);
    expect(sales).toMatchObject({ count: 0, totalSen: 0, total: "RM0.00", timeZone: KL });
  });
});
