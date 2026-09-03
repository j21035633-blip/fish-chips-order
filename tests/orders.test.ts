import { beforeEach, describe, expect, it } from "vitest";

import { menuService } from "../src/menu/service.js";
import { priceLine } from "../src/orders/pricing.js";
import { renderCart, renderOrder } from "../src/orders/render.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError } from "../src/orders/types.js";

let carts: CartService;
let orders: OrderService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
});

/** Adds a dory and returns the cart id. */
async function cartWithDory(quantity = 1) {
  const cart = await carts.create();
  await carts.addLine(cart.id, { itemId: "fish-dory-classic", quantity });
  return cart.id;
}

describe("pricing", () => {
  it("prices base item plus option deltas", () => {
    const line = priceLine(
      {
        lineId: "l1",
        itemId: "chips-classic",
        quantity: 2,
        selections: [
          { groupId: "size", choiceId: "large" }, // +RM4.00
          { groupId: "seasoning", choiceId: "salted_egg" }, // +RM2.00
          { groupId: "dips", choiceId: "gravy" }, // +RM1.50
        ],
      },
      menuService,
    );

    // 790 + 400 + 200 + 150 = 1540 per unit
    expect(line.unitPriceSen).toBe(1540);
    expect(line.unitPrice).toBe("RM15.40");
    expect(line.lineTotalSen).toBe(3080);
    expect(line.lineTotal).toBe("RM30.80");
  });

  it("applies the default choice for a required group left unspecified", () => {
    const line = priceLine(
      { lineId: "l1", itemId: "chips-classic", quantity: 1, selections: [] },
      menuService,
    );

    expect(line.unitPriceSen).toBe(790);
    expect(line.options.map((option) => option.choiceId)).toEqual(["regular", "sea_salt"]);
  });

  it("collects allergens introduced by an option", () => {
    const plain = priceLine(
      { lineId: "l1", itemId: "chips-classic", quantity: 1, selections: [] },
      menuService,
    );
    expect(plain.allergens).toEqual([]);

    const saltedEgg = priceLine(
      {
        lineId: "l2",
        itemId: "chips-classic",
        quantity: 1,
        selections: [{ groupId: "seasoning", choiceId: "salted_egg" }],
      },
      menuService,
    );
    expect(saltedEgg.allergens).toContain("egg");
    expect(saltedEgg.allergens).toContain("milk");
  });

  it("prices a negative option delta correctly", () => {
    const line = priceLine(
      {
        lineId: "l1",
        itemId: "combo-classic",
        quantity: 1,
        selections: [{ groupId: "combo_drink", choiceId: "mineral_water" }],
      },
      menuService,
    );
    expect(line.unitPriceSen).toBe(2490 - 100);
  });

  const rejections: [string, Parameters<typeof priceLine>[0], string][] = [
    [
      "an unknown item",
      { lineId: "l", itemId: "fish-unicorn", quantity: 1, selections: [] },
      "unknown_item",
    ],
    [
      "a sold-out item",
      { lineId: "l", itemId: "fish-prawn-popcorn", quantity: 1, selections: [] },
      "item_unavailable",
    ],
    [
      "quantity zero",
      { lineId: "l", itemId: "chips-classic", quantity: 0, selections: [] },
      "invalid_quantity",
    ],
    [
      "quantity over the cap",
      { lineId: "l", itemId: "chips-classic", quantity: 21, selections: [] },
      "invalid_quantity",
    ],
    [
      "a fractional quantity",
      { lineId: "l", itemId: "chips-classic", quantity: 1.5, selections: [] },
      "invalid_quantity",
    ],
    [
      "an unknown option group",
      {
        lineId: "l",
        itemId: "chips-classic",
        quantity: 1,
        selections: [{ groupId: "toppings", choiceId: "x" }],
      },
      "unknown_option_group",
    ],
    [
      "an unknown choice",
      {
        lineId: "l",
        itemId: "chips-classic",
        quantity: 1,
        selections: [{ groupId: "size", choiceId: "gigantic" }],
      },
      "unknown_option_choice",
    ],
    [
      "two picks in a pick-one group",
      {
        lineId: "l",
        itemId: "chips-classic",
        quantity: 1,
        selections: [
          { groupId: "size", choiceId: "regular" },
          { groupId: "size", choiceId: "large" },
        ],
      },
      "too_many_options",
    ],
    [
      "the same choice twice",
      {
        lineId: "l",
        itemId: "chips-classic",
        quantity: 1,
        selections: [
          { groupId: "dips", choiceId: "gravy" },
          { groupId: "dips", choiceId: "gravy" },
        ],
      },
      "duplicate_option",
    ],
    [
      "more dips than the group allows",
      {
        lineId: "l",
        itemId: "chips-classic",
        quantity: 1,
        selections: [
          { groupId: "dips", choiceId: "gravy" },
          { groupId: "dips", choiceId: "tartar" },
          { groupId: "dips", choiceId: "chilli" },
          { groupId: "dips", choiceId: "curry_sauce" },
        ],
      },
      "too_many_options",
    ],
  ];

  it.each(rejections)("rejects %s", (_label, line, code) => {
    try {
      priceLine(line, menuService);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OrderValidationError);
      expect((error as OrderValidationError).code).toBe(code);
    }
  });

  it("never trusts a client-supplied price", () => {
    const line = priceLine(
      // A tampered payload carrying its own price fields.
      {
        lineId: "l",
        itemId: "fish-cod-premium",
        quantity: 1,
        selections: [],
        ...({ unitPriceSen: 1, lineTotalSen: 1 } as object),
      },
      menuService,
    );
    expect(line.unitPriceSen).toBe(2890);
  });
});

