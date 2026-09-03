import { beforeEach, describe, expect, it } from "vitest";

import { menuService } from "../src/menu/service.js";
import { renderOrder } from "../src/orders/render.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError, parseTableNumber } from "../src/orders/types.js";

let carts: CartService;
let orders: OrderService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
});

describe("parseTableNumber", () => {
  it("accepts the labels a shop actually uses", () => {
    expect(parseTableNumber("5")).toBe("5");
    expect(parseTableNumber("12")).toBe("12");
    expect(parseTableNumber("A3")).toBe("A3");
    expect(parseTableNumber("PATIO-1")).toBe("PATIO-1");
  });

  it("normalises case and surrounding space", () => {
    // "a3" and "A3" are one table, not two — staff read this off a sticker.
    expect(parseTableNumber(" a3 ")).toBe("A3");
  });

  it("rejects anything that is not a table label", () => {
    for (const bad of ["", "   ", "-1", "table five", "9".repeat(9), "5/../admin", "<b>1</b>", 5, null]) {
      expect(() => parseTableNumber(bad)).toThrow(OrderValidationError);
    }
  });
});

describe("table-aware ordering", () => {
  it("carries the table from the scan through to the order", async () => {
    const cart = await carts.create("7");
    expect(cart.tableNumber).toBe("7");

    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    // The priced cart echoes it, so the page can show where it is ordering for.
    expect((await carts.price(cart.id)).tableNumber).toBe("7");

    const order = await orders.confirm({ cartId: cart.id });
    expect(order.tableNumber).toBe("7");
    expect(renderOrder(order)).toContain(`Order ${order.reference} · Table 7`);
  });

  it("leaves the table off a counter order", async () => {
    const cart = await carts.create();
    expect(cart.tableNumber).toBeUndefined();

    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    const order = await orders.confirm({ cartId: cart.id });

    expect(order.tableNumber).toBeUndefined();
    expect(renderOrder(order)).toContain(`Order ${order.reference}`);
    expect(renderOrder(order)).not.toContain("Table");
  });

  it("refuses a malformed table at the point the cart is opened", async () => {
    await expect(carts.create("../admin")).rejects.toThrow(OrderValidationError);
  });

  it("gives each customer at a table their own cart", async () => {
    // The table is a routing tag, never a shared "current order" store.
    const first = await carts.create("4");
    const second = await carts.create("4");

    expect(second.id).not.toBe(first.id);

    await carts.addLine(first.id, { itemId: "fish-dory-classic" });
    expect((await carts.price(first.id)).itemCount).toBe(1);
    expect((await carts.price(second.id)).itemCount).toBe(0);

    // Both still route to table 4.
    expect(second.tableNumber).toBe("4");
  });

  it("keeps the table out of the customer's control at checkout", async () => {
    const cart = await carts.create("2");
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });

    // `confirm` takes no table: it comes from the cart the QR opened, so nobody
    // can check out "as" a table they never scanned.
    const order = await orders.confirm({ cartId: cart.id, customerName: "Aisyah" });
    expect(order.tableNumber).toBe("2");
  });
});
