import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import { config } from "../src/config/env.js";
import { createServer } from "../src/http/app.js";
import { MenuService } from "../src/menu/service.js";
import { MenuStore, type MenuPersistence } from "../src/menu/store.js";
import type { Menu } from "../src/menu/types.js";
import { MenuValidationError } from "../src/menu/types.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { createPaymentService } from "../src/payments/service.js";

/** A 1×1 PNG. Small enough to inline, real enough that the mimetype is honest. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

let server: Server;
let base: string;
let app: Services;
let uploadsRoot: string;

function buildServices(): Services {
  const menuStore = new MenuStore();
  const menu = new MenuService(menuStore);
  const carts = new CartService(new InMemoryCartRepository(), menu);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menu);
  return {
    carts,
    orders,
    menu,
    menuStore,
    payments: createPaymentService(orders),
    storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} } as const,
  };
}

beforeAll(async () => {
  // Uploads land in a temp directory, not in the repo. `imageDir()` reads this
  // on every call and the static mount reads it at createServer time, so it has
  // to be set before the server is built.
  uploadsRoot = mkdtempSync(join(tmpdir(), "fish-chips-uploads-"));
  config.uploadsDir = uploadsRoot;

  app = buildServices();
  server = createServer(app).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(uploadsRoot, { recursive: true, force: true });
});

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** The staff form is multipart, so the tests send what the browser sends. */
function itemForm(fields: Record<string, string>, image?: { bytes: Buffer; type: string; name: string }): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  if (image) body.set("image", new Blob([new Uint8Array(image.bytes)], { type: image.type }), image.name);
  return body;
}

async function createItem(fields: Record<string, string> = {}, image?: Parameters<typeof itemForm>[1]) {
  const response = await fetch(`${base}/api/staff/menu-items`, {
    method: "POST",
    body: itemForm({ name: "Mushy Peas", priceSen: "450", category: "Sides", ...fields }, image),
  });
  return { response, body: await json(response) };
}

