/**
 * Customer-requested cancellation, and the staff decision that finishes it.
 *
 * The thread running through all of it: **a request is not a cancellation.**
 * Only somebody at the pass can see whether the fryer is already halfway
 * through an order, so the customer asks and a staff member answers — and when
 * the answer is yes, the money has to follow the food back.
 *
 * The refund is the part worth being paranoid about. Every path through it is
 * exercised here, including the two where no refund happens, because "the
 * customer was told it was cancelled and the shop kept the money" is the
 * failure this whole file exists to prevent.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Services } from "../src/app/container.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { createServer } from "../src/http/app.js";
import { menuService } from "../src/menu/service.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import {
  CANCELLABLE_STATUSES,
  KITCHEN_STATUSES,
  PASS_STATUSES,
  nextKitchenStatus,
  OrderValidationError,
  type Order,
} from "../src/orders/types.js";
import { PaymentService } from "../src/payments/service.js";
import { StripeAdapter } from "../src/payments/stripeAdapter.js";

const LIVE_STRIPE = {
  secretKey: "sk_test_live",
  webhookSecret: "whsec_test",
  apiBase: "https://api.stripe.test",
};
const BASE_URL = "http://localhost:3000";

let carts: CartService;
let orders: OrderService;

beforeEach(() => {
  carts = new CartService(new InMemoryCartRepository(), menuService);
  orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
});

/** A placed order, unpaid, sitting at `received`. */
async function placeOrder(): Promise<Order> {
  const cart = await carts.create();
  await carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  return orders.confirm({ cartId: cart.id });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A payment service whose Stripe adapter talks to `fetchImpl` instead of Stripe. */
function paymentsWith(fetchImpl: unknown): PaymentService {
  return new PaymentService(
    orders,
    [new StripeAdapter(LIVE_STRIPE, BASE_URL, fetchImpl as typeof fetch)],
    BASE_URL,
  );
}

/** Marks an order paid by card, as the Stripe webhook would. */
// `null`, not `undefined`, for "this order has no stored intent": passing
// undefined to a defaulted parameter just re-triggers the default.
async function payByCard(order: Order, intent: string | null = "pi_test_1"): Promise<Order> {
  await orders.attachPayment(order.id, {
    method: "card",
    provider: "stripe",
    providerPaymentId: "cs_test_1",
    status: "pending",
    simulated: false,
    createdAt: new Date().toISOString(),
  });
  return (await orders.markPaid(order.id, new Date().toISOString(), intent ?? undefined)).order;
}

describe("asking to cancel", () => {
  it("is allowed while the food has not been made yet", async () => {
    for (const status of CANCELLABLE_STATUSES) {
      const order = await placeOrder();
      await orders.setKitchenStatus(order.id, status);

      const asked = await orders.requestCancellation(order.id);

      expect(asked.cancellationRequested, status).toBe(true);
      expect(asked.cancellationRequestedAt, status).toBeTruthy();
      // Nothing else moved. It is a request, not a cancellation.
      expect(asked.kitchenStatus, status).toBe(status);
    }
  });

  it("is refused once the food is ready, and from there on", async () => {
    // The cut-off, and the reason for it: past `cooking` the fish has been
    // fried. Everything from `ready` onward is a conversation with a person.
    for (const status of ["ready", "collected"] as const) {
      const order = await placeOrder();
      await orders.setKitchenStatus(order.id, status);

      await expect(orders.requestCancellation(order.id)).rejects.toThrow(OrderValidationError);
      await expect(orders.requestCancellation(order.id)).rejects.toThrow(/cancel|collected/i);

      const after = await orders.get(order.id);
      expect(after.cancellationRequested ?? false, status).toBe(false);
      expect(after.kitchenStatus, status).toBe(status);
    }
  });

  it("is refused on an order that is already cancelled", async () => {
    const order = await placeOrder();
    await orders.requestCancellation(order.id);
    await orders.completeCancellation(order.id, { outcome: "none", reason: "nothing to refund", at: "now" });

    await expect(orders.requestCancellation(order.id)).rejects.toThrow(/already been cancelled/i);
  });

  it("treats a second ask as the same ask", async () => {
    // A customer tapping again because nothing has happened yet is not an error
    // worth showing them, and it must not move the timestamp either.
    const order = await placeOrder();
    const first = await orders.requestCancellation(order.id);
    const second = await orders.requestCancellation(order.id);

    expect(second.cancellationRequested).toBe(true);
    expect(second.cancellationRequestedAt).toBe(first.cancellationRequestedAt);
  });

  it("clears a previous refusal, so the page stops saying no to a live request", async () => {
    const order = await placeOrder();
    await orders.requestCancellation(order.id);
    await orders.denyCancellation(order.id);
    expect((await orders.get(order.id)).cancellationDeniedAt).toBeTruthy();

    const again = await orders.requestCancellation(order.id);
    expect(again.cancellationRequested).toBe(true);
    expect(again.cancellationDeniedAt).toBeUndefined();
  });
});

describe("staff say no", () => {
  it("leaves the order completely intact, and still moving", async () => {
    const order = await placeOrder();
    await orders.setKitchenStatus(order.id, "cooking");
    const before = await orders.get(order.id);
    await orders.requestCancellation(order.id);

    const denied = await orders.denyCancellation(order.id);

    // The badge comes down; nothing else about the order changed.
    expect(denied.cancellationRequested).toBe(false);
    expect(denied.cancellationDeniedAt).toBeTruthy();
    expect(denied.kitchenStatus).toBe("cooking");
    expect(denied.totalSen).toBe(before.totalSen);
    expect(denied.lines).toEqual(before.lines);
    expect(denied.paymentStatus).toBe(before.paymentStatus);
    expect(denied.refund).toBeUndefined();
    expect(denied.cancelledAt).toBeUndefined();

    // And it carries on down the pass exactly as it would have.
    const ready = await orders.setKitchenStatus(order.id, "ready");
    expect(ready.order.kitchenStatus).toBe("ready");
    const collected = await orders.setKitchenStatus(order.id, "collected");
    expect(collected.order.kitchenStatus).toBe("collected");
  });

  it("refuses to deny an order nobody asked to cancel", async () => {
    const order = await placeOrder();
    await expect(orders.denyCancellation(order.id)).rejects.toThrow(/no cancellation request/i);
  });
});

describe("staff say yes, and the money goes back", () => {
  it("refunds a Stripe-paid order for the full amount, against the payment intent", async () => {
    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "re_test_1", amount: order.totalSen, status: "succeeded" }));
    const payments = paymentsWith(fetchImpl);

    const { order: cancelled, refund } = await payments.approveCancellation(order.id);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.test/v1/refunds");
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(init.body as string);
    // The intent, never the session: Stripe's Refunds API will not take a
    // `cs_…` and this is the assertion that catches it if anyone swaps them.
    expect(body.get("payment_intent")).toBe("pi_test_1");
    expect(body.get("amount")).toBe(String(order.totalSen));
    expect(body.get("reason")).toBe("requested_by_customer");
    expect(body.get("metadata[order_id]")).toBe(order.id);
    // A double-tap on Approve must not send the money twice.
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(`refund_${order.id}`);

    expect(refund).toMatchObject({
      outcome: "refunded",
      amountSen: order.totalSen,
      provider: "stripe",
      providerRefundId: "re_test_1",
      simulated: false,
    });
    expect(cancelled.kitchenStatus).toBe("cancelled");
    expect(cancelled.cancellationRequested).toBe(false);
    expect(cancelled.refund).toEqual(refund);
  });

  it("looks the intent up when the order was paid before we started keeping it", async () => {
    // Older orders have a session id and nothing else. The refund still has to
    // work for them, so the adapter goes and asks.
    const order = await payByCard(await placeOrder(), null);
    await orders.requestCancellation(order.id);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "cs_test_1", payment_intent: "pi_looked_up" }))
      .mockResolvedValueOnce(jsonResponse({ id: "re_test_2", amount: order.totalSen, status: "succeeded" }));

    const { refund } = await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.stripe.test/v1/checkout/sessions/cs_test_1");
    const body = new URLSearchParams((fetchImpl.mock.calls[1]![1] as RequestInit).body as string);
    expect(body.get("payment_intent")).toBe("pi_looked_up");
    expect(refund.outcome).toBe("refunded");
  });

  it("does not go near a provider for an unpaid order", async () => {
    const order = await placeOrder();
    await orders.requestCancellation(order.id);

    const fetchImpl = vi.fn();
    const { order: cancelled, refund } = await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refund.outcome).toBe("none");
    expect(refund.reason).toMatch(/never paid/i);
    expect(cancelled.kitchenStatus).toBe("cancelled");
  });

  it("does not go near a provider for cash, and says to open the till", async () => {
    const order = await placeOrder();
    await orders.takeCash(order.id);
    await orders.requestCancellation(order.id);

    const fetchImpl = vi.fn();
    const { refund } = await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refund.outcome).toBe("none");
    // There is money to give back — it just is not this system's to move.
    expect(refund.reason).toMatch(/cash/i);
    expect(refund.amountSen).toBe(order.totalSen);
  });

  it("flags a rail it cannot refund itself rather than quietly keeping the money", async () => {
    // Revenue Monster has no refund on its adapter. The order still cancels,
    // and the record says out loud that somebody has to do this by hand.
    const order = await placeOrder();
    await orders.attachPayment(order.id, {
      method: "ewallet",
      provider: "revenue_monster",
      providerPaymentId: "rm_1",
      status: "pending",
      simulated: false,
      createdAt: new Date().toISOString(),
    });
    await orders.markPaid(order.id);
    await orders.requestCancellation(order.id);

    const { order: cancelled, refund } = await paymentsWith(vi.fn()).approveCancellation(order.id);

    expect(refund.outcome).toBe("manual");
    expect(refund.amountSen).toBe(order.totalSen);
    expect(refund.reason).toMatch(/by hand/i);
    expect(cancelled.kitchenStatus).toBe("cancelled");
  });

  it("still cancels when the refund fails, and says so on the order", async () => {
    // A staff member has already told the customer it is off. Leaving the order
    // half-cancelled because Stripe had a bad minute is worse than recording it
    // as cancelled with "do this by hand" written on it.
    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "charge already refunded" } }, 400));
    const { order: cancelled, refund } = await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(refund.outcome).toBe("failed");
    expect(refund.reason).toMatch(/by hand/i);
    expect(refund.reason).toMatch(/already refunded/);
    expect(cancelled.kitchenStatus).toBe("cancelled");
    expect(cancelled.refund?.outcome).toBe("failed");
  });

  it("simulates the refund when no Stripe key is configured", async () => {
    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);

    const fetchImpl = vi.fn();
    const payments = new PaymentService(
      orders,
      [new StripeAdapter({ ...LIVE_STRIPE, secretKey: undefined }, BASE_URL, fetchImpl as typeof fetch)],
      BASE_URL,
    );

    const { refund } = await payments.approveCancellation(order.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refund).toMatchObject({ outcome: "refunded", simulated: true });
  });

  it("refuses to approve an order that has not asked, or has already gone", async () => {
    const untouched = await placeOrder();
    await expect(paymentsWith(vi.fn()).approveCancellation(untouched.id)).rejects.toThrow(
      /no cancellation request/i,
    );

    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "re_1", amount: order.totalSen, status: "succeeded" }));
    const payments = paymentsWith(fetchImpl);
    await payments.approveCancellation(order.id);

    // The second Approve refunds nothing, because it never reaches the money.
    await expect(payments.approveCancellation(order.id)).rejects.toThrow(/already been cancelled/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("cancelled is a place, not a step on the pass", () => {
  it("is a kitchen status but never the next one", () => {
    expect([...KITCHEN_STATUSES]).toContain("cancelled");
    expect([...PASS_STATUSES]).not.toContain("cancelled");

    // Walking the pass from the start must never arrive at it.
    let status = PASS_STATUSES[0] as string | undefined;
    const walked: string[] = [];
    while (status !== undefined) {
      walked.push(status);
      status = nextKitchenStatus(status as never);
    }
    expect(walked).toEqual(["received", "cooking", "ready", "collected"]);
    expect(nextKitchenStatus("cancelled")).toBeUndefined();
  });
});

/**
 * The revenue leak, and the exact shape of its fix.
 *
 * A cancelled order used to stay `paid`, so money that had gone back to the
 * customer went on counting in the day's takings. The fix is one word — the
 * payment becomes `refunded` — and the whole of its correctness is *when* that
 * word is written.
 *
 * There are two ways to be wrong here and they pull in opposite directions.
 * Leaving a settled refund in the report over-reports money the shop does not
 * have. Taking a *queued* refund out of it under-reports money the shop still
 * does. The rule below is the only one that is right in both directions:
 * **only a confirmed refund leaves the takings.**
 */
describe("refunded orders and the day's takings", () => {
  /** The day's revenue, exactly as the staff header and the sales page read it. */
  const takings = async () => (await orders.dailySales()).totalSen;

  /** A paid card order, cancelled and approved against a stubbed Stripe. */
  async function cancelPaidOrder(refundPayload: unknown, status = 200) {
    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(refundPayload, status));
    // The cancelled order, not the one placed a moment ago: they differ in
    // exactly the fields these tests are about.
    return paymentsWith(fetchImpl).approveCancellation(order.id);
  }

  it("drops a confirmed refund out of the total", async () => {
    const order = await payByCard(await placeOrder());
    const before = await takings();
    expect(before).toBe(order.totalSen);

    await orders.requestCancellation(order.id);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_1", amount: order.totalSen, status: "succeeded" }));
    const { order: cancelled } = await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(cancelled.paymentStatus).toBe("refunded");
    expect(cancelled.payment?.status).toBe("refunded");
    // The whole point: the money that went back is no longer in the takings.
    expect(await takings()).toBe(0);
  });

  it("is the RM18.59 order from the report that started this", async () => {
    // One Classic Battered Dory: RM16.90 plus 10% tax. The number that was
    // still sitting in the day's total after being refunded.
    const order = await payByCard(await placeOrder());
    expect(order.total).toBe("RM18.59");
    expect(await takings()).toBe(1859);

    await orders.requestCancellation(order.id);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "re_x", amount: 1859, status: "succeeded" }));
    await paymentsWith(fetchImpl).approveCancellation(order.id);

    expect(await takings()).toBe(0);
    const report = await orders.salesReport({});
    expect(report.days[0]!.totalSen).toBe(0);
    expect(report.days[0]!.count).toBe(0);
  });

  it("keeps a refund the provider has only queued, because the shop still holds the money", async () => {
    // Stripe answers `pending` on some rails. Accepted is not settled, and
    // taking this out of the report would under-report real takings.
    const { order, refund } = await cancelPaidOrder({ id: "re_p", amount: 1859, status: "pending" });

    expect(refund.outcome).toBe("pending");
    expect((await orders.get(order.id)).paymentStatus).toBe("paid");
    expect(await takings()).toBe(order.totalSen);
    // The food is still off, whatever the money is doing.
    expect((await orders.get(order.id)).kitchenStatus).toBe("cancelled");
  });

  it("keeps a refund the provider refused", async () => {
    const { order, refund } = await cancelPaidOrder({ error: { message: "already refunded" } }, 400);

    expect(refund.outcome).toBe("failed");
    expect((await orders.get(order.id)).paymentStatus).toBe("paid");
    // Still the shop's money until somebody sends it back by hand.
    expect(await takings()).toBe(order.totalSen);
  });

  it("keeps a rail it cannot refund itself, which is money still in the till", async () => {
    const order = await placeOrder();
    await orders.attachPayment(order.id, {
      method: "ewallet",
      provider: "revenue_monster",
      providerPaymentId: "rm_2",
      status: "pending",
      simulated: false,
      createdAt: new Date().toISOString(),
    });
    await orders.markPaid(order.id);
    await orders.requestCancellation(order.id);

    const { refund } = await paymentsWith(vi.fn()).approveCancellation(order.id);

    expect(refund.outcome).toBe("manual");
    expect(await takings()).toBe(order.totalSen);
  });

  it("leaves an unpaid cancellation exactly where it always was — out", async () => {
    // Unchanged behaviour, asserted so it stays unchanged: an order nobody paid
    // for never counted, and cancelling it must not start counting it.
    const order = await placeOrder();
    expect(await takings()).toBe(0);

    await orders.requestCancellation(order.id);
    const { order: cancelled } = await paymentsWith(vi.fn()).approveCancellation(order.id);

    expect(cancelled.paymentStatus).toBe("pending");
    expect(cancelled.refund?.outcome).toBe("none");
    expect(await takings()).toBe(0);
  });

  it("takes cash back out too, since a simulated refund is as settled as its payment", async () => {
    // Cash is `none` — the money goes back over the counter, not through a
    // provider — so the order keeps counting until somebody adjusts the till.
    // Asserted because it is a real decision, not an oversight.
    const order = await placeOrder();
    await orders.takeCash(order.id);
    expect(await takings()).toBe(order.totalSen);

    await orders.requestCancellation(order.id);
    const { refund } = await paymentsWith(vi.fn()).approveCancellation(order.id);

    expect(refund.outcome).toBe("none");
    expect(refund.reason).toMatch(/till/i);
    expect(await takings()).toBe(order.totalSen);
  });

  it("counts everything else on the day exactly as before", async () => {
    // One refunded order must not take its neighbours out with it.
    const kept = await payByCard(await placeOrder());
    const dropped = await payByCard(await placeOrder());
    expect(await takings()).toBe(kept.totalSen + dropped.totalSen);

    await orders.requestCancellation(dropped.id);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_n", amount: dropped.totalSen, status: "succeeded" }));
    await paymentsWith(fetchImpl).approveCancellation(dropped.id);

    expect(await takings()).toBe(kept.totalSen);
    const report = await orders.salesReport({});
    expect(report.days[0]!.count).toBe(1);
  });
});

