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
    // The sheet shows the breakdown; the total is what will be charged.
    expect(document.getElementById("cart-subtotal")!.textContent).toBe("RM16.90");
    expect(document.getElementById("cart-tax-label")!.textContent).toBe("Tax (10%)");
    expect(document.getElementById("cart-tax")!.textContent).toBe("RM1.69");
    expect(document.getElementById("cart-total")!.textContent).toBe("RM18.59");
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

    // Two gateways, plus settling with staff on the way out.
    const methods = view.querySelectorAll(".method");
    expect(methods).toHaveLength(3);
    expect(view.textContent).toContain("Card");
    expect(view.textContent).toContain("E-wallet / QR");
    expect(view.textContent).toContain("Touch 'n Go");
    expect(view.textContent).toContain("Pay at counter");

    // Card is preselected so the customer can pay without choosing.
    const checked = view.querySelector('input[name="method"]:checked') as HTMLInputElement;
    expect(checked.value).toBe("card");

    // No keys configured in tests, so both rails advertise test mode.
    expect(view.querySelectorAll(".method-sim")).toHaveLength(2);
    expect(view.textContent).toContain("Pay RM18.59");
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

    // The recovery panel is a full method picker, not a dead end — but only of
    // the two gateways. This order already exists as a gateway order, and its
    // button goes straight to startPayment; settling it at the counter is a
    // conversation with staff, not a radio on the customer's phone.
    expect(view.textContent).toContain("How would you like to pay?");
    expect(view.querySelectorAll(".method")).toHaveLength(2);
    expect(view.textContent).not.toContain("Pay at counter");
    expect(view.textContent).toContain("Pay RM18.59");
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
    expect(view.textContent).toContain("Pay RM18.59");
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
    // The bar carries the charged total; the breakdown is one tap away.
    expect(document.getElementById("cart-bar-total")!.textContent).toBe("RM18.59");
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

  it("dresses both sheets from the same chrome", () => {
    // One grip class and one head class, used by the cart panel and the item
    // dialog alike — a second dismiss design is the thing to catch here.
    expect(css).toMatch(/\.sheet-grip\s*\{/);
    expect(css).toMatch(/\.sheet-head\s*\{/);
    expect(css).not.toMatch(/\.cart-grip\s*\{/);
    for (const parent of ["cart-panel", "item-dialog"]) {
      const scope = html.slice(html.indexOf(`id="${parent}"`));
      expect(scope.slice(0, scope.indexOf("</dialog>") + 1 || 900), parent).toContain("sheet-grip");
      expect(scope.slice(0, 900), parent).toContain("sheet-head");
    }
  });

  it("keeps Add reachable however many option groups an item has", () => {
    // Same rule as the cart's foot: the body scrolls, the foot does not.
    expect(css).toMatch(/#item-dialog-body\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.dialog form\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.dialog\s*\{[^}]*max-height:\s*88dvh/);
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

describe("item options sheet", async () => {
  const dialog = () => document.getElementById("item-dialog") as HTMLElement;
  const isOpen = () => dialog().hasAttribute("open");

  /** Opens the options sheet for an item by tapping its row, as a customer would. */
  async function openItem(name: string) {
    const row = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes(name),
    ) as HTMLButtonElement;
    row.click();
    await settle(2);
    expect(isOpen()).toBe(true);
  }

  /** Whether anything has reached the cart. */
  const cartCount = () => document.getElementById("cart-count")!.textContent;

  it("names the item in the sheet head, beside the close button", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    expect(document.getElementById("item-title")!.textContent).toBe("Hand-Cut Chips");
    // The head is the cart sheet's head, not a second design.
    expect(document.querySelector("#item-dialog .sheet-head .icon-button")).toBeTruthy();
    expect(document.querySelector("#item-dialog .sheet-grip")).toBeTruthy();
  });

  it("closes on the X without ordering anything", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    (document.getElementById("item-close") as HTMLButtonElement).click();
    await settle(2);

    expect(isOpen()).toBe(false);
    expect(cartCount()).toBe("0");
    expect((document.getElementById("cart-bar") as HTMLElement).hidden).toBe(true);
  });

  it("closes on the backdrop and on Escape", async () => {
    await bootPage("/");

    await openItem("Hand-Cut Chips");
    // A click landing on the dialog element itself is a click outside the sheet.
    dialog().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(false);

    await openItem("Hand-Cut Chips");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen()).toBe(false);

    // A click *inside* the sheet must not close it — that is the same listener.
    await openItem("Hand-Cut Chips");
    document.getElementById("item-dialog-body")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(isOpen()).toBe(true);

    expect(cartCount()).toBe("0");
  });

  it("closes on a swipe down of the grip, and not on a nudge", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    const grip = document.getElementById("item-grip")!;
    const drag = (from: number, to: number) => {
      grip.dispatchEvent(new window.MouseEvent("pointerdown", { clientY: from, bubbles: true }));
      grip.dispatchEvent(new window.MouseEvent("pointermove", { clientY: to, bubbles: true }));
      grip.dispatchEvent(new window.MouseEvent("pointerup", { clientY: to, bubbles: true }));
    };

    // A short drag is a mis-tap, not a dismissal.
    drag(100, 130);
    expect(isOpen()).toBe(true);

    drag(100, 300);
    expect(isOpen()).toBe(false);
    expect(cartCount()).toBe("0");
  });

  it("discards the options and quantity that were being chosen", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    // Upsize and bump the quantity, then walk away from it.
    const large = document.querySelector('#item-dialog-body input[value="large"]') as HTMLInputElement;
    large.checked = true;
    large.dispatchEvent(new window.Event("change", { bubbles: true }));
    (document.querySelector('#item-dialog [data-qty="1"]') as HTMLButtonElement).click();
    expect(document.getElementById("item-qty")!.textContent).toBe("2");
    expect(document.getElementById("item-price")!.textContent).toBe("RM23.80");

    (document.getElementById("item-close") as HTMLButtonElement).click();
    await settle(2);

    // Nothing ordered, and the next open starts from scratch rather than
    // remembering a choice the customer abandoned.
    expect(cartCount()).toBe("0");
    await openItem("Hand-Cut Chips");
    expect(document.getElementById("item-qty")!.textContent).toBe("1");
    expect(document.getElementById("item-price")!.textContent).toBe("RM7.90");
    expect((document.querySelector('#item-dialog-body input[value="large"]') as HTMLInputElement).checked).toBe(false);
  });

  it("still adds the item when Add is the thing that was tapped", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    expect(isOpen()).toBe(false);
    expect(cartCount()).toBe("1");
    expect((document.getElementById("cart-bar") as HTMLElement).hidden).toBe(false);
  });
});

