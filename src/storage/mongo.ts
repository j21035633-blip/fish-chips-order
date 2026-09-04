import { MongoClient, type Collection, type Db, type Filter } from "mongodb";

import type { MenuPersistence } from "../menu/store.js";
import type { Menu } from "../menu/types.js";
import type { CartRepository, OrderRepository } from "../orders/repository.js";
import type { Cart, Order } from "../orders/types.js";

/**
 * MongoDB-backed storage.
 *
 * Documents are keyed by the domain id, so `_id` *is* `order.id` and every write
 * is an idempotent upsert — a retried save cannot produce a second row.
 * Timestamps stay ISO strings, exactly as the domain types hold them, so a
 * document round-trips through the database unchanged.
 *
 * `db` is public on purpose: the game and voucher collections a later phase adds
 * hang off the same connection rather than opening their own.
 */

/** An untouched cart is worth nothing; let Mongo reap it. Orders never expire. */
const CART_TTL_SECONDS = 24 * 60 * 60;

export type IndexState = "pending" | "ready" | "failed";

type StoredCart = Cart & { _id: string; expiresAt: Date };
type StoredOrder = Order & { _id: string };
type StoredMenu = Menu & { _id: string };

/**
 * The menu is one document under a fixed id. Staff edits replace it wholesale,
 * so there is exactly one row and no chance of items and categories disagreeing.
 */
const MENU_DOC_ID = "current";

export class MongoStorage {
  readonly kind = "mongodb" as const;
  private client: MongoClient;
  private database: Db;
  private connected = false;
  private attempted = false;
  private indexState: IndexState = "pending";

  constructor(
    private readonly uri: string,
    private readonly dbName: string,
  ) {
    this.client = this.newClient();
    this.database = this.client.db(dbName);
  }

  /** Future collections (game, vouchers) share this connection. */
  get db(): Db {
    return this.database;
  }

  get ready(): boolean {
    return this.connected;
  }

  get indexes(): IndexState {
    return this.indexState;
  }

