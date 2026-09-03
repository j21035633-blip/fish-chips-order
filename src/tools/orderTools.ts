import { z } from "zod";

import { services, type Services } from "../app/container.js";
import { renderCart, renderOrder } from "../orders/render.js";
import { PAYMENT_METHODS } from "../orders/types.js";

/**
 * Stage 2 and 3 tools for the Order & Track agent.
 *
 * `add_to_cart` and `confirm_order` are the names the skill uses. The rest exist
 * because a cart the customer cannot correct is worse than no cart.
 *
 * Every cart mutation returns the repriced cart and its `text`, which is what
 * lets the agent confirm each add and keep the running total visible without a
 * second call.
 */

const optionSelectionSchema = z.object({
  groupId: z.string().min(1),
  choiceId: z.string().min(1),
});

export const addToCartInput = z.object({
  cartId: z.string().min(1).describe("Cart to add to. Call create_cart first if there isn't one."),
  itemId: z.string().min(1).describe("Menu item id, e.g. fish-dory-classic."),
  quantity: z.number().int().min(1).max(20).optional().describe("Default 1."),
  selections: z
    .array(optionSelectionSchema)
    .optional()
    .describe("Option choices. Required groups fall back to their default when omitted."),
  note: z.string().max(200).optional().describe("Kitchen note, e.g. 'no salt'."),
});

export const cartLineRefInput = z.object({
  cartId: z.string().min(1),
  lineId: z.string().min(1),
});

export const updateQuantityInput = cartLineRefInput.extend({
  quantity: z.number().int().min(0).max(20).describe("0 removes the line."),
});

export const confirmOrderInput = z.object({
  cartId: z.string().min(1),
  customerName: z.string().min(1).max(60).optional().describe("Name to call out at pickup."),
});

export const startPaymentInput = z.object({
  orderId: z.string().min(1),
  method: z.enum(PAYMENT_METHODS).describe("card = Stripe, ewallet = Revenue Monster (DuitNow/TNG/GrabPay)."),
});

export const orderRefInput = z.object({ orderId: z.string().min(1) });

export function createOrderTools(app: Services = services) {
  return {
    /** Opens a cart. One per QR scan / browser session. */
    async create_cart() {
      const cart = await app.carts.create();
      return { cartId: cart.id, text: "Cart's open — what can I get you?" };
    },

    async add_to_cart(rawInput: unknown) {
      const input = addToCartInput.parse(rawInput);
      const { cartId, ...line } = input;
      const cart = await app.carts.addLine(cartId, line);
      return { cart, text: renderCart(cart) };
    },

    async view_cart(rawInput: unknown) {
      const { cartId } = z.object({ cartId: z.string().min(1) }).parse(rawInput);
      const cart = await app.carts.price(cartId);
      return { cart, text: renderCart(cart) };
    },

    async update_cart_line(rawInput: unknown) {
      const { cartId, lineId, quantity } = updateQuantityInput.parse(rawInput);
      const cart = await app.carts.updateQuantity(cartId, lineId, quantity);
      return { cart, text: renderCart(cart) };
    },

    async remove_from_cart(rawInput: unknown) {
      const { cartId, lineId } = cartLineRefInput.parse(rawInput);
      const cart = await app.carts.removeLine(cartId, lineId);
      return { cart, text: renderCart(cart) };
    },

    /** Stage 3: lock the order in. Payment is a separate, explicit step. */
    async confirm_order(rawInput: unknown) {
      const input = confirmOrderInput.parse(rawInput);
      const order = await app.orders.confirm(input);
      return { order, text: renderOrder(order) };
    },

    /** What the customer can pay with, for the picker. */
    get_payment_methods() {
      const methods = app.payments.availableMethods();
      const text = methods.map((option) => `- ${option.label}: ${option.brands.join(", ")}`).join("\n");
      return { methods, text };
    },

    /** Creates the payment session and hands back where to pay. */
    async start_payment(rawInput: unknown) {
      const { orderId, method } = startPaymentInput.parse(rawInput);
      const order = await app.payments.initiate(orderId, method);
      const payment = order.payment;

      const where = payment?.checkoutUrl
        ? `Pay here: ${payment.checkoutUrl}`
        : "Payment started.";

      return {
        order,
        payment,
        text: `${renderOrder(order)}\n\n${where}`,
      };
    },

    /**
     * Payment status only. Kitchen status (Received/Cooking/Ready) is a later
     * phase — this tool does not report it.
     */
    async get_order(rawInput: unknown) {
      const { orderId } = orderRefInput.parse(rawInput);
      const order = await app.orders.get(orderId);
      return { order, text: renderOrder(order) };
    },
  };
}

export const orderTools = createOrderTools();

export const orderToolDefinitions = [
  { name: "create_cart", description: "Open a cart for this customer.", inputSchema: z.object({}) },
  { name: "add_to_cart", description: "Add an item, with options, to the cart.", inputSchema: addToCartInput },
  {
    name: "view_cart",
    description: "Read the cart back with its running total.",
    inputSchema: z.object({ cartId: z.string() }),
  },
  {
    name: "update_cart_line",
    description: "Change a line's quantity. 0 removes it.",
    inputSchema: updateQuantityInput,
  },
  { name: "remove_from_cart", description: "Remove a line from the cart.", inputSchema: cartLineRefInput },
  {
    name: "confirm_order",
    description: "Turn the cart into an order. Read the order back and get explicit confirmation first.",
    inputSchema: confirmOrderInput,
  },
  {
    name: "get_payment_methods",
    description: "List the ways the customer can pay.",
    inputSchema: z.object({}),
  },
  {
    name: "start_payment",
    description: "Start a payment for an order and get the link or QR to pay with.",
    inputSchema: startPaymentInput,
  },
  { name: "get_order", description: "Read an order and its payment status.", inputSchema: orderRefInput },
] as const;