/**
 * The other end of the same leak.
 *
 * Stripe redelivers webhooks for days. A late one landing on an order whose
 * money has already gone back would put it straight back into the takings.
 */
describe("nothing puts a refunded order back in the takings", () => {
  async function refundedOrder() {
    const order = await payByCard(await placeOrder());
    await orders.requestCancellation(order.id);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_late", amount: order.totalSen, status: "succeeded" }));
    await paymentsWith(fetchImpl).approveCancellation(order.id);
    return order;
  }

  it("ignores a payment webhook that lands after the refund", async () => {
    const order = await refundedOrder();
    expect((await orders.dailySales()).totalSen).toBe(0);

    const result = await orders.markPaid(order.id);

    expect(result.changed).toBe(false);
    expect(result.order.paymentStatus).toBe("refunded");
    expect((await orders.dailySales()).totalSen).toBe(0);
  });

  it("ignores a late failure notice too, rather than losing the refund record", async () => {
    const order = await refundedOrder();

    const result = await orders.markFailed(order.id, "expired");

    expect(result.changed).toBe(false);
    expect(result.order.paymentStatus).toBe("refunded");
    expect(result.order.refund?.outcome).toBe("refunded");
  });

  it("will not let a second approval run at all", async () => {
    const order = await refundedOrder();
    await expect(paymentsWith(vi.fn()).approveCancellation(order.id)).rejects.toThrow(/already been cancelled/i);
    expect((await orders.dailySales()).totalSen).toBe(0);
  });
});

