import { createHmac, randomUUID } from "node:crypto";

import type { Order, PaymentProvider } from "../orders/types.js";
import type { PaymentSession } from "./types.js";

/**
 * Local stand-in used when a provider has no credentials configured.
 *
 * This is a development affordance, not a payment path. Every session it makes
 * is flagged `simulated: true`, and `PaymentService` refuses to settle a
 * simulated payment on an order whose adapter *is* configured — so switching a
 * real key on closes this door for that provider immediately.
 */
export function simulatedSession(provider: PaymentProvider, order: Order, baseUrl: string): PaymentSession {
  const providerPaymentId = `sim_${provider}_${randomUUID()}`;
  const url = new URL("/simulated-checkout", baseUrl);
  url.searchParams.set("orderId", order.id);
  url.searchParams.set("provider", provider);
  url.searchParams.set("paymentId", providerPaymentId);

  const session: PaymentSession = {
    provider,
    providerPaymentId,
    status: "pending",
    checkoutUrl: url.toString(),
    simulated: true,
  };

  // The e-wallet rail shows a code rather than redirecting, so give the page
  // something QR-shaped to render.
  if (provider === "revenue_monster") {
    session.qrCodeUrl = url.toString();
  }

  return session;
}

export function isSimulatedPaymentId(providerPaymentId: string): boolean {
  return providerPaymentId.startsWith("sim_");
}

/**
 * Constant-time comparison. Used by both adapters' signature checks — a plain
 * `===` on an HMAC leaks its prefix through timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
