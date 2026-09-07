import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/http/app.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (path: string) => fetch(`${base}${path}`);

/** Response bodies are checked field by field in the assertions below. */
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("menu api", async () => {
  it("serves health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      phase: 2,
      storage: "memory",
      indexes: "ready",
      staffAuth: "disabled",
    });
  });

  it("serves the full menu", async () => {
    const res = await get("/api/menu");
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.shopName).toBe("Anchor & Batter");
    expect(body.currency).toBe("MYR");
    expect(body.categories).toHaveLength(4);
    expect(body.text).toContain("Fish");
  });

  it("accepts a comma-separated allergen list", async () => {
    const res = await get("/api/menu?exclude=milk,egg");
    const body = await json(res);

    for (const item of body.categories.flatMap((c: { items: unknown[] }) => c.items)) {
      expect((item as { allergens: string[] }).allergens).not.toContain("milk");
    }
    expect(body.withheld.length).toBeGreaterThan(0);
  });

  it("accepts a repeated query param", async () => {
    const res = await get("/api/menu?category=fish&category=drinks");
    const body = await json(res);
    expect(body.categories.map((c: { id: string }) => c.id)).toEqual(["fish", "drinks"]);
  });

  it("400s on an unknown allergen instead of silently ignoring it", async () => {
    const res = await get("/api/menu?exclude=peanutbutter");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("400s on a non-numeric price cap", async () => {
    const res = await get("/api/menu?maxPriceSen=cheap");
    expect(res.status).toBe(400);
  });

  it("serves one item", async () => {
    const res = await get("/api/menu/items/fish-cod-premium");
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.item.name).toBe("North Atlantic Cod");
    expect(body.item.price).toBe("RM28.90");
  });

  it("404s an unknown item", async () => {
    const res = await get("/api/menu/items/fish-unicorn");
    expect(res.status).toBe(404);
  });

  it("serves suggestions", async () => {
    const res = await get("/api/menu/suggestions?limit=2");
    const body = await json(res);
    expect(body.suggestions).toHaveLength(2);
    expect(body.text).toContain("signature");
  });

  it("invokes a tool by name", async () => {
    const res = await fetch(`${base}/api/tools/get_menu`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories: ["chips"] }),
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.categories).toHaveLength(1);
  });

  it("404s an unknown tool", async () => {
    const res = await fetch(`${base}/api/tools/order_everything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

/**
 * The play endpoint, over real HTTP, from the position of somebody trying to
 * cheat it.
 *
 * The reel score is the one thing a browser is now trusted to report, and this
 * is where that trust is bounded: it may tilt the odds and it may do nothing
 * else. Everything below is an attempt to reach past it to the outcome.
 */
describe("the fishing play endpoint decides the outcome itself", () => {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** A cart with one earned chance on it, the honest way. */
  async function cartWithAChance(): Promise<string> {
    const { cartId } = await json(await post("/api/carts", {}));
    await post(`/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const registered = await post("/api/order/chances/register", {
      cartId,
      contact: "player@example.com",
    });
    expect(registered.status).toBe(200);
    return cartId;
  }

  const TIERS = ["small_fry", "uncommon", "rare", "jackpot"];

  it("ignores a tier, a label and a discount posted alongside the play", async () => {
    // Everything a hopeful client might try to smuggle in. None of it is read:
    // the schema takes two fields and the roll happens server-side.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const cartId = await cartWithAChance();
      const response = await post("/api/order/fish/play", {
        cartId,
        performance: 0,
        tier: "jackpot",
        reward: { tier: "jackpot", kind: "discount_fixed", label: "RM1000 off", amountSen: 100_000 },
        discountSen: 100_000,
        amountSen: 100_000,
      });

      expect(response.status).toBe(200);
      const body = await json(response);

      expect(TIERS).toContain(body.reward.tier);
      expect(body.reward.amountSen ?? 0).toBeLessThanOrEqual(1000);
      expect(body.reward.label).not.toContain("1000");
      // And the cart's own total was never touched by the numbers in the body.
      expect(body.cart.discountSen).toBeLessThanOrEqual(body.cart.subtotalSen);
    }
  });

  it("still pays out a real reward when the reel was hopeless", async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const cartId = await cartWithAChance();
      const body = await json(await post("/api/order/fish/play", { cartId, performance: 0 }));

      expect(TIERS).toContain(body.reward.tier);
      expect(typeof body.reward.label).toBe("string");
      expect(body.reward.label.length).toBeGreaterThan(0);
      // A discount, or a free line. Never nothing.
      const freeLine = body.cart.lines.some((line: any) => line.unitPriceSen === 0);
      expect(body.cart.discountSen > 0 || freeLine, `${body.reward.tier} paid nothing`).toBe(true);
    }
  });

  it("takes a nonsense score as a bad reel rather than refusing the play", async () => {
    // Refusing would cost somebody the chance they earned by leaving a review,
    // which is a far worse failure than a worse roll.
    for (const performance of [-99, 5000, "sneaky", null, {}, Number.NaN]) {
      const cartId = await cartWithAChance();
      const response = await post("/api/order/fish/play", { cartId, performance });

      expect(`${JSON.stringify(performance)} -> ${response.status}`).toBe(
        `${JSON.stringify(performance)} -> 200`,
      );
      await expect(json(response)).resolves.toMatchObject({ reward: { tier: expect.any(String) } });
    }
  });

  it("plays fine with no score at all, as an older cached page would send", async () => {
    const cartId = await cartWithAChance();
    const body = await json(await post("/api/order/fish/play", { cartId }));

    expect(TIERS).toContain(body.reward.tier);
  });

  it("spends the chance once, whatever the score claims", async () => {
    const cartId = await cartWithAChance();

    expect((await post("/api/order/fish/play", { cartId, performance: 100 })).status).toBe(200);

    const second = await post("/api/order/fish/play", { cartId, performance: 100 });
    expect(second.status).toBe(400);
    await expect(json(second)).resolves.toMatchObject({ error: "no_chances" });
  });

  it("produces both extremes of the table over many honest plays", async () => {
    // Not a distribution assertion — that is unit-tested against a seeded
    // generator. This only proves the endpoint is really rolling, rather than
    // returning the same tier every time.
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const cartId = await cartWithAChance();
      const body = await json(await post("/api/order/fish/play", { cartId, performance: 100 }));
      seen.add(body.reward.tier);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
