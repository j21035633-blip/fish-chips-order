import { MongoClient, type Collection, type Db, type Filter } from "mongodb";

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

type StoredCart = Cart & { _id: string; expiresAt: Date };
type StoredOrder = Order & { _id: string };

export class MongoStorage {
  readonly kind = "mongodb" as const;
  private readonly client: MongoClient;
  readonly db: Db;

  constructor(uri: string, dbName: string) {
    // `undefined` means "absent", not "null" — the domain types use optional
    // properties and a null read back would not satisfy them.
    this.client = new MongoClient(uri, { ignoreUndefined: true });
    this.db = this.client.db(dbName);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.ensureIndexes();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  carts(): CartRepository {
    return new MongoCartRepository(this.db.collection<StoredCart>("carts"));
  }

  orders(): OrderRepository {
    return new MongoOrderRepository(this.db.collection<StoredOrder>("orders"));
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
  }
}

class MongoCartRepository implements CartRepository {
  constructor(private readonly carts: Collection<StoredCart>) {}

  async get(cartId: string): Promise<Cart | undefined> {
    const doc = await this.carts.findOne({ _id: cartId });
    return doc === null ? undefined : toCart(doc);
  }

  async save(cart: Cart): Promise<void> {
    const document: StoredCart = {
      ...cart,
      _id: cart.id,
      expiresAt: new Date(Date.now() + CART_TTL_SECONDS * 1000),
    };
    await this.carts.replaceOne({ _id: cart.id }, document, { upsert: true });
  }

  async delete(cartId: string): Promise<void> {
    await this.carts.deleteOne({ _id: cartId });
  }
}

class MongoOrderRepository implements OrderRepository {
  constructor(private readonly orders: Collection<StoredOrder>) {}

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
    await this.orders.replaceOne({ _id: order.id }, document, { upsert: true });
  }

  async all(): Promise<Order[]> {
    const docs = await this.orders.find({}).sort({ createdAt: -1 }).toArray();
    return docs.map(toOrder);
  }

  private async one(filter: Filter<StoredOrder>): Promise<Order | undefined> {
    const doc = await this.orders.findOne(filter);
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
