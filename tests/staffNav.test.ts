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
    expect(labels).toEqual(["Dashboard", "Kitchen & Counter", "Sales Report", "Menu"]);
  });

  it("builds links from the path the area is mounted at", () => {
    const hrefs = [...nav.staffNav().querySelectorAll("a")].map((link: Element) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/staff-a8f3k2m9",
      "/staff-a8f3k2m9/kitchen",
      "/staff-a8f3k2m9/sales",
      "/staff-a8f3k2m9/menu",
    ]);

    // The mount point is configurable, so nothing may be hard-coded.
    mountAs("dashboard", "/staff");
    const moved = [...nav.staffNav().querySelectorAll("a")].map((link: Element) => link.getAttribute("href"));
    expect(moved).toEqual(["/staff", "/staff/kitchen", "/staff/sales", "/staff/menu"]);
  });

  it("marks exactly the view the page is, on each of the three", () => {
    const views: [string, string][] = [
      ["dashboard", "Dashboard"],
      ["kitchen", "Kitchen & Counter"],
      ["sales", "Sales Report"],
      ["menu", "Menu"],
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
});

describe("staff page markup", () => {
  const pages: [string, string][] = [
    ["staff.html", "dashboard"],
    ["kitchen.html", "kitchen"],
    ["sales.html", "sales"],
    ["menu.html", "menu"],
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
});
