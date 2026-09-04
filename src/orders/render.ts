import { allergenLabel } from "../menu/render.js";
import type { Order, PricedCart, PricedLine } from "./types.js";

/**
 * Short spoken-ready text, same convention as the menu tools: the agent reads
 * from `text` instead of re-formatting the payload.
 */

export function renderLine(line: PricedLine): string {
  const options = line.options
    .filter((option) => option.priceDeltaSen !== 0 || !isDefaultish(option.choiceName))
    .map((option) => option.choiceName);

  const detail = options.length > 0 ? ` (${options.join(", ")})` : "";
  return `${line.quantity}x ${line.name}${detail} — ${line.lineTotal}`;
}

/** The running total the skill asks to keep visible after every add. */
export function renderCart(cart: PricedCart): string {
  if (cart.lines.length === 0) return "Cart's empty.";

  const lines = cart.lines.map((line) => `- ${renderLine(line)}`);
  return `${lines.join("\n")}\n\n${renderTotals(cart)}`;
}

/**
 * The three money lines, wherever a total is read back.
 *
 * Read out in full rather than as one number: a customer told "RM18.59" for
 * RM16.90 of food will ask why, and the answer should already be on the screen.
 */
export function renderTotals(totals: Pick<PricedCart, "subtotal" | "tax" | "taxRate" | "total">): string {
  return [
    `Subtotal: ${totals.subtotal}`,
    `Tax (${formatRate(totals.taxRate)}): ${totals.tax}`,
    `Total: ${totals.total}`,
  ].join("\n");
}

/** "10%" from 0.1, without the trailing zeroes a fixed 2dp would leave. */
export function formatRate(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

/** The full read-back before checkout. */
export function renderOrder(order: Order): string {
  const lines = order.lines.map((line) => `- ${renderLine(line)}`);
  // The table is the first thing the counter needs; keep it on the head line.
  const head = order.tableNumber === undefined
    ? `Order ${order.reference}`
    : `Order ${order.reference} · Table ${order.tableNumber}`;
  const status = order.paymentStatus === "paid" ? "Paid" : `Payment ${order.paymentStatus}`;

  return `${head}\n${lines.join("\n")}\n\n${renderTotals(order)}\n${status}`;
}

/** Everything in the order that someone might be allergic to, deduped. */
export function orderAllergens(order: Order): string[] {
  const all = new Set<string>();
  for (const line of order.lines) {
    for (const allergen of line.allergens) all.add(allergenLabel(allergen));
  }
  return [...all];
}

/** "Sea salt" on a chips order is not worth repeating back; a paid upgrade is. */
function isDefaultish(choiceName: string): boolean {
  return choiceName === "Sea salt" || choiceName === "Normal ice" || choiceName === "Normal";
}