/**
 * Staff cancelling an order themselves, with nobody having asked.
 *
 * The faster path for the counter. What matters is that it is *only* a faster
 * path: the money goes through the very same code as an approved customer
 * request, so a refund cannot behave one way when the customer asked and
 * another when the counter did.
 */
describe("staff cancel an order on their own", () => {
  const takings = async () => (await orders.dailySales()).totalSen;

  it("refunds a paid order and takes it out of the day's takings", async () => {
    const order = await payByCard(await placeOrder());
    expect(await takings()).toBe(order.totalSen);

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_staff", amount: order.totalSen, status: "succeeded" }));
    const { order: cancelled, refund } = await paymentsWith(fetchImpl).cancelByStaff(order.id);

    // The same Stripe call the approval path makes, against the intent.
    const body = new URLSearchParams((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.get("payment_intent")).toBe("pi_test_1");
    expect(body.get("amount")).toBe(String(order.totalSen));

    expect(refund.outcome).toBe("refunded");
    expect(cancelled.kitchenStatus).toBe("cancelled");
    expect(cancelled.paymentStatus).toBe("refunded");
    expect(await takings()).toBe(0);
  });

  it("cancels an unpaid order without going near a provider", async () => {
    const order = await placeOrder();
    const fetchImpl = vi.fn();

    const { order: cancelled, refund } = await paymentsWith(fetchImpl).cancelByStaff(order.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(refund.outcome).toBe("none");
    expect(cancelled.kitchenStatus).toBe("cancelled");
    expect(await takings()).toBe(0);
  });

  it("needs no customer request, and does not invent one", async () => {
    const order = await placeOrder();
    expect(order.cancellationRequested ?? false).toBe(false);

    const { order: cancelled } = await paymentsWith(vi.fn()).cancelByStaff(order.id);

    expect(cancelled.kitchenStatus).toBe("cancelled");
    expect(cancelled.cancellationRequested).toBe(false);
    expect(cancelled.cancellationRequestedAt).toBeUndefined();
  });

  it("also works on an order the customer *did* ask about, clearing the badge", async () => {
    // Both doors lead to the same room: a staff member who cancels a flagged
    // order outright must not leave the flag up on everybody else's tablet.
    const order = await placeOrder();
    await orders.requestCancellation(order.id);

    const { order: cancelled } = await paymentsWith(vi.fn()).cancelByStaff(order.id);

    expect(cancelled.cancellationRequested).toBe(false);
    expect(cancelled.kitchenStatus).toBe("cancelled");
  });

  it("reaches a ready order, which the customer's own window does not", async () => {
    // The case this exists for: the food is up and nobody came back for it.
    const order = await placeOrder();
    await orders.setKitchenStatus(order.id, "ready");
    await expect(orders.requestCancellation(order.id)).rejects.toThrow(/cancel/i);

    const { order: cancelled } = await paymentsWith(vi.fn()).cancelByStaff(order.id);
    expect(cancelled.kitchenStatus).toBe("cancelled");
  });

  it("refuses an order that has already been handed over", async () => {
    const order = await placeOrder();
    await orders.setKitchenStatus(order.id, "collected");

    await expect(paymentsWith(vi.fn()).cancelByStaff(order.id)).rejects.toThrow(/collected/i);
    expect((await orders.get(order.id)).kitchenStatus).toBe("collected");
  });

  it("refuses a second cancellation, so nothing is refunded twice", async () => {
    const order = await payByCard(await placeOrder());
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_once", amount: order.totalSen, status: "succeeded" }));
    const payments = paymentsWith(fetchImpl);

    await payments.cancelByStaff(order.id);
    await expect(payments.cancelByStaff(order.id)).rejects.toThrow(/already been cancelled/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued refund in the takings, exactly as the approval path does", async () => {
    // The confirmation rule is shared, not reimplemented: accepted is not
    // settled, and the shop still holds this money.
    const order = await payByCard(await placeOrder());
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "re_pend", amount: order.totalSen, status: "pending" }));

    const { refund } = await paymentsWith(fetchImpl).cancelByStaff(order.id);

    expect(refund.outcome).toBe("pending");
    expect((await orders.get(order.id)).paymentStatus).toBe("paid");
    expect(await takings()).toBe(order.totalSen);
  });

  it("leaves the customer's own request flow alone", async () => {
    // Nothing about the two-step path changed: still needs a request, still
    // refuses without one.
    const order = await placeOrder();
    await expect(paymentsWith(vi.fn()).approveCancellation(order.id)).rejects.toThrow(
      /no cancellation request/i,
    );
    await expect(orders.denyCancellation(order.id)).rejects.toThrow(/no cancellation request/i);
  });
});

