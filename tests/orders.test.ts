import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServices } from "../src/app/container.js";
import { createServer } from "../src/http/app.js";

import { menuService } from "../src/menu/service.js";
import { orderTotals, priceLine, TAX_RATE } from "../src/orders/pricing.js";
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
    // 3270 of food, 327 of tax on top: the running total is what gets charged.
    expect(cart.subtotal).toBe("RM32.70");
    expect(cart.taxSen).toBe(327);
    expect(cart.totalSen).toBe(3597);
    expect(cart.total).toBe("RM35.97");
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
    expect(order.subtotalSen).toBe(3380);
    expect(order.taxSen).toBe(338);
    expect(order.totalSen).toBe(3718);
    expect(order.total).toBe("RM37.18");
    // The rate rides along with the order, so the receipt still adds up after
    // the day the rate changes.
    expect(order.taxRate).toBe(0.1);
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
    expect(text).toContain("Subtotal: RM33.80");
    expect(text).toContain("Tax (10%): RM3.38");
    expect(text).toContain("Total: RM37.18");
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

describe("tax", () => {
  it("is 10%, rounded to the sen", () => {
    expect(TAX_RATE).toBe(0.1);
    expect(orderTotals(1000)).toMatchObject({ subtotalSen: 1000, taxSen: 100, totalSen: 1100 });
  });

  it("rounds the half-sen up, and never leaves a fraction behind", () => {
    // RM10.85 is the awkward one: 108.5 sen of tax. It has to land on a whole
    // sen, because nothing downstream — the order, the provider, the till —
    // can hold half of one.
    expect(orderTotals(1085)).toMatchObject({ taxSen: 109, totalSen: 1194, tax: "RM1.09", total: "RM11.94" });

    const cases: [number, number][] = [
      [0, 0],
      [1, 0], // 0.1 sen: rounds away entirely
      [5, 1], // exactly a half: up
      [14, 1], // 1.4: down
      [15, 2], // 1.5: up
      [99, 10],
      [1085, 109],
      [1690, 169],
      [2345, 235], // 234.5: up
      [3270, 327],
      [999_99, 10_000],
    ];

    for (const [subtotalSen, expected] of cases) {
      const totals = orderTotals(subtotalSen);
      expect(totals.taxSen, `tax on ${subtotalSen}`).toBe(expected);
      expect(Number.isInteger(totals.taxSen), `integer tax on ${subtotalSen}`).toBe(true);
      expect(totals.totalSen, `total on ${subtotalSen}`).toBe(subtotalSen + expected);
    }
  });

  it("adds up, for every subtotal from nothing to a big table's order", () => {
    // The invariant, not a sample of it: subtotal + tax === total, always, and
    // the tax is never more than half a sen off the true 10%.
    for (let subtotalSen = 0; subtotalSen <= 20_000; subtotalSen += 1) {
      const { taxSen, totalSen } = orderTotals(subtotalSen);
      if (subtotalSen + taxSen !== totalSen) throw new Error(`does not add up at ${subtotalSen}`);
      if (Math.abs(taxSen - subtotalSen * TAX_RATE) > 0.5) throw new Error(`drifts at ${subtotalSen}`);
      if (!Number.isInteger(taxSen)) throw new Error(`fractional sen at ${subtotalSen}`);
    }
    expect(true).toBe(true);
  });

  it("is worked out once on the order, not once per line", async () => {
    // Two lines of RM7.85 would round to 79 sen of tax each — 158 — while the
    // order's own RM15.70 subtotal is taxed 157. The order-level answer is the
    // one that has to win: it is the one a customer can check by adding up what
    // is on the screen. (Every seed price is a round 10 sen, so this case
    // cannot be built from the menu — which is exactly why it is asserted on
    // the function rather than through a cart.)
    const lineTotals = [785, 785];
    const perLine = lineTotals.reduce((sum, line) => sum + Math.round(line * TAX_RATE), 0);
    const totals = orderTotals(lineTotals.reduce((sum, line) => sum + line, 0));

    expect(perLine).toBe(158);
    expect(totals.taxSen).toBe(157);

    // And a real cart takes its tax from its own subtotal, not from its lines.
    const cart = await carts.create();
    await carts.addLine(cart.id, { itemId: "drink-teh-ais", quantity: 3 });
    const priced = await carts.price(cart.id);
    expect(priced.taxSen).toBe(Math.round(priced.subtotalSen * TAX_RATE));
    expect(priced.subtotalSen + priced.taxSen).toBe(priced.totalSen);
  });

  it("carries the same numbers from cart to order to receipt", async () => {
    const cartId = await cartWithDory(2);
    const priced = await carts.price(cartId);
    const order = await orders.confirm({ cartId });

    // The customer is charged what the cart showed them, field for field.
    expect(order.subtotalSen).toBe(priced.subtotalSen);
    expect(order.taxSen).toBe(priced.taxSen);
    expect(order.totalSen).toBe(priced.totalSen);
    expect(order.subtotal).toBe(priced.subtotal);
    expect(order.tax).toBe(priced.tax);
    expect(order.total).toBe(priced.total);
    expect(order.taxRate).toBe(priced.taxRate);
  });

  it("charges nothing on an empty cart", async () => {
    const cart = await carts.create();
    const priced = await carts.price(cart.id);

    expect(priced.taxSen).toBe(0);
    expect(priced.totalSen).toBe(0);
    expect(priced.tax).toBe("RM0.00");
  });
});

