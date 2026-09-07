/**
 * @vitest-environment jsdom
 *
 * The cancellation flow as both sides of the counter actually see it: the real
 * customer page against the real server, and the real staff board markup.
 *
 * The thing worth testing on the customer's side is not the button — it is the
 * three states around it. Tapping cancel must **not** look like a cancellation,
 * because it is a request to a person who may say no, and a page that says
 * "cancelled" before the shop agrees is a page that lies about the fish already
 * in the fryer.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServices } from "../src/app/container.js";
import { createServer } from "../src/http/app.js";
import type { KitchenStatus } from "../src/orders/types.js";

let server: Server;
let base: string;
let services: ReturnType<typeof createServices>;

const webDir = resolve(process.cwd(), "src/web");
const appUrl = pathToFileURL(resolve(webDir, "app.js")).href;

beforeAll(async () => {
  services = createServices();
  server = createServer(services).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLElement) {
    this.removeAttribute("open");
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input;
    return realFetch(url as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function settle(rounds = 14) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Waits for the page to show something, rather than sleeping past the poller.
 *
 * The page polls every three seconds, so a fixed sleep is either flaky or slow.
 * This checks often and gives up loudly.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}; page said: ${view().textContent?.slice(0, 300)}`);
}

/** Places a real order through the real services and returns its id. */
async function placeOrder(status: KitchenStatus = "received"): Promise<string> {
  const cart = await services.carts.create();
  await services.carts.addLine(cart.id, { itemId: "fish-dory-classic" });
  const order = await services.orders.confirm({ cartId: cart.id });
  if (status !== "received") await services.orders.setKitchenStatus(order.id, status);
  return order.id;
}

/** Boots the real customer page on an order's tracking view. */
async function bootOrder(orderId: string) {
  document.documentElement.innerHTML = readFileSync(`${webDir}/index.html`, "utf8")
    .replace(/^[\s\S]*?<body>/, "")
    .replace(/<\/body>[\s\S]*$/, "");
  window.history.replaceState({}, "", `/order/${orderId}`);
  localStorage.clear();
  await import(/* @vite-ignore */ `${appUrl}?cache=${Math.random()}`);
  await settle();
}

const view = () => document.getElementById("view")!;
const cancelButton = () => view().querySelector(".cancel-order") as HTMLButtonElement | null;

describe("the customer's cancel button", () => {
  it("is offered while the order is only received", async () => {
    await bootOrder(await placeOrder("received"));

    expect(cancelButton()).not.toBeNull();
    expect(cancelButton()!.textContent).toBe("Cancel order");
    // And the page says where the food is, which it never used to.
    expect(view().textContent).toContain("Order received");
  });

  it("is still offered while it is being cooked", async () => {
    await bootOrder(await placeOrder("cooking"));

    expect(cancelButton()).not.toBeNull();
    expect(view().textContent).toContain("Being cooked");
  });

  it("is gone once the food is ready, and once it has been collected", async () => {
    // The cut-off. Past here the fish has been fried, and cancelling is a
    // conversation with a person rather than a button on a phone.
    for (const status of ["ready", "collected"] as const) {
      await bootOrder(await placeOrder(status));
      expect(cancelButton(), status).toBeNull();
    }
  });
});

describe("asking, and waiting", () => {
  it("shows a request, not a cancellation", async () => {
    const orderId = await placeOrder("received");
    await bootOrder(orderId);

    cancelButton()!.click();
    await settle();

    // The words matter here more than the markup: the customer must not think
    // it is done, because a staff member may still say no.
    expect(view().textContent).toContain("Cancellation requested");
    expect(view().textContent).toContain("Waiting for the shop");
    expect(view().textContent).not.toContain("Order cancelled");
    // The button is gone — there is nothing left to ask for.
    expect(cancelButton()).toBeNull();

    // And the server really has it, which is what raises the staff badge.
    const order = await services.orders.get(orderId);
    expect(order.cancellationRequested).toBe(true);
    expect(order.kitchenStatus).toBe("received");
  });

  it("explains a refusal from the server without cancelling anything", async () => {
    // The race that actually happens: the customer taps just as the kitchen
    // marks it ready.
    const orderId = await placeOrder("received");
    await bootOrder(orderId);
    await services.orders.setKitchenStatus(orderId, "ready");

    cancelButton()!.click();
    await settle();

    await waitFor(() => (view().querySelector(".cancel-error")?.textContent ?? "") !== "", "the refusal");
    expect(view().querySelector(".cancel-error")!.textContent).toMatch(/being prepared|cancel/i);
    expect((await services.orders.get(orderId)).cancellationRequested ?? false).toBe(false);
  });
});