describe("view cart from the options sheet", async () => {
  const dialog = () => document.getElementById("item-dialog") as HTMLElement;
  const viewCart = () => document.getElementById("item-view-cart") as HTMLButtonElement;
  const panel = () => document.getElementById("cart-panel") as HTMLElement;

  async function openItem(name: string) {
    const row = [...document.querySelectorAll("button.item")].find((item) =>
      item.textContent?.includes(name),
    ) as HTMLButtonElement;
    row.click();
    await settle(2);
  }

  async function addDory() {
    await openItem("Classic Battered Dory");
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();
  }

  it("is not offered while the cart is empty", async () => {
    await bootPage("/");
    await openItem("Hand-Cut Chips");

    // Nothing to go and look at yet.
    expect(viewCart().hidden).toBe(true);
  });

  it("appears with the count once there is something in the cart", async () => {
    await bootPage("/");
    await addDory();
    await openItem("Hand-Cut Chips");

    expect(viewCart().hidden).toBe(false);
    expect(viewCart().textContent).toBe("View cart (1 item)");

    // Singular and plural, because "1 items" reads like a bug.
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();
    await openItem("Hand-Cut Chips");
    expect(viewCart().textContent).toBe("View cart (2 items)");
  });

  it("opens the cart, and comes back with the selection untouched", async () => {
    await bootPage("/");
    await addDory();
    await openItem("Hand-Cut Chips");

    // Mid-customisation: upsized, quantity 3.
    const large = document.querySelector('#item-dialog-body input[value="large"]') as HTMLInputElement;
    large.checked = true;
    large.dispatchEvent(new window.Event("change", { bubbles: true }));
    const more = document.querySelector('#item-dialog [data-qty="1"]') as HTMLButtonElement;
    more.click();
    more.click();
    expect(document.getElementById("item-qty")!.textContent).toBe("3");
    expect(document.getElementById("item-price")!.textContent).toBe("RM35.70");

    viewCart().click();
    await settle(2);

    // The cart is what is on screen, showing the order so far.
    expect(panel().hidden).toBe(false);
    expect(document.getElementById("cart-body")!.textContent).toContain("Classic Battered Dory");

    (document.getElementById("cart-close") as HTMLButtonElement).click();
    await settle(2);

    // And back to exactly where they were — nothing reset, nothing ordered.
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(document.getElementById("item-title")!.textContent).toBe("Hand-Cut Chips");
    expect((document.querySelector('#item-dialog-body input[value="large"]') as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("item-qty")!.textContent).toBe("3");
    expect(document.getElementById("item-price")!.textContent).toBe("RM35.70");
    expect(document.getElementById("cart-count")!.textContent).toBe("1");
  });

  it("comes back however the cart was dismissed", async () => {
    await bootPage("/");
    await addDory();

    for (const dismiss of [
      () => (document.getElementById("scrim") as HTMLElement).click(),
      () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    ]) {
      await openItem("Hand-Cut Chips");
      viewCart().click();
      await settle(2);
      expect(panel().hidden).toBe(false);

      dismiss();
      await settle(2);
      expect(dialog().hasAttribute("open")).toBe(true);

      (document.getElementById("item-close") as HTMLButtonElement).click();
      await settle(2);
    }
  });

  it("does not come back when the customer leaves for checkout", async () => {
    await bootPage("/");
    await addDory();
    await openItem("Hand-Cut Chips");

    viewCart().click();
    await settle(2);
    (document.getElementById("checkout-button") as HTMLButtonElement).click();
    await settle();

    // The options sheet must not reappear over the payment page.
    expect(window.location.pathname).toBe("/checkout");
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(panel().hidden).toBe(true);
  });

  it("shows the tax breakdown on the checkout page it leads to", async () => {
    await bootPage("/");
    await addDory();
    (document.getElementById("cart-bar") as HTMLButtonElement).click();
    (document.getElementById("checkout-button") as HTMLButtonElement).click();
    await settle();

    const view = document.getElementById("view")!;
    expect(view.textContent).toContain("Subtotal");
    expect(view.textContent).toContain("RM16.90");
    expect(view.textContent).toContain("Tax (10%)");
    expect(view.textContent).toContain("RM1.69");
    // And the button charges the total, not the subtotal.
    expect(view.textContent).toContain("Pay RM18.59");
  });
});

/** The page's main region, which every test below reads. */
const view = () => document.getElementById("view")!;

/**
 * Scanning the Play QR, on the real customer page.
 *
 * Two states matter and they are easy to get backwards: with a chance in hand
 * the game should simply open, and with none — the normal case for somebody who
 * has just sat down — an empty game screen would be a dead end, so it has to
 * explain how a chance is earned instead.
 */
describe("landing from the Play QR", () => {
  const dialogOpen = () => document.getElementById("fish")!.hasAttribute("open");

  it("explains how to earn a chance rather than opening an empty game", async () => {
    await bootPage("/order?table=7&view=fish");

    const text = view().textContent!;
    // The four ways in, in the customer's own terms.
    expect(text).toContain("RM50");
    expect(text).toContain("review");
    expect(text).toContain("Share");
    expect(text).toMatch(/phone number or email/i);

    // And emphatically not a game with nothing to do in it.
    expect(dialogOpen()).toBe(false);
    expect(view().querySelector(".game-intro")).not.toBeNull();
  });

  it("offers a way out, into the menu", async () => {
    await bootPage("/order?table=7&view=fish");

    const start = [...view().querySelectorAll("button")].find(
      (button) => button.textContent === "Start your order",
    ) as HTMLButtonElement;
    expect(start).toBeDefined();

    start.click();
    await settle();
    expect(view().textContent).toContain("Classic Battered Dory");
  });

  it("starts a fresh session at a table, exactly as the Order QR does", async () => {
    // Worth stating plainly, because it is the reason the earn screen is the
    // *normal* landing: a scan always opens a new session, so a Play code on a
    // table has no chances on it yet. That rule is older than this feature and
    // is not bent for it — the previous diner's cart must never carry over.
    await bootPage("/order?table=7");
    const first = localStorage.getItem("fishchips.cartId");

    await bootPageKeepingStorage("/order?table=7&view=fish");

    expect(localStorage.getItem("fishchips.cartId")).not.toBe(first);
    expect(dialogOpen()).toBe(false);
  });

  it("opens the game straight away when the session already has a chance", async () => {
    // No table on this one, so the session carries: a poster or a counter-top
    // tent, rather than a sticker that re-seats somebody.
    await bootPage("/");
    const cartId = localStorage.getItem("fishchips.cartId")!;
    // Earned the honest way, through the real endpoint.
    await fetch(`${base}/api/order/chances/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartId, contact: "player@example.com" }),
    });

    await bootPageKeepingStorage("/order?view=fish");

    expect(localStorage.getItem("fishchips.cartId")).toBe(cartId);
    expect(dialogOpen()).toBe(true);
  });

  it("is the same session as the Order QR, not a second one", async () => {
    // The claim the whole feature rests on: one table, one cart, one ledger.
    await bootPage("/order?table=7&view=fish");
    const fromPlay = localStorage.getItem("fishchips.cartId");
    expect(fromPlay).toBeTruthy();

    const cart = await (await fetch(`${base}/api/carts/${fromPlay}`)).json();
    expect(cart.cart.tableNumber).toBe("7");
  });

  it("leaves the plain Order QR landing on the menu, as it always did", async () => {
    await bootPage("/order?table=7");

    expect(dialogOpen()).toBe(false);
    expect(view().textContent).toContain("Classic Battered Dory");
    expect(view().querySelector(".game-intro")).toBeNull();
  });

  it("tidies the parameter away, so a refresh does not re-open the game", async () => {
    // Same reason the table parameter is dropped: a refresh should resume this
    // customer's session, not replay the scan.
    await bootPage("/order?table=7&view=fish");
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("");
  });

  it("agrees with the code that mints the URL", async () => {
    // The page reads "fish" and `src/qr/tables.ts` writes it. Two constants,
    // one string — this is what stops them drifting apart.
    const { PLAY_VIEW } = await import("../src/qr/tables.js");
    const app = readFileSync(resolve(webDir, "app.js"), "utf8");
    expect(app).toContain(`const PLAY_VIEW = "${PLAY_VIEW}";`);
  });
});

/** The staff page has to show both, and say which is which. */
describe("the staff QR page offers both codes", () => {
  const staffDir = resolve(process.cwd(), "src/staff-web");
  const html = () => readFileSync(resolve(staffDir, "qr.html"), "utf8");

  it("draws a labelled pair per table", () => {
    const page = html();
    expect(page).toContain("function code({ kind, table, url, png })");
    expect(page).toContain('code({ kind: "Order"');
    expect(page).toContain('code({ kind: "Play"');
    expect(page).toContain("entry.playUrl");
    expect(page).toContain("entry.playPng");
  });

  it("names the downloads apart, so two files do not overwrite each other", () => {
    expect(html()).toContain("download: `table-${table}-${kind.toLowerCase()}.png`");
  });

  it("tells staff what the difference is", () => {
    const page = html();
    expect(page).toMatch(/Play<\/strong> opens the\s+fishing game/);
    expect(page).toContain("table tent");
  });

  it("styles the two labels apart, and keeps them legible in print", () => {
    const css = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8");
    expect(css).toContain(".qr-order .qr-kind");
    expect(css).toContain(".qr-play .qr-kind");
    // Printed in grey, a colour-only distinction is no distinction at all.
    expect(css.slice(css.indexOf("@media print"))).toContain(".qr-kind");
  });
});

/**
 * Editing and removing a line from the order.
 *
 * The quantity stepper already existed and is deliberately untouched; these are
 * the two things it could not do — change what was chosen, and take a line out
 * without tapping minus down to nothing.
 */
describe("editing a line in the order", () => {
  const cartBody = () => document.getElementById("cart-body")!;
  const lines = () => [...cartBody().querySelectorAll(".cart-line")];
  const sheetOpen = () => document.getElementById("item-dialog")!.hasAttribute("open");

  /** Adds one item from the menu, choosing whatever its first group offers. */
  async function addItem(name: string, choiceIndex = 0) {
    const item = [...document.getElementById("view")!.querySelectorAll("button.item")].find((button) =>
      button.textContent?.includes(name),
    ) as HTMLButtonElement;
    item.click();
    await settle();

    const body = document.getElementById("item-dialog-body")!;
    const radios = [...body.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    if (radios[choiceIndex]) radios[choiceIndex].click();

    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();
  }

  it("offers Edit and Remove beside the stepper, without disturbing it", async () => {
    await bootPage("/");
    await addItem("Classic Battered Dory");
    document.getElementById("cart-bar")!.click();
    await settle();

    const line = lines()[0]!;
    // The stepper is still exactly where it was.
    expect(line.querySelectorAll(".qty .icon-button")).toHaveLength(2);
    expect(line.querySelector(".qty output")!.textContent).toBe("1");

    const actions = [...line.querySelectorAll(".line-action")].map((button) => button.textContent);
    expect(actions).toEqual(["Edit", "Remove"]);
  });

  it("removes the whole line on one tap, whatever the quantity", async () => {
    await bootPage("/");
    await addItem("Classic Battered Dory");
    document.getElementById("cart-bar")!.click();
    await settle();

    // Two of them, so this is not the stepper reaching zero.
    (lines()[0]!.querySelectorAll(".qty .icon-button")[1] as HTMLButtonElement).click();
    await settle();
    expect(lines()[0]!.querySelector(".qty output")!.textContent).toBe("2");

    (lines()[0]!.querySelector(".line-action.remove") as HTMLButtonElement).click();
    await settle();

    expect(lines()).toHaveLength(0);
    // And everything that hangs off the cart moved with it.
    expect(document.getElementById("cart-count")!.textContent).toBe("0");
    expect(document.getElementById("cart-total")!.textContent).toBe("RM0.00");
    expect(document.body.classList.contains("has-cart")).toBe(false);
  });

  it("reopens the sheet on the line's own choices, not the defaults", async () => {
    await bootPage("/");
    // Pick the *second* choice, so a sheet showing defaults would be visibly wrong.
    await addItem("Classic Battered Dory", 1);
    document.getElementById("cart-bar")!.click();
    await settle();

    const chosen = lines()[0]!.querySelector(".cart-line-opts")!.textContent!;
    (lines()[0]!.querySelector(".line-action") as HTMLButtonElement).click();
    await settle();

    expect(sheetOpen()).toBe(true);
    const checked = [
      ...document.getElementById("item-dialog-body")!.querySelectorAll("input:checked"),
    ] as HTMLInputElement[];
    const labels = checked.map((input) => input.closest("label")!.querySelector(".choice-name")!.textContent);
    for (const label of labels) expect(chosen).toContain(label);

    // The quantity comes back too, and the button says what it will do.
    expect(document.getElementById("item-qty")!.textContent).toBe("1");
    expect(document.getElementById("item-add")!.textContent).toContain("Save");
  });

  it("updates the line in place rather than adding a second one", async () => {
    await bootPage("/");
    await addItem("Classic Battered Dory", 0);
    document.getElementById("cart-bar")!.click();
    await settle();
    const before = lines()[0]!.querySelector(".cart-line-opts")!.textContent;

    (lines()[0]!.querySelector(".line-action") as HTMLButtonElement).click();
    await settle();

    const radios = [
      ...document.getElementById("item-dialog-body")!.querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    radios[1]!.click();
    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    // One line, not two — this is the whole point of Edit.
    expect(lines()).toHaveLength(1);
    expect(document.getElementById("cart-count")!.textContent).toBe("1");
    expect(lines()[0]!.querySelector(".cart-line-opts")!.textContent).not.toBe(before);
  });

  it("carries the quantity through an edit", async () => {
    await bootPage("/");
    await addItem("Classic Battered Dory");
    document.getElementById("cart-bar")!.click();
    await settle();
    (lines()[0]!.querySelectorAll(".qty .icon-button")[1] as HTMLButtonElement).click();
    await settle();

    (lines()[0]!.querySelector(".line-action") as HTMLButtonElement).click();
    await settle();
    expect(document.getElementById("item-qty")!.textContent).toBe("2");

    (document.getElementById("item-add") as HTMLButtonElement).click();
    await settle();

    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.querySelector(".qty output")!.textContent).toBe("2");
  });

  it("recalculates the total and the tax the moment a line goes", async () => {
    await bootPage("/");
    await addItem("Classic Battered Dory");
    await addItem("Classic Battered Dory");
    document.getElementById("cart-bar")!.click();
    await settle();

    const twoLines = document.getElementById("cart-total")!.textContent;
    (lines()[0]!.querySelector(".line-action.remove") as HTMLButtonElement).click();
    await settle();

    expect(lines()).toHaveLength(1);
    expect(document.getElementById("cart-total")!.textContent).not.toBe(twoLines);
    // The three-line breakdown lives in the foot, outside the scrolling body,
    // and is redrawn from the server's own numbers.
    const panel = document.getElementById("cart-panel")!;
    expect(panel.textContent).toContain("Subtotal");
    expect(panel.textContent).toContain("Tax");
  });

  it("leaves the sheet's own dismissals alone", async () => {
    // An abandoned edit must change nothing — the same rule an abandoned add
    // already follows.
    await bootPage("/");
    await addItem("Classic Battered Dory", 0);
    document.getElementById("cart-bar")!.click();
    await settle();
    const before = lines()[0]!.querySelector(".cart-line-opts")!.textContent;

    (lines()[0]!.querySelector(".line-action") as HTMLButtonElement).click();
    await settle();
    const radios = [
      ...document.getElementById("item-dialog-body")!.querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    radios[1]!.click();
    (document.getElementById("item-close") as HTMLButtonElement).click();
    await settle();

    expect(sheetOpen()).toBe(false);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.querySelector(".cart-line-opts")!.textContent).toBe(before);
  });

  it("offers no Edit on an item with nothing to choose", async () => {
    await bootPage("/");
    const plain = [...document.getElementById("view")!.querySelectorAll("button.item")].find((button) => {
      const name = button.textContent ?? "";
      return name.includes("Curry Sauce") || name.includes("Mushy Peas");
    }) as HTMLButtonElement | undefined;
    if (!plain) return; // No option-free item on the menu; nothing to assert.

    plain.click();
    await settle();
    // An item with no groups goes straight in — no sheet to open.
    document.getElementById("cart-bar")!.click();
    await settle();

    const line = lines().find((entry) => entry.textContent?.includes(plain.textContent!.split("RM")[0]!.trim()));
    if (!line) return;
    expect(line.querySelector(".line-action.remove")).not.toBeNull();
    expect([...line.querySelectorAll(".line-action")].map((b) => b.textContent)).not.toContain("Edit");
  });
});
