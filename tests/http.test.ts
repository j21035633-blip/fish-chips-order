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
    await expect(res.json()).resolves.toEqual({ ok: true, phase: 2, storage: "memory", indexes: "ready" });
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