/**
 * Editing a line where it sits.
 *
 * The thing worth testing is the *position*. The client used to do this by
 * adding a new line and deleting the old one, which produced the right cart and
 * quietly sent the edited item to the bottom of a customer's order — correct
 * totals, wrong list. Almost everything below is some form of "it did not move".
 */
describe("editing a cart line in place", () => {
  /** A cart with three different items, so the middle one has neighbours. */
  async function threeLines() {
    const cart = await carts.create();
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    await carts.addLine(cart.id, { itemId: "drink-teh-ais" });
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    return cart.id;
  }

  /** The option group and two different choices for an item that has them. */
  async function twoChoices(itemId: string) {
    const { categories } = menuService.getMenu();
    const item = categories.flatMap((category) => category.items).find((entry) => entry.id === itemId)!;
    const group = item.optionGroups.find((candidate) => candidate.choices.length > 1)!;
    return { groupId: group.id, first: group.choices[0]!.id, second: group.choices[1]!.id };
  }

  it("keeps the line exactly where it was among the others", async () => {
    const cartId = await threeLines();
    const before = await carts.price(cartId);
    const middle = before.lines[1]!;
    const { groupId, second } = await twoChoices(middle.itemId);

    const after = await carts.editLine(cartId, middle.lineId, {
      selections: [{ groupId, choiceId: second }],
    });

    // Same slot, same line id, same neighbours in the same order.
    expect(after.lines[1]!.lineId).toBe(middle.lineId);
    expect(after.lines.map((line) => line.lineId)).toEqual(before.lines.map((line) => line.lineId));
    expect(after.lines).toHaveLength(3);
    // And it really did change. Only the group that was sent moves; an item
    // with several groups keeps its defaults for the ones that were not.
    const chosen = after.lines[1]!.options.find((option) => option.groupId === groupId);
    expect(chosen!.choiceId).toBe(second);
  });

  it("changes quantity and selections together in one call", async () => {
    const cartId = await threeLines();
    const before = await carts.price(cartId);
    const target = before.lines[0]!;
    const { groupId, second } = await twoChoices(target.itemId);

    const after = await carts.editLine(cartId, target.lineId, {
      quantity: 3,
      selections: [{ groupId, choiceId: second }],
    });

    expect(after.lines[0]!.lineId).toBe(target.lineId);
    expect(after.lines[0]!.quantity).toBe(3);
    expect(after.lines[0]!.options.find((option) => option.groupId === groupId)!.choiceId).toBe(second);
  });

  it("reprices the whole cart, tax and all", async () => {
    const cartId = await threeLines();
    const before = await carts.price(cartId);
    const target = before.lines[0]!;

    const after = await carts.editLine(cartId, target.lineId, { quantity: 4 });

    expect(after.itemCount).toBe(before.itemCount + 3);
    expect(after.subtotalSen).toBe(before.subtotalSen + target.unitPriceSen * 3);
    // Tax is rounded once on the subtotal, so it is recomputed rather than scaled.
    expect(after.taxSen).toBe(Math.round(after.subtotalSen * after.taxRate));
    expect(after.totalSen).toBe(after.subtotalSen + after.taxSen);
  });

  it("prices an option that costs extra into the line and the total", async () => {
    const cartId = await threeLines();
    const before = await carts.price(cartId);
    const target = before.lines[0]!;

    const { categories } = menuService.getMenu();
    const item = categories.flatMap((category) => category.items).find((entry) => entry.id === target.itemId)!;
    const paid = item.optionGroups
      .flatMap((group) => group.choices.map((choice) => ({ groupId: group.id, choice })))
      .find((entry) => entry.choice.priceDeltaSen > 0);
    if (!paid) return; // No paid option on this item; nothing to assert.

    const after = await carts.editLine(cartId, target.lineId, {
      selections: [{ groupId: paid.groupId, choiceId: paid.choice.id }],
    });

    expect(after.lines[0]!.unitPriceSen).toBe(target.unitBasePriceSen + paid.choice.priceDeltaSen);
    expect(after.subtotalSen).toBeGreaterThan(before.subtotalSen);
  });

  it("refuses to re-choose a drink won from the fishing game", async () => {
    // The protection the page already had, now where it cannot be skipped by
    // calling the API directly: the line prices at zero because it was a prize,
    // and re-choosing its options would have to re-price it.
    const cartId = await threeLines();
    await carts.registerContact(cartId, "player@example.com");
    // 0.85 lands on `rare`, which is the free drink.
    await carts.play(cartId, () => 0.85);

    const priced = await carts.price(cartId);
    const won = priced.lines.find((line) => line.unitPriceSen === 0)!;
    expect(won, "expected the game to have added a free line").toBeDefined();
    const { groupId, second } = await twoChoices(won.itemId);

    await expect(
      carts.editLine(cartId, won.lineId, { selections: [{ groupId, choiceId: second }] }),
    ).rejects.toThrow(/won from the fishing game/i);

    // Untouched, and still free.
    const after = await carts.price(cartId);
    expect(after.lines.find((line) => line.lineId === won.lineId)!.unitPriceSen).toBe(0);
  });

  it("still lets the stepper change a won line's quantity", async () => {
    // Only *selections* are refused. The stepper is explicitly unchanged, and
    // it goes through `updateQuantity`, not this.
    const cartId = await threeLines();
    await carts.registerContact(cartId, "player@example.com");
    await carts.play(cartId, () => 0.85);
    const won = (await carts.price(cartId)).lines.find((line) => line.unitPriceSen === 0)!;

    const after = await carts.editLine(cartId, won.lineId, { quantity: 2 });
    expect(after.lines.find((line) => line.lineId === won.lineId)!.quantity).toBe(2);
  });

  it("refuses a line that is not in this cart", async () => {
    const cartId = await threeLines();
    await expect(carts.editLine(cartId, "not-a-line", { quantity: 2 })).rejects.toThrow(/no line/i);
  });

  it("refuses an option that does not exist, without saving it", async () => {
    const cartId = await threeLines();
    const before = await carts.price(cartId);
    const target = before.lines[0]!;
    const { groupId } = await twoChoices(target.itemId);

    await expect(
      carts.editLine(cartId, target.lineId, { selections: [{ groupId, choiceId: "no-such-choice" }] }),
    ).rejects.toThrow();

    // Priced before it is committed, so nothing was written.
    const after = await carts.price(cartId);
    expect(after.lines[0]!.options).toEqual(target.options);
  });
});

