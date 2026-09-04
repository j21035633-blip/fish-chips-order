/**
 * @vitest-environment jsdom
 *
 * The staff layout, exercised as the real pages load it. Every view shares one
 * nav module, so a broken link or a mislabelled tab breaks here rather than in
 * front of whoever is on the pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

// jsdom serves import.meta.url over http, so resolve from the project root.
const staffDir = resolve(process.cwd(), "src/staff-web");
const navUrl = pathToFileURL(resolve(staffDir, "assets/nav.js")).href;
const commonUrl = pathToFileURL(resolve(staffDir, "assets/common.js")).href;

const nav: any = await import(navUrl);
const common: any = await import(commonUrl);

/** Puts the document in the state a served page arrives in. */
function mountAs(view: string, base = "/staff-a8f3k2m9"): void {
  document.body.replaceChildren();
  document.body.dataset.staffBase = base;
  document.body.dataset.staffView = view;
}

beforeEach(() => {
  mountAs("dashboard");
});

describe("staff nav", () => {
  it("offers every view, in order", () => {
    const labels = [...nav.staffNav().querySelectorAll("a")].map((link: Element) => link.textContent);
    expect(labels).toEqual(["Dashboard", "Kitchen & Counter", "Sales Report", "Menu", "Table QR Codes", "Approvals"]);
  });

  it("builds links from the path the area is mounted at", () => {
    const hrefs = [...nav.staffNav().querySelectorAll("a")].map((link: Element) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/staff-a8f3k2m9",
      "/staff-a8f3k2m9/kitchen",
      "/staff-a8f3k2m9/sales",
      "/staff-a8f3k2m9/menu",
      "/staff-a8f3k2m9/qr",
      "/staff-a8f3k2m9/approvals",
    ]);

    // The mount point is configurable, so nothing may be hard-coded.
    mountAs("dashboard", "/staff");
    const moved = [...nav.staffNav().querySelectorAll("a")].map((link: Element) => link.getAttribute("href"));
    expect(moved).toEqual([
      "/staff",
      "/staff/kitchen",
      "/staff/sales",
      "/staff/menu",
      "/staff/qr",
      "/staff/approvals",
    ]);
  });

  it("marks exactly the view the page is, on each of the three", () => {
    const views: [string, string][] = [
      ["dashboard", "Dashboard"],
      ["kitchen", "Kitchen & Counter"],
      ["sales", "Sales Report"],
      ["menu", "Menu"],
      ["qr", "Table QR Codes"],
      ["approvals", "Approvals"],
    ];
    for (const [view, expected] of views) {
      mountAs(view);
      const current = [...nav.staffNav().querySelectorAll('a[aria-current="page"]')];
      expect(current.map((link: Element) => link.textContent), view).toEqual([expected]);
    }
  });

  it("mounts one header, nav included, at the top of the page", () => {
    document.body.append(document.createElement("main"));
    const { slot } = nav.mountStaffChrome({ title: "Sales Report" });

    const header = document.body.firstElementChild!;
    expect(header.tagName).toBe("HEADER");
    expect(header.querySelector("h1")?.textContent).toBe("Sales Report");
    expect(header.querySelectorAll(".staff-nav a")).toHaveLength(nav.STAFF_VIEWS.length);

    // The slot is the one part a view fills in for itself.
    slot.append(document.createElement("span"));
    expect(header.querySelector(".header-slot")?.children).toHaveLength(1);
  });

  it("puts a log out button on every view, last in the header", () => {
    for (const view of ["dashboard", "kitchen", "sales", "menu", "qr", "approvals"]) {
      mountAs(view);
      const { header } = nav.mountStaffChrome({ title: "Anything" });

      const logout = header.querySelector(".logout");
      expect(logout?.textContent, view).toBe("Log out");
      // A button, not a link: it changes state, so a prefetch must not fire it.
      expect(logout?.tagName, view).toBe("BUTTON");
      expect(header.lastElementChild, view).toBe(logout);
    }
  });
});

describe("staff page markup", () => {
  const pages: [string, string][] = [
    ["staff.html", "dashboard"],
    ["kitchen.html", "kitchen"],
    ["sales.html", "sales"],
    ["menu.html", "menu"],
    ["qr.html", "qr"],
    ["approvals.html", "approvals"],
    ["login.html", "login"],
  ];

  it("declares which view it is, and asks for its assets through the mount path", () => {
    for (const [file, view] of pages) {
      const html = readFileSync(resolve(staffDir, file), "utf8");
      expect(html, file).toContain(`data-staff-view="${view}"`);
      expect(html, file).toContain('data-staff-base="{{STAFF_BASE}}"');
      // Relative URLs would resolve differently on /staff and /staff/kitchen.
      expect(html, file).toContain('href="{{STAFF_BASE}}/assets/staff.css"');
      expect(html, file).not.toMatch(/(?:src|href)="\.?\/?assets\//);
    }
  });

  it("moves orders with PATCH, the verb the endpoint documents", () => {
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = readFileSync(resolve(staffDir, file), "utf8");
      expect(html, file).toContain('method: "PATCH"');
    }
  });
});

