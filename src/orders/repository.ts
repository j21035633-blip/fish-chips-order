import type { Cart, Order } from "./types.js";

/**
 * Storage for carts and orders.
 *
 * In-memory for Phase 2 — the shop runs one process and an abandoned cart is
 * worth nothing. Both interfaces exist so swapping in SQLite (or the POS, for
 * orders) is a constructor change and nothing more, the same way
 * `MenuRepository` is written.
 */

export interface CartRepository {
  get(cartId: string): Cart | undefined;
  save(cart: Cart): void;
  delete(cartId: string): void;
}

export interface OrderRepository {
  get(orderId: string): Order | undefined;
  findByReference(reference: string): Order | undefined;
  /** Look an order up from a provider's payment id, for webhook handling. */
  findByProviderPaymentId(providerPaymentId: string): Order | undefined;
  save(order: Order): void;
  all(): Order[];
}

export class InMemoryCartRepository implements CartRepository {
  private readonly carts = new Map<string, Cart>();

  get(cartId: string): Cart | undefined {
    return this.carts.get(cartId);
  }

  save(cart: Cart): void {
    this.carts.set(cart.id, cart);
  }

  delete(cartId: string): void {
    this.carts.delete(cartId);
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  findByReference(reference: string): Order | undefined {
    const wanted = reference.toUpperCase();
    return this.all().find((order) => order.reference === wanted);
  }

  findByProviderPaymentId(providerPaymentId: string): Order | undefined {
    return this.all().find((order) => order.payment?.providerPaymentId === providerPaymentId);
  }

  save(order: Order): void {
    this.orders.set(order.id, order);
  }

  all(): Order[] {
    return [...this.orders.values()];
  }
}
