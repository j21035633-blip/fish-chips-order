import { menuService } from "../menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../orders/repository.js";
import { CartService, OrderService } from "../orders/service.js";
import { createPaymentService, PaymentService } from "../payments/service.js";

/**
 * One place that wires the services together.
 *
 * `OrderService` and the HTTP layer must share the *same* `CartService`
 * instance — confirming an order clears the cart it came from, and two
 * instances would leave the browser's cart alive after checkout.
 */
export interface Services {
  carts: CartService;
  orders: OrderService;
  payments: PaymentService;
}

export function createServices(): Services {
  const carts = new CartService(new InMemoryCartRepository(), menuService);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
  const payments = createPaymentService(orders);
  return { carts, orders, payments };
}

export const services: Services = createServices();