  async connect(): Promise<void> {
    // A failed `connect` leaves the topology closed for good, so a retry on the
    // same client throws MongoTopologyClosedError forever. Start each attempt
    // after the first from a fresh client. Repositories resolve their collection
    // through `this.database` per call, so they follow the swap.
    if (this.attempted) {
      await this.client.close().catch(() => {});
      this.client = this.newClient();
      this.database = this.client.db(this.dbName);
    }
    this.attempted = true;

    await this.client.connect();
    // `connect` can resolve without having spoken to a server. Ping, so "ready"
    // means the database actually answered.
    await this.database.command({ ping: 1 });
    this.connected = true;

    // Indexes are a constraint and an optimisation, not a precondition for
    // storing an order. Letting a failure here mark the whole database
    // unreachable made a permissions problem look identical to an outage — and
    // took the process down with it — while reads and writes worked fine.
    try {
      await this.ensureIndexes();
      this.indexState = "ready";
    } catch (error) {
      this.indexState = "failed";
      console.error(
        `[storage] connected, but creating indexes failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        "[storage] orders are being stored, but the unique index on `reference` is not in place, " +
          "so two orders could in principle share a counter code. Usually the database user lacks " +
          "index privileges, or an index of the same name already exists with different options.",
      );
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.client.close();
  }

  carts(): CartRepository {
    return new MongoCartRepository(() => this.database.collection<StoredCart>("carts"));
  }

  orders(): OrderRepository {
    return new MongoOrderRepository(() => this.database.collection<StoredOrder>("orders"));
  }

  menu(): MenuPersistence {
    const collection = () => this.database.collection<StoredMenu>("menu");
    return {
      async load(): Promise<Menu | undefined> {
        const doc = await collection().findOne({ _id: MENU_DOC_ID });
        if (doc === null) return undefined;
        const { _id, ...menu } = doc;
        return menu;
      },
      async save(menu: Menu): Promise<void> {
        // The upsert takes _id from the filter, and the driver refuses it in
        // the replacement — so the document is stored under MENU_DOC_ID either way.
        await collection().replaceOne({ _id: MENU_DOC_ID }, menu, { upsert: true });
      },
    };
  }

  private newClient(): MongoClient {
    return new MongoClient(this.uri, {
      // `undefined` means "absent", not "null" — the domain types use optional
      // properties and a null read back would not satisfy them.
      ignoreUndefined: true,
      // Fail an attempt in seconds rather than the default half-minute; the
      // caller retries, and a slow failure just looks like a hang.
      serverSelectionTimeoutMS: 5_000,
    });
  }

  /**
   * Safe to run on every boot — `createIndex` is a no-op when the index already
   * matches. The reference index is unique because `nextReference` relies on a
   * lookup to avoid collisions, and a race between two processes would otherwise
   * hand the same code to two customers.
   */
  private async ensureIndexes(): Promise<void> {
    await this.db.collection("carts").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db.collection("orders").createIndex({ reference: 1 }, { unique: true });
    await this.db.collection("orders").createIndex({ "payment.providerPaymentId": 1 });
    await this.db.collection("orders").createIndex({ createdAt: -1 });
    await this.db.collection("orders").createIndex({ paymentStatus: 1, "payment.paidAt": 1 });
  }
}

class MongoCartRepository implements CartRepository {
  constructor(private readonly carts: () => Collection<StoredCart>) {}

  async get(cartId: string): Promise<Cart | undefined> {
    const doc = await this.carts().findOne({ _id: cartId });
    return doc === null ? undefined : toCart(doc);
  }

  async save(cart: Cart): Promise<void> {
    const document: StoredCart = {
      ...cart,
      _id: cart.id,
      expiresAt: new Date(Date.now() + CART_TTL_SECONDS * 1000),
    };
    await this.carts().replaceOne({ _id: cart.id }, document, { upsert: true });
  }

  async delete(cartId: string): Promise<void> {
    await this.carts().deleteOne({ _id: cartId });
  }
}

class MongoOrderRepository implements OrderRepository {
  constructor(private readonly orders: () => Collection<StoredOrder>) {}

  async get(orderId: string): Promise<Order | undefined> {
    return this.one({ _id: orderId });
  }

  async findByReference(reference: string): Promise<Order | undefined> {
    return this.one({ reference: reference.toUpperCase() });
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<Order | undefined> {
    return this.one({ "payment.providerPaymentId": providerPaymentId } as Filter<StoredOrder>);
  }

  async save(order: Order): Promise<void> {
    const document: StoredOrder = { ...order, _id: order.id };
    await this.orders().replaceOne({ _id: order.id }, document, { upsert: true });
  }

  async all(): Promise<Order[]> {
    const docs = await this.orders().find({}).sort({ createdAt: -1 }).toArray();
    return docs.map(toOrder);
  }

  async createdSince(iso: string): Promise<Order[]> {
    // ISO-8601 UTC strings sort lexicographically, so a string range is a time
    // range and the createdAt index serves it.
    const docs = await this.orders()
      .find({ createdAt: { $gte: iso } } as Filter<StoredOrder>)
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(toOrder);
  }

  async paidBetween(startIso: string, endIso: string): Promise<Order[]> {
    const docs = await this.orders()
      .find({
        paymentStatus: "paid",
        "payment.paidAt": { $gte: startIso, $lt: endIso },
      } as Filter<StoredOrder>)
      .toArray();
    return docs.map(toOrder);
  }

  private async one(filter: Filter<StoredOrder>): Promise<Order | undefined> {
    const doc = await this.orders().findOne(filter);
    return doc === null ? undefined : toOrder(doc);
  }
}

/** Strips the storage-only fields so callers only ever see the domain shape. */
function toCart(doc: StoredCart): Cart {
  const { _id, expiresAt, ...cart } = doc;
  return cart;
}

function toOrder(doc: StoredOrder): Order {
  const { _id, ...order } = doc;
  return order;
}
