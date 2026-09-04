// The staff layout: one header, one nav, three views.
//
// Every page under the staff path calls `mountStaffChrome` instead of writing
// its own header, so the nav is defined once and a fourth view is one entry in
// the list below.

import { el } from "./common.js";

/**
 * `path` is relative to wherever the staff area is mounted — the mount point is
 * configurable (`STAFF_DASHBOARD_PATH`), so the base is injected into the page
 * as `data-staff-base` at serve time rather than hard-coded here.
 */
export const STAFF_VIEWS = [
  { id: "dashboard", label: "Dashboard", path: "" },
  { id: "kitchen", label: "Kitchen & Counter", path: "/kitchen" },
  { id: "sales", label: "Sales Report", path: "/sales" },
  { id: "menu", label: "Menu", path: "/menu" },
];

/** The path the staff area is served under, e.g. "/staff-a8f3k2m9". */
export function staffBase() {
  return document.body.dataset.staffBase ?? "";
}

/** Which of the views this document is. Set per page on `<body>`. */
export function staffView() {
  return document.body.dataset.staffView ?? "";
}

/**
 * The nav on its own — one link per view, the active one marked.
 *
 * Links rather than buttons: these are navigations, so they open in a new tab,
 * announce as links, and work with the browser's own back button.
 */
export function staffNav(active = staffView()) {
  const base = staffBase();
  return el(
    "nav",
    { class: "staff-nav", "aria-label": "Staff views" },
    STAFF_VIEWS.map((view) =>
      el("a", {
        href: `${base}${view.path}`,
        text: view.label,
        // aria-current is what marks the active view; the fill is styled off it,
        // so the two can never disagree.
        "aria-current": view.id === active ? "page" : undefined,
      }),
    ),
  );
}

/**
 * Renders the header every staff view shares and returns the right-hand slot,
 * which is the one part a view fills in for itself.
 */
export function mountStaffChrome({ title }) {
  const slot = el("div", { class: "header-slot" });
  const header = el("header", {}, [el("h1", { text: title }), staffNav(), slot]);

  document.body.prepend(header);
  return { header, slot };
}