describe("shared helpers", () => {
  it("formats a business day for an axis without shifting it", () => {
    // Read as UTC, so a tablet west of the shop does not label the day before.
    expect(common.shortDay("2024-03-01")).toContain("Mar");
    expect(common.shortDay("2024-03-01")).toContain("1");
  });

  it("builds elements without ever touching innerHTML", () => {
    const node = common.el("p", { class: "empty", text: "<b>not markup</b>" });
    expect(node.className).toBe("empty");
    expect(node.textContent).toBe("<b>not markup</b>");
    expect(node.querySelector("b")).toBeNull();
  });

  it("turns a 401 into an error rather than letting the caller carry on", async () => {
    // Mounted as the login page so the redirect is a no-op — jsdom cannot
    // navigate, and the throw is the half worth asserting here anyway. The
    // redirect itself is covered server-side, where the guard actually lives.
    mountAs("login");
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "staff_auth_required", message: "Sign in to use the staff area." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    try {
      await expect(common.api("/api/staff/overview")).rejects.toThrow("Sign in");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("order labels", () => {
  it("names a table, a takeaway number, and a bare counter order", async () => {
    expect(common.orderLabel({ tableNumber: "6" })).toEqual({ text: "Table 6", takeaway: false });
    expect(common.orderLabel({ takeawayNumber: 3 })).toEqual({ text: "Takeaway #3", takeaway: true });
    // A QR order with no table: the same kind of thing, without a number.
    expect(common.orderLabel({})).toEqual({ text: "Counter / takeaway", takeaway: true });
  });

  it("badges anything that is not going to a table", () => {
    const tag = common.takeawayTag();
    expect(tag.textContent).toBe("Takeaway");
    expect(tag.className).toContain("takeaway-tag");
  });

  it("shows the badge on both boards", () => {
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = readFileSync(resolve(staffDir, file), "utf8");
      expect(html, file).toContain("takeawayTag()");
      expect(html, file).toContain("orderLabel(order)");
    }
  });
});

describe("staff dialogs stay shut until opened", () => {
  // Comments stripped first: one of them quotes the broken rule to explain it.
  const css = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("never sets display on a bare dialog class", () => {
    // A <dialog> is hidden by the UA rule `dialog:not([open]) { display: none }`,
    // and an author rule beats the UA stylesheet whatever its specificity — so a
    // plain `.some-dialog { display: flex }` leaves an empty sheet on the page
    // before anyone opens it. This caught exactly that.
    for (const rule of css.matchAll(/\.([a-z-]*dialog[a-z-]*)(\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      const [, name, attribute, body] = rule;
      if (/display\s*:/.test(body!)) {
        expect(`${name}${attribute ?? ""} sets display`).toBe(`${name}[open] sets display`);
      }
    }
  });
});

describe("quick add on the pass", () => {
  const html = readFileSync(resolve(staffDir, "kitchen.html"), "utf8");
  const css = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8");

  it("makes `hidden` beat any class that sets display", () => {
    // The staff sheet needs this as much as the customer one: `.cat-items`
    // sets `display: grid`, which outranks the UA's `[hidden]` rule and left a
    // section expanded after it had been closed.
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it("has no button-and-modal entry point left", () => {
    // The panel is the only way in now; the old dialog is gone entirely.
    expect(html).not.toContain("New Takeaway Order");
    expect(html).not.toContain('id="takeaway"');
    expect(html).not.toContain("takeaway-panel");
  });

  it("keeps the quick-add panel in the page, not behind anything", () => {
    // Markup, not script: it has to be there on load rather than built on a tap.
    expect(html).toContain("Quick add (take away)");
    expect(html).toContain('id="categories"');
    expect(html).toContain('id="walkin-lines"');
    expect(html).toContain('id="create-order"');
    // And the section is not itself hidden.
    expect(html).not.toMatch(/<section class="quick-add"[^>]*hidden/);
  });

  it("still posts to the takeaway route the backend already has", () => {
    expect(html).toContain("/api/staff/orders/takeaway");
    expect(html).toContain('JSON.stringify({ cartId: walkin.cartId, payment })');
    // Built on the customer's own cart endpoints, not a second pricing path.
    expect(html).toContain("/api/carts");
  });

  it("reuses the customer's option groups rather than a second modal", () => {
    expect(html).toContain('from "/menu-browse.js"');
    expect(html).toContain("optionGroup(group, priceOptions)");
    // An item with no options must not open an empty sheet.
    expect(html).toContain("if (item.optionGroups.length === 0)");
  });
});
