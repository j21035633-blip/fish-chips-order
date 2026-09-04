/**
 * The fishing game: what it gives away, who it gives it to, and what the
 * customer is finally charged.
 *
 * The thread running through all of it is that the **server** decides. Nothing
 * a browser sends picks a tier, grants a chance, or moves a total.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryProofRepository, newProof, triggerFor } from "../src/game/proofs.js";
import { discountFor, REWARD_TABLE, rollTier, toReward, TOTAL_WEIGHT } from "../src/game/rewards.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { OrderValidationError, SPEND_CHANCE_THRESHOLD_SEN } from "../src/orders/types.js";
import { StripeAdapter } from "../src/payments/stripeAdapter.js";

let carts: CartService;
let orders: OrderService;
let proofs: InMemoryProofRepository;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
  proofs = new InMemoryProofRepository();
});

/** A cart with one dory in it — RM16.90, under the spend threshold. */
async function cartWithFish(): Promise<string> {
  const cart = await carts.create();
  await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return cart.id;
}

describe("the reward table", () => {
  it("has no miss in it", () => {
    // Every tier is worth something. Someone who earned a cast by leaving a
    // review should not be told they caught an old boot.
    for (const spec of REWARD_TABLE) {
      expect(spec.kind, spec.tier).toMatch(/^(discount_fixed|discount_percent|free_item)$/);
      const worth = spec.amountSen ?? spec.percent ?? (spec.itemId ? 1 : 0);
      expect(worth, spec.tier).toBeGreaterThan(0);
    }
  });

  it("weights add up to a whole, so the odds are the odds", () => {
    expect(TOTAL_WEIGHT).toBe(100);
    expect(REWARD_TABLE.map((spec) => spec.weight)).toEqual([55, 25, 15, 5]);
  });

  it("rolls each tier at roughly its configured weight", () => {
    // 40,000 trials against a seeded generator: enough that a mis-wired band
    // shows up as a fat deviation, few enough to stay a fast unit test.
    let seed = 123456789;
    const random = () => {
      // xorshift, so the sequence is deterministic and this never flakes.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };

    const trials = 40_000;
    const counts = new Map(REWARD_TABLE.map((spec) => [spec.tier, 0]));
    for (let index = 0; index < trials; index += 1) {
      const spec = rollTier(random);
      counts.set(spec.tier, counts.get(spec.tier)! + 1);
    }

    for (const spec of REWARD_TABLE) {
      const share = (counts.get(spec.tier)! / trials) * 100;
      // Within a point and a half of the configured weight.
      expect(Math.abs(share - spec.weight), `${spec.tier} came out at ${share.toFixed(2)}%`).toBeLessThan(1.5);
    }
  });

  it("picks the band the roll lands in, exactly at each boundary", () => {
    // 0 → the first tier; just under 0.55 → still the first; 0.55 → the second.
    expect(rollTier(() => 0).tier).toBe("small_fry");
    expect(rollTier(() => 0.5499).tier).toBe("small_fry");
    expect(rollTier(() => 0.55).tier).toBe("uncommon");
    expect(rollTier(() => 0.7999).tier).toBe("uncommon");
    expect(rollTier(() => 0.8).tier).toBe("rare");
    expect(rollTier(() => 0.95).tier).toBe("jackpot");
  });

  it("never discounts more than the order is worth", () => {
    // Two jackpots on a cheap order would otherwise owe the customer money.
    const rewards = [
      toReward(REWARD_TABLE[3]!, "r1", "now"),
      toReward(REWARD_TABLE[3]!, "r2", "now"),
    ];
    expect(discountFor(rewards, 500)).toBe(500);
    expect(discountFor(rewards, 5000)).toBe(2000);
  });
});

describe("earning a chance", () => {
  it("gives one for crossing the spend threshold, once", async () => {
    const cart = await carts.create();
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    expect((await carts.get(cart.id)).chances).toBe(0);

    // Over RM50 of food.
    await carts.addLine(cart.id, { itemId: "fish-dory-classic", quantity: 3 });
    const crossed = await carts.get(cart.id);
    expect(crossed.chances).toBe(1);
    expect(crossed.claimed).toContain("spend");

    // Adding more does not keep paying out.
    await carts.addLine(cart.id, { itemId: "chips-classic" });
    expect((await carts.get(cart.id)).chances).toBe(1);
  });

  it("does not award the spend chance below the threshold", async () => {
    const cartId = await cartWithFish();
    const priced = await carts.price(cartId);

    expect(priced.subtotalSen).toBeLessThan(SPEND_CHANCE_THRESHOLD_SEN);
    expect((await carts.get(cartId)).chances).toBe(0);
  });

  it("gives one for a contact, once, and stores exactly what was typed", async () => {
    const cartId = await cartWithFish();

    await carts.registerContact(cartId, "  012-3456789 ");
    const first = await carts.get(cartId);
    expect(first.chances).toBe(1);
    expect(first.contact).toBe("012-3456789");

    // A second registration is not an error and not a second chance.
    await carts.registerContact(cartId, "someone@example.com");
    const second = await carts.get(cartId);
    expect(second.chances).toBe(1);
    expect(second.contact).toBe("someone@example.com");
  });

  it("refuses an empty contact", async () => {
    const cartId = await cartWithFish();
    await expect(carts.registerContact(cartId, "   ")).rejects.toThrow(OrderValidationError);
  });

  it("holds a chance pending when a proof is submitted, and refuses a second of the same type", async () => {
    const cartId = await cartWithFish();

    await carts.holdChanceForProof(cartId, "review");
    const held = await carts.get(cartId);
    expect(held.chancesPending).toBe(1);
    // Pending is not spendable.
    expect(held.chances).toBe(0);

    await expect(carts.holdChanceForProof(cartId, "review")).rejects.toThrow(/already claimed/);
    // The other type is its own slot.
    await carts.holdChanceForProof(cartId, "share");
    expect((await carts.get(cartId)).chancesPending).toBe(2);
  });
});

describe("staff approval", () => {
  it("moves pending to available on approval", async () => {
    const cartId = await cartWithFish();
    await carts.holdChanceForProof(cartId, "review");

    await carts.approveChance(cartId);
    const approved = await carts.get(cartId);
    expect(approved.chancesPending).toBe(0);
    expect(approved.chances).toBe(1);
  });

  it("lands on the submitting session and on no other", async () => {
    // The thing that would be worst to get wrong: one customer's screenshot
    // handing a free drink to everybody in the shop.
    const mine = await cartWithFish();
    const theirs = await cartWithFish();

    await carts.holdChanceForProof(mine, "review");
    const proof = newProof({ cartId: mine, type: "review", imageUrl: "/uploads/proofs/a.png" });
    await proofs.save(proof);

    await carts.approveChance(proof.cartId);

    expect((await carts.get(mine)).chances).toBe(1);
    expect((await carts.get(theirs)).chances).toBe(0);
    expect((await carts.get(theirs)).chancesPending).toBe(0);
  });

  it("grants nothing on rejection, and frees the slot for another try", async () => {
    const cartId = await cartWithFish();
    await carts.holdChanceForProof(cartId, "share");

    await carts.rejectChance(cartId, triggerFor("share"));
    const rejected = await carts.get(cartId);
    expect(rejected.chances).toBe(0);
    expect(rejected.chancesPending).toBe(0);
    expect(rejected.claimed).not.toContain("share");

    // A better screenshot can be sent.
    await carts.holdChanceForProof(cartId, "share");
    expect((await carts.get(cartId)).chancesPending).toBe(1);
  });
});

describe("playing", () => {
  it("is refused with no chances", async () => {
    const cartId = await cartWithFish();
    await expect(carts.play(cartId)).rejects.toThrow(OrderValidationError);
    await expect(carts.play(cartId)).rejects.toThrow(/No chances/);
  });

  it("is refused when the only chance is still pending approval", async () => {
    const cartId = await cartWithFish();
    await carts.holdChanceForProof(cartId, "review");

    await expect(carts.play(cartId)).rejects.toThrow(/No chances/);
  });

  it("spends exactly one chance per cast", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");

    await carts.play(cartId, () => 0);
    const after = await carts.get(cartId);
    expect(after.chances).toBe(0);
    expect(after.chancesUsed).toBe(1);
    expect(after.rewards).toHaveLength(1);

    await expect(carts.play(cartId)).rejects.toThrow(/No chances/);
  });

  it("applies a fixed discount to the total, before tax", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");

    const { cart, reward } = await carts.play(cartId, () => 0); // small_fry
    expect(reward.tier).toBe("small_fry");
    expect(cart.subtotalSen).toBe(1690);
    expect(cart.discountSen).toBe(200);
    // Tax follows the money: 10% of what is actually being paid for.
    expect(cart.taxSen).toBe(149);
    expect(cart.totalSen).toBe(1490 + 149);
  });

  it("applies a percentage off the subtotal", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");

    const { cart } = await carts.play(cartId, () => 0.6); // uncommon, 10%
    expect(cart.discountSen).toBe(169);
    expect(cart.taxSen).toBe(Math.round((1690 - 169) * 0.1));
    expect(cart.totalSen).toBe(1690 - 169 + cart.taxSen);
  });

  it("adds a free item as a real line that costs nothing", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");

    const { cart, reward } = await carts.play(cartId, () => 0.85); // rare
    expect(reward.kind).toBe("free_item");

    const free = cart.lines.find((line) => line.itemId === reward.itemId);
    expect(free, "the free drink is on the order").toBeTruthy();
    expect(free!.lineTotalSen).toBe(0);
    // It is on the ticket, so the kitchen makes it — but it costs nothing.
    expect(cart.subtotalSen).toBe(1690);
    expect(cart.discountSen).toBe(0);
  });
});