describe("the outcome arrives without a refresh", () => {
  it("does not tell a customer their food is cooking when it has not started", async () => {
    // The stock line read as a flat contradiction under an "Order received"
    // badge, which is where it landed whenever staff declined before starting.
    const orderId = await placeOrder("received");
    await bootOrder(orderId);
    cancelButton()!.click();
    await settle();

    await services.orders.denyCancellation(orderId);
    await waitFor(() => view().querySelector(".denied-note") !== null, "the refusal to arrive");

    const note = view().querySelector(".denied-note")!.textContent!;
    expect(note).not.toContain("already being prepared");
    expect(note).toContain("still on its way");
    expect(view().textContent).toContain("Order received");
  });

  it("shows the cancellation, and what happened to the money", async () => {
    const orderId = await placeOrder("received");
    await bootOrder(orderId);

    cancelButton()!.click();
    await settle();
    expect(view().textContent).toContain("Cancellation requested");

    // Staff approve, somewhere else entirely. The page is not touched.
    await services.payments.approveCancellation(orderId);
    await waitFor(() => view().textContent!.includes("Order cancelled"), "the cancellation to arrive");
    // The refund line is the shop's own words, carried through.
    expect(view().querySelector(".refund-note")?.textContent).toMatch(/refund|paid|cash/i);
  });

  it("shows the order carrying on when staff say no", async () => {
    const orderId = await placeOrder("cooking");
    await bootOrder(orderId);

    cancelButton()!.click();
    await settle();

    await services.orders.denyCancellation(orderId);
    await waitFor(() => view().textContent!.includes("could not be cancelled"), "the refusal to arrive");

    // Not an error, and not a cancellation: the order is still coming.
    expect(view().textContent).toContain("could not be cancelled");
    expect(view().textContent).toContain("Being cooked");
    // And the words match the status they sit under.
    expect(view().querySelector(".denied-note")!.textContent).toBe(
      "Your order is already being prepared and could not be cancelled.",
    );
    expect(view().textContent).not.toContain("Order cancelled");
    // And they may ask again — the kitchen has not moved on yet.
    expect(cancelButton()).not.toBeNull();
  });

  it("stops polling once the order is somewhere final", async () => {
    // A cancelled order cannot change again, and a page left polling for ever
    // on a phone in someone's pocket is the reason this is checked.
    const orderId = await placeOrder("received");
    await bootOrder(orderId);
    cancelButton()!.click();
    await settle();
    await services.payments.approveCancellation(orderId);
    await waitFor(() => view().textContent!.includes("Order cancelled"), "the cancellation to arrive");

    // Put the order somewhere the page would notice if it were still polling.
    const drawn = view().textContent;
    await services.orders.setKitchenStatus(orderId, "cooking");
    // Longer than the 3s poll interval, so a page that was still polling would
    // have redrawn by now. That wait is what needs the raised timeout below.
    await settle(450);
    expect(view().textContent).toBe(drawn);
  }, 15_000);
});

/**
 * The staff side, against the real board markup.
 *
 * The badge is the whole feature from the counter's point of view: an order
 * somebody wants cancelled has to be obvious on the screen the kitchen is
 * already looking at, before they start frying it.
 */
describe("the staff boards flag it", () => {
  const staffDir = resolve(process.cwd(), "src/staff-web");

  it("draws the badge and both decisions on a flagged ticket", async () => {
    const common: any = await import(pathToFileURL(resolve(staffDir, "assets/common.js")).href);

    const flag = common.cancelFlag();
    expect(flag.className).toBe("cancel-flag");
    expect(flag.textContent).toBe("Cancellation requested");

    const chosen: string[] = [];
    const actions = common.cancelActions({ paymentStatus: "paid" }, (choice: string) => chosen.push(choice));
    const buttons = [...actions.querySelectorAll("button")] as HTMLButtonElement[];

    expect(buttons).toHaveLength(2);
    // Keep cooking sits first, so the destructive one is not under the thumb
    // that was reaching for "advance".
    expect(buttons[0]!.textContent).toBe("Keep cooking");
    // Named for what it does to the money, because it is about to move some.
    expect(buttons[1]!.textContent).toBe("Cancel & refund");

    buttons[0]!.click();
    buttons[1]!.click();
    expect(chosen).toEqual(["deny-cancel", "approve-cancel"]);
  });

  it("does not promise a refund on an order nobody has paid for", async () => {
    const common: any = await import(pathToFileURL(resolve(staffDir, "assets/common.js")).href);
    const actions = common.cancelActions({ paymentStatus: "pending" }, () => {});
    expect(actions.querySelector(".approve-cancel")!.textContent).toBe("Cancel order");
  });

  it("disables both while a decision is in flight", async () => {
    const common: any = await import(pathToFileURL(resolve(staffDir, "assets/common.js")).href);
    const actions = common.cancelActions({ paymentStatus: "paid" }, () => {}, true);
    for (const button of actions.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("wires the flag into both boards, not just one", () => {
    // An order flagged on the dashboard and not in the kitchen is an order that
    // sits flagged all through service because whoever looked was on the wrong
    // page. Both pages, both imports, both classes.
    for (const page of ["staff.html", "kitchen.html"]) {
      const html = readFileSync(resolve(staffDir, page), "utf8");
      expect(html, page).toContain("cancelFlag");
      expect(html, page).toContain("cancelActions");
      expect(html, page).toContain("wants-cancel");
      expect(html, page).toContain("order.cancellationRequested === true");
      // And each one can actually act on it: the endpoint name is built inside
      // `decide`, which is the function both boards route the buttons into.
      expect(html, page).toContain("async function decide(");
      expect(html, page).toContain("/api/staff/orders/");
    }

    // The two endpoint names themselves live once, in the shared helper.
    const common = readFileSync(resolve(staffDir, "assets/common.js"), "utf8");
    expect(common).toContain("approve-cancel");
    expect(common).toContain("deny-cancel");
  });

  it("styles the flag loudly enough to be seen across a kitchen", () => {
    const css = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8");
    const flag = css.slice(css.indexOf(".cancel-flag {"), css.indexOf("}", css.indexOf(".cancel-flag {")));
    expect(flag).toContain("var(--danger)");
    expect(css).toContain(".ticket.wants-cancel");
    expect(css).toContain(".card.wants-cancel");
  });
});