/** The same, over HTTP, which is what the page actually calls. */
describe("editing a line over HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const services = createServices();
    server = createServer(services).listen(0);
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

  it("rewrites the middle line and leaves the order alone", async () => {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    for (const itemId of ["fish-dory-classic", "drink-teh-ais", "fish-dory-classic"]) {
      await call("POST", `/api/carts/${cartId}/lines`, { itemId });
    }
    const before = (await json(await call("GET", `/api/carts/${cartId}`))).cart;
    const middle = before.lines[1];

    const menu = await json(await call("GET", "/api/menu"));
    const item = menu.categories.flatMap((c: any) => c.items).find((i: any) => i.id === middle.itemId);
    const group = item.optionGroups.find((g: any) => g.choices.length > 1);

    const response = await call("PATCH", `/api/carts/${cartId}/lines/${middle.lineId}`, {
      quantity: 2,
      selections: [{ groupId: group.id, choiceId: group.choices[1].id }],
    });
    expect(response.status).toBe(200);

    const after = (await json(response)).cart;
    expect(after.lines.map((line: any) => line.lineId)).toEqual(before.lines.map((line: any) => line.lineId));
    expect(after.lines[1].quantity).toBe(2);
    expect(after.lines[1].options[0].choiceId).toBe(group.choices[1].id);
  });

  it("still takes a bare quantity, exactly as the stepper sends it", async () => {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const line = (await json(await call("GET", `/api/carts/${cartId}`))).cart.lines[0];

    const body = await json(await call("PATCH", `/api/carts/${cartId}/lines/${line.lineId}`, { quantity: 3 }));
    expect(body.cart.lines[0].quantity).toBe(3);

    // Including the shorthand the stepper relies on at one: zero removes it.
    const emptied = await json(await call("PATCH", `/api/carts/${cartId}/lines/${line.lineId}`, { quantity: 0 }));
    expect(emptied.cart.lines).toHaveLength(0);
  });

  it("refuses an edit with nothing in it", async () => {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const line = (await json(await call("GET", `/api/carts/${cartId}`))).cart.lines[0];

    expect((await call("PATCH", `/api/carts/${cartId}/lines/${line.lineId}`, {})).status).toBe(400);
  });
});
