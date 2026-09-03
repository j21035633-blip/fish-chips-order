import type { Cart, Order } from "./types.js";

/**
 * Storage for carts and orders.
 *
 * Async because the shipped implementation talks to MongoDB (see
 * `src/storage/mongo.ts`). The in-memory pair below is what tests use, and what
 * a local run falls back to when `MONGODB_URI` is unset.
 *
 * Both clone on the way in and out. A store that hands back live references lets
 * a caller mutate saved state without saving it, which works in memory and then
 * silently does nothing against a database — the in-memory pair has to behave
 * like a database or it is not a useful stand-in for one.
 */

export interface CartRepository {
  get(cartId: string): Promise<Cart | undefined>;
  save(cart: Cart): Promise<void>;
  delete(cartId: string): Promise<void>;
}

export interface OrderRepository {
  get(orderId: string): Promise<Order | undefined>;
  findByReference(reference: string): Promise<Order | undefined>;
  /** Look an order up from a provider's payment id, for webhook handling. */
  findByProviderPaymentId(providerPaymentId: string): Promise<Order | undefined>;
  save(order: Order): Promise<void>;
  all(): Promise<Order[]>;
  /** Orders placed at or after `iso`, newest first. The staff feed. */
  createdSince(iso: string): Promise<Order[]>;
  /**
   * Orders whose payment settled in `[startIso, endIso)`, for the daily total.
   *
   * Keyed on when the money landed, not when the order was placed: an order
   * taken at 23:55 and paid at 00:05 is tomorrow's takings.
   */
  paidBetween(startIso: string, endIso: string): Promise<Order[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryCartRepository implements CartRepository {
  private readonly carts = new Map<string, Cart>();

  async get(cartId: string): Promise<Cart | undefined> {
    const cart = this.carts.get(cartId);
    return cart === undefined ? undefined : copy(cart);
  }

  async save(cart: Cart): Promise<void> {
    this.carts.set(cart.id, copy(cart));
  }

  async delete(cartId: string): Promise<void> {
    this.carts.delete(cartId);
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async get(orderId: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    return order === undefined ? undefined : copy(order);
  }

  async findByReference(reference: string): Promise<Order | undefined> {
    const wanted = reference.toUpperCase();
    return this.find((order) => order.reference === wanted);
  }

  async findByProviderPaymentId(providerPaymentId: string): Promise<Order | undefined> {
    return this.find((order) => order.payment?.providerPaymentId === providerPaymentId);
  }

  async save(order: Order): Promise<void> {
    this.orders.set(order.id, copy(order));
  }

  async all(): Promise<Order[]> {
    return [...this.orders.values()].map(copy);
  }

  async createdSince(iso: string): Promise<Order[]> {
    return (await this.all())
      .filter((order) => order.createdAt >= iso)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async paidBetween(startIso: string, endIso: string): Promise<Order[]> {
    return (await this.all()).filter((order) => {
      if (order.paymentStatus !== "paid") return false;
      const settled = order.payment?.paidAt ?? order.updatedAt;
      return settled >= startIso && settled < endIso;
    });
  }

  private find(match: (order: Order) => boolean): Order | undefined {
    for (const order of this.orders.values()) {
      if (match(order)) return copy(order);
    }
    return undefined;
  }
}
