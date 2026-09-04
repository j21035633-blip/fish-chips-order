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
// Kept so a test can put an order into a state the simulated adapters never
// produce on their own.
let services: ReturnType<typeof createServices>;

// jsdom serves import.meta.url over http, so resolve from the project root.
const webDir = resolve(process.cwd(), "src/web");
const appUrl = pathToFileURL(resolve(webDir, "app.js")).href;

beforeAll(async () => {
  services = createServices();
  server = createServer(services).listen(0);
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

/** Boots the page again without clearing storage — a second scan, same phone. */
async function bootPageKeepingStorage(path: string) {
  document.documentElement.innerHTML = readFileSync(`${webDir}/index.html`, "utf8")
    .replace(/^[\s\S]*?<body>/, "")
    .replace(/<\/body>[\s\S]*$/, "");
  window.history.replaceState({}, "", path);
  await import(/* @vite-ignore */ `${appUrl}?cache=${Math.random()}`);
  await settle();
}

/** Lets the page's chained fetches resolve. */
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("customer page", async () => {
  it("renders the menu with categories, prices and tags", async () => {
    await bootPage("/");

    const view = document.getElementById("view")!;
    expect(view.textContent).toContain("Fish");
    expect(view.textContent).toContain("Classic Battered Dory");
    expect(view.textContent).toContain("RM16.90");

    expect(view.querySelectorAll("button.item").length).toBeGreaterThan(10);
    expect(view.querySelector(".tag.signature")?.textContent).toBe("signature");
  });

  it("lists a sold-out item, greyed out and not orderable", async () => {
    await bootPage("/");

    const view = document.getElementById("view")!;
    // Listed rather than hidden: hiding it only moves the question to the counter.
    const row = [...view.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Popcorn Prawns"),
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();

    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector(".item-unavailable")?.textContent).toContain("Currently unavailable");
    expect(row.querySelector(".item-unavailable")?.textContent).toContain("Sold out for today");
    // The price is replaced, not shown alongside — there is nothing to pay.
    expect(row.querySelector(".item-price")).toBeNull();

    // And tapping it opens nothing.
    row.click();
    await settle(2);
    expect(document.getElementById("item-dialog")!.hasAttribute("open")).toBe(false);
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

  // What production hit: Stripe accepted the session but returned no `url`, so
  // the order carried an attempt that the customer could not act on.
  it("offers a way to pay when the provider returned no checkout link", async () => {
    const orderId = await placeOrder();
    const attempted = await services.payments.initiate(orderId, "card");
    delete attempted.payment!.checkoutUrl;
    await services.orders.attachPayment(orderId, attempted.payment!);

    await bootPage(`/order/${orderId}`);

    const view = document.getElementById("view")!;
    expect(view.textContent).toContain("We couldn't get a payment page from the provider.");
    expect(view.textContent).toContain("How would you like to pay?");
    expect(view.textContent).toContain("Pay RM16.90");
    // The dead end this replaces.
    expect(view.textContent).not.toContain("Waiting for payment to confirm");
  });

  it("links back to a live checkout instead of the picker", async () => {
    const orderId = await placeOrder();
    const order = await services.payments.initiate(orderId, "card");

    await bootPage(`/order/${orderId}`);

    const view = document.getElementById("view")!;
    const link = view.querySelector("a.button-link") as HTMLAnchorElement;
    expect(link.textContent).toBe("Continue to payment");
    expect(link.href).toBe(order.payment!.checkoutUrl);
    expect(view.textContent).toContain("Waiting for payment to confirm");
    expect(view.textContent).not.toContain("How would you like to pay?");
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

describe("QR table landing", () => {
  // Session & Sales Behavior: "when a new customer scans the same table's QR,
  // they always get an empty cart. A previous customer's order must never
  // appear on a new session."
  it("discards the previous customer's cart on a scan", async () => {
    // Customer one: scans table 7 and puts something in the cart.
    await bootPage("/order?table=7");
    const firstCartId = localStorage.getItem("fishchips.cartId");
    expect(firstCartId).toBeTruthy();

    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();
    expect(document.getElementById("cart-count")!.textContent).toBe("1");

    // Customer two scans the same sticker. Same table, different person.
    await bootPageKeepingStorage("/order?table=7");

    expect(localStorage.getItem("fishchips.cartId")).not.toBe(firstCartId);
    expect(document.getElementById("cart-count")!.textContent).toBe("0");
    expect(document.getElementById("table-badge")!.textContent).toBe("Table 7");
  });

  it("shows the table and rewrites the URL so a refresh is not a new scan", async () => {
    await bootPage("/order?table=A3");

    expect(document.getElementById("table-badge")!.hidden).toBe(false);
    expect(document.getElementById("table-badge")!.textContent).toBe("Table A3");
    // Landing rewrites to "/", so reloading resumes this customer's cart
    // instead of silently opening a third one.
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("keeps the existing cart when there is no table (counter flow)", async () => {
    await bootPage("/");
    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    const cartId = localStorage.getItem("fishchips.cartId");

    // `/order` with no table is the counter entry point: fall through to the
    // generic flow rather than wiping what the customer already chose.
    await bootPageKeepingStorage("/order");

    expect(localStorage.getItem("fishchips.cartId")).toBe(cartId);
    expect(document.getElementById("cart-count")!.textContent).toBe("1");
    expect(document.getElementById("table-badge")!.hidden).toBe(true);
  });

  it("carries the table onto the order", async () => {
    await bootPage("/order?table=12");
    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    const cartId = localStorage.getItem("fishchips.cartId")!;
    const response = await fetch(`${base}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartId }),
    });
    const { order } = (await response.json()) as { order: { tableNumber?: string } };

    expect(order.tableNumber).toBe("12");
  });

  it("refuses a mis-printed table without stranding the customer", async () => {
    await bootPage("/order?table=..%2Fadmin");

    // The menu still renders; the counter flow is not blocked by a bad sticker.
    expect(document.getElementById("view")!.textContent).toContain("table");
    expect(window.location.pathname).toBe("/");
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

describe("cart bar and sheet", async () => {
  /** Adds one Classic Battered Dory through the page, as a customer would. */
  async function addDory() {
    const dory = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes("Classic Battered Dory"),
    ) as HTMLButtonElement;
    dory.click();
    await settle(2);
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();
  }

  const bar = () => document.getElementById("cart-bar") as HTMLButtonElement;
  const panel = () => document.getElementById("cart-panel") as HTMLElement;
  const scrim = () => document.getElementById("scrim") as HTMLElement;

  it("shows nothing at all on an empty cart", async () => {
    await bootPage("/");

    // The bug this replaces: the panel was open over the menu on load, before
    // the customer had touched anything.
    expect(panel().hidden).toBe(true);
    expect(scrim().hidden).toBe(true);
    expect(bar().hidden).toBe(true);
    // And no strip reserved at the bottom of the menu for a bar that is not there.
    expect(document.body.classList.contains("has-cart")).toBe(false);
  });

  it("brings up the bar on the first item, without opening the sheet over the menu", async () => {
    await bootPage("/");
    await addDory();

    expect(bar().hidden).toBe(false);
    expect(bar().textContent).toContain("1");
    expect(document.getElementById("cart-bar-total")!.textContent).toBe("RM16.90");
    expect(bar().getAttribute("aria-expanded")).toBe("false");

    // Adding does not interrupt browsing — the menu is still what is on screen.
    expect(panel().hidden).toBe(true);
    // The menu now reserves room for the bar, so the last item stays reachable.
    expect(document.body.classList.contains("has-cart")).toBe(true);
  });

  it("opens from the bar and closes from the X", async () => {
    await bootPage("/");
    await addDory();

    bar().click();
    expect(panel().hidden).toBe(false);
    expect(scrim().hidden).toBe(false);
    expect(bar().getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("cart-body")!.textContent).toContain("Classic Battered Dory");

    // The other half of the bug: this set `hidden`, and a `display` rule in the
    // stylesheet outranked it, so the panel stayed put and the button looked dead.
    (document.getElementById("cart-close") as HTMLButtonElement).click();
    expect(panel().hidden).toBe(true);
    expect(scrim().hidden).toBe(true);
    expect(bar().getAttribute("aria-expanded")).toBe("false");
    // Still there to be reopened.
    expect(bar().hidden).toBe(false);
  });

  it("also closes on the dimmed background and on Escape", async () => {
    await bootPage("/");
    await addDory();

    bar().click();
    scrim().click();
    expect(panel().hidden).toBe(true);

    bar().click();
    expect(panel().hidden).toBe(false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().hidden).toBe(true);
  });

  it("takes itself away when the last item is removed from inside the sheet", async () => {
    await bootPage("/");
    await addDory();
    bar().click();

    const fewer = [...document.querySelectorAll("#cart-body .icon-button")].find(
      (button) => button.getAttribute("aria-label") === "Fewer",
    ) as HTMLButtonElement;
    fewer.click();
    await settle();

    // Nothing left to show, so there is nothing left on screen either.
    expect(document.getElementById("cart-count")!.textContent).toBe("0");
    expect(panel().hidden).toBe(true);
    expect(bar().hidden).toBe(true);
    expect(document.body.classList.contains("has-cart")).toBe(false);
  });

  it("keeps the checkout button working, and leaves the payment flow alone", async () => {
    await bootPage("/");
    await addDory();

    bar().click();
    (document.getElementById("checkout-button") as HTMLButtonElement).click();
    await settle();

    expect(window.location.pathname).toBe("/checkout");
    expect(document.getElementById("view")!.textContent).toContain("Card");
    // No bar over the checkout page: it already shows the total and the pay button.
    expect(bar().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("shows no cart on the order page", async () => {
    const orderId = await placeOrder();
    await bootPage(`/order/${orderId}`);

    expect(bar().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains("has-cart")).toBe(false);
  });
});

/**
 * The layout rules the two-state cart depends on.
 *
 * jsdom has no layout engine, so overlap and fold cannot be measured here —
 * these assert the mechanisms that produce them, which is what would silently
 * regress in an edit.
 */
describe("cart layout contract", () => {
  const css = readFileSync(`${webDir}/styles.css`, "utf8");
  const html = readFileSync(`${webDir}/index.html`, "utf8");

  it("makes `hidden` beat any class that sets display", () => {
    // The root cause of both bugs. Without this rule `.cart-panel { display: flex }`
    // outranks the UA's `[hidden] { display: none }` and the attribute does nothing.
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("reserves exactly the bar's height under the menu, and only when there is a bar", () => {
    expect(css).toContain("--cart-bar-h");
    expect(css).toMatch(/\.cart-bar\s*\{[^}]*height:\s*var\(--cart-bar-h\)/);
    expect(css).toMatch(/body\.has-cart \.view\s*\{[^}]*padding-bottom:\s*calc\(var\(--cart-bar-h\)/);
  });

  it("sizes the sheet against the visible viewport, not the address bar", () => {
    // `vh` counts the collapsing mobile address bar as visible screen, which is
    // what pushes a sheet's checkout button below the fold.
    expect(css).toMatch(/\.cart-panel\s*\{[^}]*max-height:\s*82dvh/);
  });

  it("keeps the checkout button outside the scrolling list", () => {
    // `.cart-foot` is a sibling of `.cart-body`, not inside it, so a long order
    // scrolls under a total and a button that stay on screen.
    const body = html.indexOf('id="cart-body"');
    const foot = html.indexOf('class="cart-foot"');
    const checkout = html.indexOf('id="checkout-button"');
    expect(body).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(body);
    expect(checkout).toBeGreaterThan(foot);
    expect(css).toMatch(/\.cart-body\s*\{[^}]*overflow-y:\s*auto/);
  });
});