/**
 * The same flow over HTTP, which is the only way the customer's page and the
 * staff tablets ever touch it.
 */
describe("over HTTP", () => {
  let server: Server;
  let base: string;
  let app: Services;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const cartRepo = new InMemoryCartRepository();
    const orderRepo = new InMemoryOrderRepository();
    const cartService = new CartService(cartRepo, menuService);
    const orderService = new OrderService(orderRepo, cartService, menuService);
    fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "re_http", amount: 1, status: "succeeded" }));

    app = {
      carts: cartService,
      orders: orderService,
      menu: menuService,
      menuStore: undefined as never,
      payments: new PaymentService(
        orderService,
        [new StripeAdapter(LIVE_STRIPE, BASE_URL, fetchImpl as unknown as typeof fetch)],
        BASE_URL,
      ),
      proofs: new InMemoryProofRepository(),
      storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} },
    } as unknown as Services;

    server = createServer(app).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = (res: Response): Promise<any> => res.json() as Promise<any>;

  async function placedOverHttp(): Promise<any> {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    const { order } = await json(await call("POST", "/api/orders", { cartId }));
    return order;
  }

  it("takes the request, and shows it on the staff feed within a poll", async () => {
    const order = await placedOverHttp();

    const asked = await call("POST", `/api/order/${order.id}/request-cancel`);
    expect(asked.status).toBe(200);
    await expect(json(asked)).resolves.toMatchObject({ order: { cancellationRequested: true } });

    // The boards poll this every two seconds; the flag riding on the order is
    // the whole of the "broadcast".
    const { orders: feed } = await json(await call("GET", "/api/staff/overview"));
    const onFeed = feed.find((candidate: any) => candidate.id === order.id);
    expect(onFeed.cancellationRequested).toBe(true);
    expect(onFeed.cancellationRequestedAt).toBeTruthy();
  });

  it("refuses the request once the order is ready, with a code the page can read", async () => {
    const order = await placedOverHttp();
    await call("PATCH", `/api/staff/orders/${order.id}/status`, { status: "ready" });

    const response = await call("POST", `/api/order/${order.id}/request-cancel`);
    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ error: "cancellation_too_late" });
  });

  it("lets the customer see the approval on their next poll, with no refresh", async () => {
    const order = await placedOverHttp();
    await call("POST", `/api/order/${order.id}/request-cancel`);

    // What the page is already polling, before the decision.
    const waiting = await json(await call("GET", `/api/orders/${order.id}`));
    expect(waiting.order.cancellationRequested).toBe(true);
    expect(waiting.order.kitchenStatus).toBe("received");

    await call("PATCH", `/api/staff/orders/${order.id}/approve-cancel`);

    // The same request the poller makes, now carrying the outcome.
    const after = await json(await call("GET", `/api/orders/${order.id}`));
    expect(after.order.kitchenStatus).toBe("cancelled");
    expect(after.order.cancellationRequested).toBe(false);
    expect(after.order.refund.outcome).toBe("none");
    expect(after.order.refund.reason).toBeTruthy();
  });

  it("lets the customer see a refusal on their next poll too", async () => {
    const order = await placedOverHttp();
    await call("PATCH", `/api/staff/orders/${order.id}/status`, { status: "cooking" });
    await call("POST", `/api/order/${order.id}/request-cancel`);

    const denied = await call("PATCH", `/api/staff/orders/${order.id}/deny-cancel`);
    expect(denied.status).toBe(200);

    const after = await json(await call("GET", `/api/orders/${order.id}`));
    expect(after.order.cancellationRequested).toBe(false);
    expect(after.order.cancellationDeniedAt).toBeTruthy();
    // Still cooking, still going.
    expect(after.order.kitchenStatus).toBe("cooking");
  });

  it("cancels straight from the counter, with nobody having asked", async () => {
    const order = await placedOverHttp();

    const response = await call("PATCH", `/api/staff/orders/${order.id}/cancel`);
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.order.kitchenStatus).toBe("cancelled");
    expect(body.refund.outcome).toBe("none");
    expect(body.refund.reason).toBeTruthy();

    // And the customer's page sees it on its next poll, same as an approval.
    const seen = await json(await call("GET", `/api/orders/${order.id}`));
    expect(seen.order.kitchenStatus).toBe("cancelled");
  });

  it("cancels a ready order from the counter, which the customer cannot", async () => {
    const order = await placedOverHttp();
    await call("PATCH", `/api/staff/orders/${order.id}/status`, { status: "ready" });

    // The customer is refused...
    const asked = await call("POST", `/api/order/${order.id}/request-cancel`);
    expect(asked.status).toBe(400);

    // ...and the counter is not.
    const staff = await call("PATCH", `/api/staff/orders/${order.id}/cancel`);
    expect(staff.status).toBe(200);
    await expect(json(staff)).resolves.toMatchObject({ order: { kitchenStatus: "cancelled" } });
  });

  it("refuses to cancel an order that has been collected", async () => {
    const order = await placedOverHttp();
    await call("PATCH", `/api/staff/orders/${order.id}/status`, { status: "collected" });

    const response = await call("PATCH", `/api/staff/orders/${order.id}/cancel`);
    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ error: "cancellation_after_collection" });
  });

  it("will not let the ordinary status endpoint cancel an order", async () => {
    // The refund lives on approve-cancel. If "cancelled" were settable here,
    // one word would cancel the order and quietly keep the customer's money.
    const order = await placedOverHttp();

    const response = await call("PATCH", `/api/staff/orders/${order.id}/status`, { status: "cancelled" });
    expect(response.status).toBe(400);

    const after = await json(await call("GET", `/api/orders/${order.id}`));
    expect(after.order.kitchenStatus).toBe("received");
  });
});