describe("cart", async () => {
  it("adds lines and keeps a running total", async () => {
    const cartId = await cartWithDory();
    const cart = await carts.addLine(cartId, { itemId: "chips-classic", quantity: 2 });

    expect(cart.itemCount).toBe(3);
    expect(cart.subtotalSen).toBe(1690 + 790 * 2);
    expect(cart.total).toBe("RM32.70");
  });

  it("updates a line quantity", async () => {
    const cartId = await cartWithDory();
    const lineId = (await carts.price(cartId)).lines[0]!.lineId;

    const cart = await carts.updateQuantity(cartId, lineId, 3);
    expect(cart.itemCount).toBe(3);
    expect(cart.subtotalSen).toBe(1690 * 3);
  });

  it("treats quantity 0 as removal", async () => {
    const cartId = await cartWithDory();
    const lineId = (await carts.price(cartId)).lines[0]!.lineId;

    expect((await carts.updateQuantity(cartId, lineId, 0)).lines).toHaveLength(0);
  });

  it("removes and clears", async () => {
    const cartId = await cartWithDory();
    await carts.addLine(cartId, { itemId: "chips-classic" });
    const lineId = (await carts.price(cartId)).lines[0]!.lineId;

    expect((await carts.removeLine(cartId, lineId)).lines).toHaveLength(1);
    expect((await carts.clear(cartId)).lines).toHaveLength(0);
  });

  it("rejects an invalid add without mutating the cart", async () => {
    const cartId = await cartWithDory();
    await expect(carts.addLine(cartId, { itemId: "fish-prawn-popcorn" })).rejects.toThrow(OrderValidationError);
    expect((await carts.price(cartId)).lines).toHaveLength(1);
  });

  it("404s an unknown cart", async () => {
    try {
      await carts.price("nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as OrderValidationError).code).toBe("unknown_cart");
    }
  });

  it("rejects an unknown line", async () => {
    const cartId = await cartWithDory();
    try {
      await carts.removeLine(cartId, "nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as OrderValidationError).code).toBe("unknown_line");
    }
  });
});

describe("orders", async () => {
  it("confirms a cart into a pending order", async () => {
    const cartId = await cartWithDory(2);
    const order = await orders.confirm({ cartId, customerName: "Aisyah" });

    expect(order.paymentStatus).toBe("pending");
    expect(order.totalSen).toBe(3380);
    expect(order.total).toBe("RM33.80");
    expect(order.customerName).toBe("Aisyah");
    expect(order.reference).toMatch(/^[A-Z]{2}-\d{4}$/);
    expect(order.payment).toBeUndefined();
  });

  it("empties the cart so a double submit cannot twin the order", async () => {
    const cartId = await cartWithDory();
    await orders.confirm({ cartId });

    expect((await carts.price(cartId)).lines).toHaveLength(0);
    try {
      await orders.confirm({ cartId });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as OrderValidationError).code).toBe("empty_cart");
    }
  });

  it("refuses an empty cart", async () => {
    const cart = await carts.create();
    await expect(orders.confirm({ cartId: cart.id })).rejects.toThrow(OrderValidationError);
  });

  it("issues distinct references", async () => {
    const references = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      references.add((await orders.confirm({ cartId: await cartWithDory() })).reference);
    }
    expect(references.size).toBe(25);
  });

  it("marks paid idempotently", async () => {
    const order = await orders.confirm({ cartId: await cartWithDory() });

    const first = await orders.markPaid(order.id);
    expect(first.changed).toBe(true);
    expect(first.order.paymentStatus).toBe("paid");

    const second = await orders.markPaid(order.id);
    expect(second.changed).toBe(false);
    expect(second.order.paymentStatus).toBe("paid");
  });

  it("never downgrades a paid order to failed", async () => {
    const order = await orders.confirm({ cartId: await cartWithDory() });
    await orders.markPaid(order.id);

    const result = await orders.markFailed(order.id, "late failure");
    expect(result.changed).toBe(false);
    expect(result.order.paymentStatus).toBe("paid");
  });

  it("refuses to attach a payment to a paid order", async () => {
    const order = await orders.confirm({ cartId: await cartWithDory() });
    await orders.markPaid(order.id);

    await expect(
      orders.attachPayment(order.id, {
        method: "card",
        provider: "stripe",
        providerPaymentId: "cs_test_1",
        status: "pending",
        simulated: false,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(OrderValidationError);
  });

  it("starts on the kitchen board, and models nothing else", async () => {
    const order = await orders.confirm({ cartId: await cartWithDory() });
    // Kitchen status arrived with the staff dashboard; a generic `status` still
    // does not exist, because payment and kitchen progress are separate fields.
    expect(order.kitchenStatus).toBe("received");
    expect(order).not.toHaveProperty("status");
  });
});

describe("rendering", async () => {
  it("renders a cart with its total", async () => {
    const cartId = await cartWithDory(2);
    const text = renderCart(await carts.price(cartId));

    expect(text).toContain("2x Classic Battered Dory");
    expect(text).toContain("Total: RM33.80");
  });

  it("omits no-cost default options but keeps paid upgrades", async () => {
    const cart = await carts.create();
    await carts.addLine(cart.id, {
      itemId: "chips-classic",
      selections: [{ groupId: "seasoning", choiceId: "salted_egg" }],
    });

    const text = renderCart(await carts.price(cart.id));
    expect(text).toContain("Salted egg dust");
    expect(text).not.toContain("Sea salt");
  });

  it("says so when the cart is empty", async () => {
    expect(renderCart(await carts.price((await carts.create()).id))).toBe("Cart's empty.");
  });

  it("renders an order with its reference and payment state", async () => {
    const order = await orders.confirm({ cartId: await cartWithDory() });
    const text = renderOrder(order);

    expect(text).toContain(`Order ${order.reference}`);
    expect(text).toContain("Payment pending");
  });
});
