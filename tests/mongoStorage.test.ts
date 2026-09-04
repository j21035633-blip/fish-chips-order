/**
 * Runs against a real mongod (downloaded and started by mongodb-memory-server),
 * not a mock. A fake would pass whatever shape we invented for it; the point of
 * these tests is that the driver, the indexes and the round-trip are real.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { menuService } from "../src/menu/service.js";
import { CartService, OrderService } from "../src/orders/service.js";
import type { OrderPayment } from "../src/orders/types.js";
import { MongoStorage } from "../src/storage/mongo.js";

let mongod: MongoMemoryServer;
let uri: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
}, 300_000);

afterAll(async () => {
  await mongod.stop();
});

/**
 * A whole application's worth of storage, wired the way `createServices` wires
 * it. Calling this twice against one database name is what a restart looks like:
 * new client, new services, no shared memory — same data.
 */
async function boot(dbName: string) {
  const storage = new MongoStorage(uri, dbName);
  await storage.connect();
  const carts = new CartService(storage.carts(), menuService);
  const orders = new OrderService(storage.orders(), carts, menuService);
  return { storage, carts, orders };
}

const aPayment = (providerPaymentId: string): OrderPayment => ({
  method: "card",
  provider: "stripe",
  providerPaymentId,
  status: "pending",
  simulated: false,
  checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
  createdAt: new Date().toISOString(),
});

