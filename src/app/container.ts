import { menuService } from "../menu/service.js";
import { config } from "../config/env.js";
import {
  InMemoryCartRepository,
  InMemoryOrderRepository,
  type CartRepository,
  type OrderRepository,
} from "../orders/repository.js";
import { CartService, OrderService } from "../orders/service.js";
import { createPaymentService, PaymentService } from "../payments/service.js";
import { MongoStorage, type IndexState } from "../storage/mongo.js";

/**
 * One place that wires the services together.
 *
 * `OrderService` and the HTTP layer must share the *same* `CartService`
 * instance — confirming an order clears the cart it came from, and two
 * instances would leave the browser's cart alive after checkout.
 */

/**
 * The lifecycle of whatever is behind the repositories. `kind` is reported on
 * `/health` so a deploy running on the in-memory fallback is visible rather than
 * silently losing orders.
 */
export interface Storage {
  readonly kind: "mongodb" | "memory";
  /** False while a configured database has not been reached yet. */
  readonly ready: boolean;
  /** Whether the indexes the schema relies on are in place. */
  readonly indexes: IndexState;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface Services {
  carts: CartService;
  orders: OrderService;
  payments: PaymentService;
  storage: Storage;
}

export function createServices(): Services {
  const mongo = config.mongo.uri === undefined ? undefined : new MongoStorage(config.mongo.uri, config.mongo.dbName);

  const cartRepository: CartRepository = mongo ? mongo.carts() : new InMemoryCartRepository();
  const orderRepository: OrderRepository = mongo ? mongo.orders() : new InMemoryOrderRepository();

  const carts = new CartService(cartRepository, menuService);
  const orders = new OrderService(orderRepository, carts, menuService);
  const payments = createPaymentService(orders);

  return { carts, orders, payments, storage: mongo ?? memoryStorage() };
}

/** Nothing to open or close; the maps live and die with the process. */
function memoryStorage(): Storage {
  return {
    kind: "memory",
    ready: true,
    indexes: "ready",
    async connect() {},
    async close() {},
  };
}

export const services: Services = createServices();
