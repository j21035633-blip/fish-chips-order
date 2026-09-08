import { InMemoryProofRepository, type ProofRepository } from "../game/proofs.js";
import { MenuService } from "../menu/service.js";
import { MenuStore } from "../menu/store.js";
import { config } from "../config/env.js";
import {
  InMemoryCartRepository,
  InMemoryOrderRepository,
  type CartRepository,
  type OrderRepository,
} from "../orders/repository.js";
import { CartService, OrderService } from "../orders/service.js";
import { createPaymentService, PaymentService } from "../payments/service.js";
import { InMemoryStaffAccountRepository, StaffAccountService } from "../staff/accounts.js";
import { InMemoryRoleRepository, RoleService } from "../staff/roles.js";
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
  /** Reads, for the customer app and the agent tools. */
  menu: MenuService;
  /** Writes, for the staff menu page. Backs `menu` above — same snapshot. */
  menuStore: MenuStore;
  /** Review and share screenshots, and the queue staff approve them from. */
  proofs: ProofRepository;
  /**
   * Individual staff, for attributing cashiering. Separate from the shared
   * password gate in `staff/auth.ts` and no substitute for it: that decides who
   * gets in, this decides whose name goes on a transaction.
   */
  staffAccounts: StaffAccountService;
  /**
   * Roles and what each may reach. Read by the staff gate on every request, so
   * a role narrowed on the Staff page takes effect on the next one.
   */
  staffRoles: RoleService;
}

export function createServices(): Services {
  const mongo = config.mongo.uri === undefined ? undefined : new MongoStorage(config.mongo.uri, config.mongo.dbName);

  const cartRepository: CartRepository = mongo ? mongo.carts() : new InMemoryCartRepository();
  const orderRepository: OrderRepository = mongo ? mongo.orders() : new InMemoryOrderRepository();

  // One store, read through one service. Staff edits have to be visible to
  // pricing and to the customer app immediately, and they are because both read
  // the same in-memory snapshot the store writes through.
  const menuStore = new MenuStore(mongo?.menu());
  const menu = new MenuService(menuStore);

  const carts = new CartService(cartRepository, menu);
  const orders = new OrderService(orderRepository, carts, menu);
  const payments = createPaymentService(orders);

  return {
    carts,
    orders,
    payments,
    storage: mongo ?? memoryStorage(),
    menu,
    menuStore,
    proofs: mongo ? mongo.proofs() : new InMemoryProofRepository(),
    staffAccounts: new StaffAccountService(
      mongo ? mongo.staffAccounts() : new InMemoryStaffAccountRepository(),
    ),
    staffRoles: new RoleService(mongo ? mongo.roles() : new InMemoryRoleRepository()),
  };
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
