/**
 * @vitest-environment jsdom
 *
 * Boots the real customer page against the real HTTP server, so a broken
 * selector or a renamed API field fails here rather than in front of a customer.
 * jsdom does not implement <dialog>, so showModal/close are stubbed; everything
 * else is the shipped code.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServices } from "../src/app/container.js";
import { createServer } from "../src/http/app.js";

let server: Server;
let base: string;

// jsdom serves import.meta.url over http, so resolve from the project root.
const webDir = resolve(process.cwd(), "src/web");
const appUrl = pathToFileURL(resolve(webDir, "app.js")).href;

beforeAll(async () => {
  server = createServer(createServices()).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // jsdom has no <dialog> implementation.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLElement) {
    this.removeAttribute("open");
  };

  // The page fetches relative paths; point them at the test server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    return realFetch(url as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Loads index.html into jsdom and runs app.js against it. */
async function bootPage(path = "/") {
  document.documentElement.innerHTML = readFileSync(`${webDir}/index.html`, "utf8")
    .replace(/^[\s\S]*?<body>/, "")
    .replace(/<\/body>[\s\S]*$/, "");

  window.history.replaceState({}, "", path);
  localStorage.clear();

  // Fresh module instance per boot — the script wires listeners on import, and
  // each boot rebuilds the DOM it binds to. An absolute file URL plus
  // @vite-ignore keeps Vite from trying to statically resolve the cache-buster.
  await import(/* @vite-ignore */ `${appUrl}?cache=${Math.random()}`);
  await settle();
}

/** Lets the page's chained fetches resolve. */
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("customer page", () => {
  it("renders the menu with categories, prices and tags", async () => {
    await bootPage("/");

    const view = document.getElementById("view")!;
    expect(view.textContent).toContain("Fish");
    expect(view.textContent).toContain("Classic Battered Dory");
    expect(view.textContent).toContain("RM16.90");

    // Sold-out items must not be offerable.
    expect(view.textContent).not.toContain("Popcorn Prawns");

    expect(view.querySelectorAll("button.item").length).toBeGreaterThan(10);
    expect(view.querySelector(".tag.signature")?.textContent).toBe("signature");
  });

  it("opens an item, shows its options, and prices them live", async () => {
    await bootPage("/");

    const chips = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Hand-Cut Chips"),
    ) as HTMLButtonElement;
    chips.click();
    await settle(2);

    const body = document.getElementById("item-dialog-body")!;
    expect(body.textContent).toContain("Size");
    expect(body.textContent).toContain("Seasoning");
    expect(document.getElementById("item-price")!.textContent).toBe("RM7.90");

    // Upsize to large: +RM4.00
    const large = body.querySelector('input[value="large"]') as HTMLInputElement;
    large.checked = true;
    large.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(document.getElementById("item-price")!.textContent).toBe("RM11.90");
  });

  it("adds to the cart and shows the running total", async () => {
    await bootPage("/");

    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);

    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    expect(document.getElementById("cart-count")!.textContent).toBe("1");
    expect(document.getElementById("cart-total")!.textContent).toBe("RM16.90");
    expect(document.getElementById("cart-body")!.textContent).toContain("Classic Battered Dory");
    expect((document.getElementById("checkout-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the payment method picker at checkout", async () => {
    await bootPage("/");

    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    (document.getElementById("checkout-button") as HTMLButtonElement).click();
    await settle();

    const view = document.getElementById("view")!;
    expect(view.textContent).toContain("Checkout");
    expect(view.textContent).toContain("How would you like to pay?");

    const methods = view.querySelectorAll(".method");
    expect(methods).toHaveLength(2);
    expect(view.textContent).toContain("Card");
    expect(view.textContent).toContain("E-wallet / QR");
    expect(view.textContent).toContain("Touch 'n Go");

    // Card is preselected so the customer can pay without choosing.
    const checked = view.querySelector('input[name="method"]:checked') as HTMLInputElement;
    expect(checked.value).toBe("card");

    // No keys configured in tests, so both rails advertise test mode.
    expect(view.querySelectorAll(".method-sim")).toHaveLength(2);
    expect(view.textContent).toContain("Pay RM16.90");
  });

  it("renders an order page for an unknown order without crashing", async () => {
    await bootPage("/order/does-not-exist");
    expect(document.getElementById("view")!.textContent).toContain("No order");
  });

  // `Node.replaceChildren` stringifies non-Nodes, so an unfilled `: null` slot
  // used to reach the page as the literal text "null".
  it("never renders a literal null in an optional slot", async () => {
    await bootPage("/");

    const chips = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Hand-Cut Chips"),
    ) as HTMLButtonElement;
    chips.click();
    await settle(2);

    // Hand-Cut Chips declares no allergens, so the allergen line is skipped.
    const body = document.getElementById("item-dialog-body")!;
    expect(body.textContent).not.toContain("null");
    expect(body.textContent).not.toContain("Contains:");
  });

  it("offers a way to pay for an order whose payment never started", async () => {
    const orderId = await placeOrder();
    await bootPage(`/order/${orderId}`);

    const view = document.getElementById("view")!;
    expect(view.textContent).not.toContain("null");
    expect(view.textContent).toContain("Payment hasn't been started for this order yet.");
    // Not "waiting to confirm" — there is nothing in flight to wait for.
    expect(view.textContent).not.toContain("Waiting for payment to confirm");

    // The recovery panel is a full method picker, not a dead end.
    expect(view.textContent).toContain("How would you like to pay?");
    expect(view.querySelectorAll(".method")).toHaveLength(2);
    expect(view.textContent).toContain("Pay RM16.90");
  });

  it("attaches a payment session when the order page's pay button is used", async () => {
    const orderId = await placeOrder();
    await bootPage(`/order/${orderId}`);

    const view = document.getElementById("view")!;
    const payButton = [...view.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Pay "),
    ) as HTMLButtonElement;
    // jsdom logs "Not implemented: navigation" here — that is the real redirect
    // to the checkout URL firing.
    payButton.click();
    await settle();

    // The status endpoint now carries the attempt the page was missing.
    const response = await fetch(`${base}/api/orders/${orderId}`);
    const { order } = (await response.json()) as { order: Record<string, any> };
    expect(order.payment).toBeDefined();
    expect(order.payment.method).toBe("card");
    expect(order.payment.checkoutUrl).toContain("/simulated-checkout");
  });

  it("shows the payment attempt once one exists", async () => {
    const orderId = await placeOrder();
    await fetch(`${base}/api/orders/${orderId}/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "card" }),
    });

    await bootPage(`/order/${orderId}`);

    const view = document.getElementById("view")!;
    expect(view.textContent).not.toContain("null");
    expect(view.textContent).toContain("Waiting for payment to confirm");
    expect(view.textContent).toContain("Complete test payment");
    expect(view.textContent).not.toContain("How would you like to pay?");
  });
});

/** Places a one-item order straight through the API and returns its id. */
async function placeOrder(): Promise<string> {
  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    return (await response.json()) as any;
  };

  const { cartId } = await json("/api/carts", { method: "POST" });
  await json(`/api/carts/${cartId}/lines`, {
    method: "POST",
    body: JSON.stringify({ itemId: "fish-dory-classic", quantity: 1 }),
  });
  const { order } = await json("/api/orders", { method: "POST", body: JSON.stringify({ cartId }) });
  return order.id;
}