describe("MongoStorage", () => {
  it("keeps an order, its payment and its total across a restart", async () => {
    const db = "restart_order";

    const first = await boot(db);
    const cart = await first.carts.create();
    await first.carts.addLine(cart.id, { itemId: "fish-dory-classic", quantity: 2 });
    const order = await first.orders.confirm({ cartId: cart.id, customerName: "Aisyah" });
    await first.orders.attachPayment(order.id, aPayment("cs_test_restart"));
    await first.orders.markPaid(order.id);
    // The process goes away. Every map, cache and connection in it goes too.
    await first.storage.close();

    const second = await boot(db);
    const recovered = await second.orders.get(order.id);

    expect(recovered.reference).toBe(order.reference);
    expect(recovered.paymentStatus).toBe("paid");
    expect(recovered.totalSen).toBe(order.totalSen);
    expect(recovered.total).toBe(order.total);
    expect(recovered.customerName).toBe("Aisyah");
    expect(recovered.lines).toHaveLength(1);
    expect(recovered.lines[0]!.quantity).toBe(2);
    expect(recovered.payment?.providerPaymentId).toBe("cs_test_restart");
    expect(recovered.payment?.status).toBe("paid");
    expect(recovered.payment?.paidAt).toBeDefined();
    await second.storage.close();
  });

  it("still finds an order by reference and by payment id after a restart", async () => {
    const db = "restart_lookup";

    const first = await boot(db);
    const cart = await first.carts.create();
    await first.carts.addLine(cart.id, { itemId: "chips-classic" });
    const order = await first.orders.confirm({ cartId: cart.id });
    await first.orders.attachPayment(order.id, aPayment("cs_test_lookup"));
    await first.storage.close();

    // Both lookups back the webhook path, which is the one that must not lose an
    // order: a provider retrying after a redeploy has only these two keys.
    const second = await boot(db);
    expect((await second.orders.findByReference(order.reference))?.id).toBe(order.id);
    expect((await second.orders.findByReference(order.reference.toLowerCase()))?.id).toBe(order.id);
    expect((await second.orders.findByProviderPaymentId("cs_test_lookup"))?.id).toBe(order.id);
    expect(await second.orders.findByProviderPaymentId("cs_test_missing")).toBeUndefined();
    await second.storage.close();
  });

  it("keeps a cart across a restart and hands back only the domain shape", async () => {
    const db = "restart_cart";

    const first = await boot(db);
    const cart = await first.carts.create();
    await first.carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    await first.storage.close();

    const second = await boot(db);
    const recovered = await second.carts.get(cart.id);

    expect(recovered.id).toBe(cart.id);
    expect(recovered.lines).toHaveLength(1);
    // Storage-only fields must not leak into the domain object.
    expect(recovered).not.toHaveProperty("_id");
    expect(recovered).not.toHaveProperty("expiresAt");
    await second.storage.close();
  });

  it("upserts, so saving the same order twice leaves one row", async () => {
    const db = "upsert";
    const { storage, carts, orders } = await boot(db);

    const cart = await carts.create();
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    const order = await orders.confirm({ cartId: cart.id });
    await orders.attachPayment(order.id, aPayment("cs_test_upsert"));
    await orders.markPaid(order.id);

    const rows = storage.db.collection<{ _id: string }>("orders");
    expect(await rows.countDocuments({ _id: order.id })).toBe(1);
    await storage.close();
  });

  it("refuses two orders with the same reference", async () => {
    const db = "unique_reference";
    const { storage, orders } = await boot(db);

    const rows = storage.db.collection<{ _id: string; reference: string }>("orders");
    await rows.insertOne({ _id: "o1", reference: "AB-1234" });

    await expect(rows.insertOne({ _id: "o2", reference: "AB-1234" })).rejects.toThrow(/duplicate key/i);

    expect(await orders.findByReference("AB-1234")).toBeDefined();
    await storage.close();
  });

  // Index creation used to be part of "connected", so a database user without
  // index privileges was indistinguishable from an unreachable database — and
  // took the process down with it — while reads and writes worked fine.
  it("stays usable when index creation is refused", async () => {
    const storage = new MongoStorage(uri, "index_failure");
    // Stand in for a user that may read and write but may not create indexes.
    const denied = Object.assign(new Error("not authorized on index_failure to execute command"), {
      code: 13,
    });
    const original = storage.db.collection("orders").createIndex;
    storage.db.createIndex = (() => Promise.reject(denied)) as never;
    const collection = storage.db.collection.bind(storage.db);
    storage.db.collection = ((name: string) => {
      const target = collection(name);
      target.createIndex = (() => Promise.reject(denied)) as never;
      return target;
    }) as never;

    await storage.connect();

    expect(storage.ready).toBe(true);
    expect(storage.indexes).toBe("failed");

    // The point: orders still store and read back.
    const orders = storage.orders();
    const now = new Date().toISOString();
    await orders.save({
      id: "o-noindex",
      reference: "NX-0001",
      lines: [],
      itemCount: 0,
      subtotalSen: 0,
      taxSen: 0,
      totalSen: 0,
      taxRate: 0.1,
      subtotal: "RM0.00",
      tax: "RM0.00",
      total: "RM0.00",
      paymentStatus: "pending",
      kitchenStatus: "received",
      createdAt: now,
      updatedAt: now,
    });
    expect((await orders.get("o-noindex"))?.reference).toBe("NX-0001");
    expect(original).toBeDefined();
    await storage.close();
  });

  // A failed connect used to close the topology for good, so every retry after
  // the first threw MongoTopologyClosedError and the app could never recover
  // from a database that was merely slow to come up.
  it("recovers when the database only becomes reachable later", async () => {
    const port = 47654;
    const storage = new MongoStorage(`mongodb://127.0.0.1:${port}`, "late_start");

    await expect(storage.connect()).rejects.toThrow();
    expect(storage.ready).toBe(false);
    // A second attempt must fail the same way, not with "Topology is closed".
    await expect(storage.connect()).rejects.toThrow(/Server selection timed out|ECONNREFUSED/);
    expect(storage.ready).toBe(false);

    const late = await MongoMemoryServer.create({ instance: { port } });
    try {
      await storage.connect();
      expect(storage.ready).toBe(true);

      // Repositories built before the connection existed still work.
      const orders = storage.orders();
      const now = new Date().toISOString();
      await orders.save({
        id: "o-late",
        reference: "LT-0001",
        lines: [],
        itemCount: 0,
        subtotalSen: 0,
        taxSen: 0,
        totalSen: 0,
        taxRate: 0.1,
        subtotal: "RM0.00",
        tax: "RM0.00",
        total: "RM0.00",
        paymentStatus: "pending",
        kitchenStatus: "received",
        createdAt: now,
        updatedAt: now,
      });
      expect((await orders.get("o-late"))?.reference).toBe("LT-0001");
    } finally {
      await storage.close();
      await late.stop();
    }
  }, 120_000);

  it("serves the staff board's queries", async () => {
    const db = "staff_queries";
    const { storage, carts, orders } = await boot(db);
    const repository = storage.orders();

    const cart = await carts.create("6");
    await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
    const order = await orders.confirm({ cartId: cart.id });
    await orders.attachPayment(order.id, aPayment("cs_staff"));
    const paid = (await orders.markPaid(order.id)).order;
    const paidAt = paid.payment!.paidAt!;

    // createdSince: the feed's window.
    expect((await repository.createdSince("2000-01-01T00:00:00.000Z")).map((o) => o.id)).toContain(order.id);
    expect(await repository.createdSince("2999-01-01T00:00:00.000Z")).toHaveLength(0);

    // paidBetween: half-open, keyed on when the money landed.
    const justAfter = new Date(new Date(paidAt).getTime() + 1).toISOString();
    expect((await repository.paidBetween(paidAt, justAfter)).map((o) => o.id)).toEqual([order.id]);
    expect(await repository.paidBetween(justAfter, "2999-01-01T00:00:00.000Z")).toHaveLength(0);
    // The lower bound is inclusive and the upper exclusive.
    expect(await repository.paidBetween("2000-01-01T00:00:00.000Z", paidAt)).toHaveLength(0);

    // Kitchen status survives the round trip.
    await orders.setKitchenStatus(order.id, "cooking");
    expect((await repository.get(order.id))?.kitchenStatus).toBe("cooking");

    await storage.close();
  });

  it("deletes a cart", async () => {
    const db = "cart_delete";
    const storage = new MongoStorage(uri, db);
    await storage.connect();
    const repository = storage.carts();

    const now = new Date().toISOString();
    await repository.save({ id: "c1", lines: [], createdAt: now, updatedAt: now });
    expect(await repository.get("c1")).toBeDefined();

    await repository.delete("c1");
    expect(await repository.get("c1")).toBeUndefined();
    await storage.close();
  });
});