describe("what the customer is finally charged", () => {
  /** Sums the line items in a Stripe Checkout Session's form body. */
  function sessionTotalSen(body: URLSearchParams): number {
    let total = 0;
    for (let index = 0; body.has(`line_items[${index}][price_data][unit_amount]`); index += 1) {
      total +=
        Number(body.get(`line_items[${index}][price_data][unit_amount]`)) *
        Number(body.get(`line_items[${index}][quantity]`));
    }
    return total;
  }

  it("charges the discounted total, not the pre-game one", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");
    const { cart: played } = await carts.play(cartId, () => 0); // RM2 off

    const order = await orders.confirm({ cartId });

    // The order carries the reward across from the cart, unchanged.
    expect(order.subtotalSen).toBe(played.subtotalSen);
    expect(order.discountSen).toBe(200);
    expect(order.totalSen).toBe(played.totalSen);
    expect(order.rewards).toHaveLength(1);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_1", url: "https://pay/x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new StripeAdapter(
      { secretKey: "sk_test_live", webhookSecret: "whsec", apiBase: "https://api.stripe.test" },
      "http://localhost:3000",
      fetchImpl as unknown as typeof fetch,
    );
    await adapter.createPayment({
      order,
      method: "card",
      returnUrl: "http://localhost:3000/r",
      cancelUrl: "http://localhost:3000/c",
      idempotencyKey: "k1",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);

    // The number that actually leaves for Stripe equals what the customer was
    // shown, discount and tax included.
    expect(sessionTotalSen(body)).toBe(order.totalSen);
    expect(sessionTotalSen(body)).toBeLessThan(order.subtotalSen + order.taxSen);
  });

  it("charges nothing for a free item, and the kitchen still sees it", async () => {
    const cartId = await cartWithFish();
    await carts.registerContact(cartId, "012-3456789");
    await carts.play(cartId, () => 0.85); // rare: a free drink

    const order = await orders.confirm({ cartId });
    const free = order.lines.find((line) => line.unitPriceSen === 0);

    expect(free, "the free line is on the kitchen ticket").toBeTruthy();
    expect(order.subtotalSen).toBe(1690);
    expect(order.totalSen).toBe(1690 + Math.round(1690 * 0.1));
  });
});