function uploadedFiles(): string[] {
  try {
    return readdirSync(join(uploadsRoot, "menu-items"));
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------- store

describe("menu store", () => {
  let store: MenuStore;

  beforeEach(() => {
    store = new MenuStore();
  });

  it("lists sold-out items, which the customer menu no longer hides", () => {
    const soldOut = store.items().filter((item) => !item.available);
    expect(soldOut.length).toBeGreaterThan(0);
  });

  it("adds an item under a brand-new section", async () => {
    const item = await store.create({ name: "Mushy Peas", priceSen: 450, category: "Sides & Dips" });

    expect(item).toMatchObject({ name: "Mushy Peas", priceSen: 450, categoryId: "sides-dips", available: true });
    expect(store.categories().map((category) => category.id)).toContain("sides-dips");
    // Named as typed, so the customer menu shows the shop's own wording.
    expect(store.categories().find((category) => category.id === "sides-dips")?.name).toBe("Sides & Dips");
  });

  it("reuses a section rather than creating a near-duplicate", async () => {
    await store.create({ name: "Mushy Peas", priceSen: 450, category: "Sides" });
    const second = await store.create({ name: "Curry Sauce", priceSen: 300, category: " sides " });

    expect(second.categoryId).toBe("sides");
    expect(store.categories().filter((category) => category.id === "sides")).toHaveLength(1);
  });

  it("patches only what was sent", async () => {
    const item = await store.create({
      name: "Mushy Peas",
      priceSen: 450,
      category: "Sides",
      description: "Proper ones.",
    });

    const updated = await store.update(item.id, { priceSen: 500 });
    expect(updated).toMatchObject({ priceSen: 500, name: "Mushy Peas", description: "Proper ones." });
  });

  it("toggles availability and nothing else", async () => {
    const item = await store.create({ name: "Mushy Peas", priceSen: 450, category: "Sides" });

    const off = await store.setAvailability(item.id, false);
    expect(off.available).toBe(false);
    expect(off.priceSen).toBe(450);

    // Turning it back on clears a reason that described the old state.
    await store.update(item.id, { unavailableReason: "Sold out for today" });
    const on = await store.setAvailability(item.id, true);
    expect(on.available).toBe(true);
    expect(on.unavailableReason).toBeUndefined();
  });

  it("drops a section once nothing is in it, keeping the four the shop opened with", async () => {
    const item = await store.create({ name: "Mushy Peas", priceSen: 450, category: "Sides" });
    await store.remove(item.id);

    const ids = store.categories().map((category) => category.id);
    expect(ids).not.toContain("sides");
    expect(ids).toEqual(expect.arrayContaining(["fish", "chips", "combos", "drinks"]));
  });

  it("bumps the version on every edit, so a cache cannot go stale", async () => {
    const before = store.load().version;
    await store.create({ name: "Mushy Peas", priceSen: 450, category: "Sides" });
    expect(store.load().version).not.toBe(before);
  });

  it("refuses what the form should not have sent", async () => {
    const cases: Parameters<MenuStore["create"]>[0][] = [
      { name: "  ", priceSen: 450, category: "Sides" },
      { name: "Peas", category: "Sides" },
      { name: "Peas", priceSen: 4.5, category: "Sides" },
      { name: "Peas", priceSen: -1, category: "Sides" },
      { name: "Peas", priceSen: 450, category: "!!!" },
      { name: "x".repeat(81), priceSen: 450, category: "Sides" },
    ];

    for (const input of cases) {
      await expect(store.create(input), JSON.stringify(input)).rejects.toThrow(MenuValidationError);
    }
    await expect(store.update("nope", { priceSen: 1 })).rejects.toThrow(/No menu item/);
  });

  it("writes through to persistence, and adopts what is already there", async () => {
    let saved: Menu | undefined;
    const persistence: MenuPersistence = {
      async load() {
        return saved;
      },
      async save(menu) {
        saved = structuredClone(menu);
      },
    };

    // First boot: nothing stored, so the seed menu is written.
    const first = new MenuStore(persistence);
    await first.hydrate();
    expect(saved?.items.length).toBeGreaterThan(0);

    await first.create({ name: "Mushy Peas", priceSen: 450, category: "Sides" });
    expect(saved?.items.some((item) => item.name === "Mushy Peas")).toBe(true);

    // Second boot: the edit is what comes back, not the seed.
    const second = new MenuStore(persistence);
    await second.hydrate();
    expect(second.items().some((item) => item.name === "Mushy Peas")).toBe(true);
  });

  it("keeps serving the seed menu when there is no database", async () => {
    const store = new MenuStore();
    await store.hydrate();
    expect(store.items().length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------- http

describe("staff menu api", () => {
  it("lists every item, sold-out ones included, with the sections in use", async () => {
    const listed = await json(await fetch(`${base}/api/staff/menu-items`));

    expect(listed.items.length).toBeGreaterThan(10);
    expect(listed.items.some((item: { available: boolean }) => !item.available)).toBe(true);
    // Formatted price, like everywhere else this API hands out money.
    expect(listed.items[0]).toMatchObject({ price: expect.stringMatching(/^RM/) });
    expect(listed.categories.map((category: { id: string }) => category.id)).toEqual(
      expect.arrayContaining(["fish", "chips", "combos", "drinks"]),
    );
    expect(listed.categories[0]).toMatchObject({ itemCount: expect.any(Number) });
  });

  it("creates an item from the form, with no image", async () => {
    const { response, body } = await createItem({ name: "Mushy Peas", description: "Proper ones." });

    expect(response.status).toBe(201);
    expect(body.item).toMatchObject({
      name: "Mushy Peas",
      description: "Proper ones.",
      priceSen: 450,
      price: "RM4.50",
      categoryId: "sides",
      available: true,
    });
    expect(body.item.imageUrl).toBeUndefined();
  });

  it("stores an uploaded image and serves it back", async () => {
    const { body } = await createItem({ name: "Battered Sausage" }, {
      bytes: PNG,
      type: "image/png",
      name: "sausage.png",
    });

    // The stored path is the served one, and never the uploaded filename.
    expect(body.item.imageUrl).toMatch(/^\/uploads\/menu-items\/[0-9a-f-]+\.png$/);
    expect(body.item.imageUrl).not.toContain("sausage");

    const served = await fetch(`${base}${body.item.imageUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("replaces an image and removes the file it replaced", async () => {
    const { body: created } = await createItem({ name: "Fishcake" }, {
      bytes: PNG,
      type: "image/png",
      name: "one.png",
    });
    const first = created.item.imageUrl as string;

    const updated = await json(
      await fetch(`${base}/api/staff/menu-items/${created.item.id}`, {
        method: "PUT",
        body: itemForm({}, { bytes: PNG, type: "image/png", name: "two.png" }),
      }),
    );

    expect(updated.item.imageUrl).not.toBe(first);
    expect((await fetch(`${base}${first}`)).status).toBe(404);
    expect((await fetch(`${base}${updated.item.imageUrl}`)).status).toBe(200);
  });

  it("clears an image on request, without needing a replacement", async () => {
    const { body: created } = await createItem({ name: "Scampi" }, {
      bytes: PNG,
      type: "image/png",
      name: "scampi.png",
    });

    const cleared = await json(
      await fetch(`${base}/api/staff/menu-items/${created.item.id}`, {
        method: "PUT",
        body: itemForm({ removeImage: "true" }),
      }),
    );

    expect(cleared.item.imageUrl).toBeUndefined();
    expect((await fetch(`${base}${created.item.imageUrl}`)).status).toBe(404);
  });

  it("patches any field over PUT, leaving the rest alone", async () => {
    const { body: created } = await createItem({ name: "Onion Rings", description: "Six of them." });

    const updated = await json(
      await fetch(`${base}/api/staff/menu-items/${created.item.id}`, {
        method: "PUT",
        body: itemForm({ priceSen: "600", category: "Starters" }),
      }),
    );

    expect(updated.item).toMatchObject({ priceSen: 600, categoryId: "starters", description: "Six of them." });
    expect(updated.item.name).toBe("Onion Rings");
  });

  it("toggles availability and refuses to carry anything else with it", async () => {
    const { body: created } = await createItem({ name: "Pickled Egg", priceSen: "200" });

    const off = await fetch(`${base}/api/staff/menu-items/${created.item.id}/availability`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: false, priceSen: 999999, name: "Nope" }),
    });
    expect(off.status).toBe(200);
    // The extra fields are simply not read — the endpoint knows one field.
    await expect(off.json()).resolves.toMatchObject({
      item: { available: false, priceSen: 200, name: "Pickled Egg" },
    });

    const bad = await fetch(`${base}/api/staff/menu-items/${created.item.id}/availability`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: "maybe" }),
    });
    expect(bad.status).toBe(400);
  });

  it("deletes an item and its image", async () => {
    const { body: created } = await createItem({ name: "Saveloy" }, {
      bytes: PNG,
      type: "image/png",
      name: "saveloy.png",
    });

    const deleted = await fetch(`${base}/api/staff/menu-items/${created.item.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: true, id: created.item.id });

    expect((await fetch(`${base}${created.item.imageUrl}`)).status).toBe(404);
    const listed = await json(await fetch(`${base}/api/staff/menu-items`));
    expect(listed.items.some((item: { id: string }) => item.id === created.item.id)).toBe(false);
  });

  it("404s on an item that is not there", async () => {
    for (const [method, path] of [
      ["PUT", "/api/staff/menu-items/nope"],
      ["DELETE", "/api/staff/menu-items/nope"],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        ...(method === "PUT" ? { body: itemForm({ priceSen: "100" }) } : {}),
      });
      expect(response.status, method).toBe(404);
      await expect(response.json(), method).resolves.toMatchObject({ error: "unknown_menu_item" });
    }

    const availability = await fetch(`${base}/api/staff/menu-items/nope/availability`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: true }),
    });
    expect(availability.status).toBe(404);
  });

  it("says what is wrong with the form rather than failing generically", async () => {
    const missingName = await fetch(`${base}/api/staff/menu-items`, {
      method: "POST",
      body: itemForm({ priceSen: "450", category: "Sides" }),
    });
    expect(missingName.status).toBe(400);
    await expect(missingName.json()).resolves.toMatchObject({ error: "missing_field", details: { field: "name" } });

    const badPrice = await fetch(`${base}/api/staff/menu-items`, {
      method: "POST",
      body: itemForm({ name: "Peas", priceSen: "4.50", category: "Sides" }),
    });
    expect(badPrice.status).toBe(400);
    await expect(badPrice.json()).resolves.toMatchObject({ error: "invalid_price" });
  });

  it("refuses a file that is not an image, and keeps nothing on disk", async () => {
    const before = uploadedFiles().length;

    const response = await fetch(`${base}/api/staff/menu-items`, {
      method: "POST",
      body: itemForm({ name: "Trouble", priceSen: "100", category: "Sides" }, {
        bytes: Buffer.from("%PDF-1.4 not an image"),
        type: "application/pdf",
        name: "invoice.pdf",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unsupported_image_type" });
    // Rejected in the filter, so multer never wrote it.
    expect(uploadedFiles()).toHaveLength(before);
  });

  it("refuses an image over the size limit", async () => {
    const before = uploadedFiles().length;

    const response = await fetch(`${base}/api/staff/menu-items`, {
      method: "POST",
      body: itemForm({ name: "Enormous", priceSen: "100", category: "Sides" }, {
        // Just over the 5 MB limit. Multer aborts mid-stream, so the partial
        // file it had started has to be gone as well.
        bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
        type: "image/png",
        name: "huge.png",
      }),
    }).catch((error: unknown) => error as Error);

    // Node's fetch may surface the aborted upload as a network error instead of
    // a response; either way the request must not have created an item.
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_upload", code: "LIMIT_FILE_SIZE" });
    }

    const listed = await json(await fetch(`${base}/api/staff/menu-items`));
    expect(listed.items.some((item: { name: string }) => item.name === "Enormous")).toBe(false);
    expect(uploadedFiles()).toHaveLength(before);
  });

  it("does not leave an orphaned upload when the fields are rejected", async () => {
    const before = uploadedFiles().length;

    // The file is written before the fields are validated, so the handler has
    // to clean up after itself.
    const response = await fetch(`${base}/api/staff/menu-items`, {
      method: "POST",
      body: itemForm({ priceSen: "450", category: "Sides" }, { bytes: PNG, type: "image/png", name: "x.png" }),
    });

    expect(response.status).toBe(400);
    expect(uploadedFiles()).toHaveLength(before);
  });
});

// ---------------------------------------------------------- public spillover

describe("the customer menu after a staff edit", () => {
  it("lists sold-out items, with category and availability on each", async () => {
    const body = await json(await fetch(`${base}/api/menu`));
    const items = body.categories.flatMap((category: { items: unknown[] }) => category.items) as {
      categoryId: string;
      available: boolean;
    }[];

    // The whole point: the customer app needs them to show as disabled.
    expect(items.some((item) => !item.available)).toBe(true);
    for (const item of items) {
      expect(item.categoryId).toBeTruthy();
      expect(typeof item.available).toBe("boolean");
    }
  });

  it("shows a newly added item, in its own section, straight away", async () => {
    const { body: created } = await createItem({ name: "Deep-Fried Mars Bar", category: "Puddings" });

    const body = await json(await fetch(`${base}/api/menu`));
    const puddings = body.categories.find((category: { id: string }) => category.id === "puddings");

    expect(puddings?.name).toBe("Puddings");
    expect(puddings?.items.map((item: { id: string }) => item.id)).toContain(created.item.id);
  });

  it("keeps a sold-out item listed but unorderable", async () => {
    const { body: created } = await createItem({ name: "Rock & Chips" });
    await fetch(`${base}/api/staff/menu-items/${created.item.id}/availability`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ available: false }),
    });

    const body = await json(await fetch(`${base}/api/menu`));
    const listed = body.categories
      .flatMap((category: { items: { id: string; available: boolean }[] }) => category.items)
      .find((item: { id: string }) => item.id === created.item.id);
    expect(listed).toMatchObject({ available: false });

    // Listed, but pricing still refuses it — the board is not the gate, the menu is.
    const cart = await json(
      await fetch(`${base}/api/carts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const added = await fetch(`${base}/api/carts/${cart.cartId}/lines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: created.item.id }),
    });
    expect(added.status).toBe(400);
    await expect(added.json()).resolves.toMatchObject({ error: "item_unavailable" });
  });

  it("still hides sold-out items from the agent, which must not offer them", async () => {
    const body = await json(
      await fetch(`${base}/api/tools/get_menu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const items = body.categories.flatMap((category: { items: { available: boolean }[] }) => category.items);

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item: { available: boolean }) => item.available)).toBe(true);
  });
});
