// The staff layout: one header, one nav, three views.
//
// Every page under the staff path calls `mountStaffChrome` instead of writing
// its own header, so the nav is defined once and a fourth view is one entry in
// the list below.

import { el, redirectToLogin } from "./common.js";

/**
 * `path` is relative to wherever the staff area is mounted — the mount point is
 * configurable (`STAFF_DASHBOARD_PATH`), so the base is injected into the page
 * as `data-staff-base` at serve time rather than hard-coded here.
 */
export const STAFF_VIEWS = [
  { id: "dashboard", label: "Dashboard", path: "", section: "dashboard" },
  { id: "kitchen", label: "Kitchen & Counter", path: "/kitchen", section: "kitchen_counter" },
  { id: "sales", label: "Sales Report", path: "/sales", section: "sales_report" },
  { id: "menu", label: "Menu", path: "/menu", section: "menu" },
  { id: "qr", label: "Table QR Codes", path: "/qr", section: "table_qr" },
  { id: "approvals", label: "Approvals", path: "/approvals", section: "approvals" },
  // Staff accounts and the roles that decide who sees what.
  { id: "accounts", label: "Staff", path: "/accounts", section: "staff" },
];

/**
 * The signed-in session, fetched once per page.
 *
 * Cached because three things want it — the nav, the Staff page's Owner-only
 * controls, and the header's "signed in as" — and a page load should ask the
 * server who is holding the tablet exactly once.
 *
 * Never rejects. A page whose session call failed still has to draw something,
 * and the API calls it goes on to make will 401 on their own and redirect.
 */
let sessionPromise = null;

export function staffSession() {
  sessionPromise ??= fetch("/api/staff/session")
    .then((response) => response.json())
    .catch(() => ({ authenticated: false, sections: [], isOwner: false }));
  return sessionPromise;
}

/**
 * Where to land somebody with these sections.
 *
 * The dashboard is the shop's front page but not everybody's: a cashier with
 * only Kitchen & Counter would otherwise sign in and be shown a page their own
 * role forbids. First permitted view in nav order, and the login screen when
 * there is nothing at all — which is a real state, and one worth landing on a
 * page that explains itself rather than a 403.
 */
export function homePathFor(sections) {
  const base = staffBase();
  const view = STAFF_VIEWS.find((candidate) => (sections ?? []).includes(candidate.section));
  return view === undefined ? `${base}/login` : `${base}${view.path}` || base || "/";
}

/** Test seam: each jsdom document is a fresh page. */
export function resetStaffSession() {
  sessionPromise = null;
}

/** The path the staff area is served under, e.g. "/staff-a8f3k2m9". */
export function staffBase() {
  return document.body.dataset.staffBase ?? "";
}

/** Which of the views this document is. Set per page on `<body>`. */
export function staffView() {
  return document.body.dataset.staffView ?? "";
}

/**
 * The nav on its own — one link per view this role may reach, the active one
 * marked.
 *
 * `sections` is the permission list from the session. Passing null renders
 * every view, which is what the tests use to assert the full set; the real
 * pages always pass what the server said.
 *
 * Filtering here is presentation, not protection. The server gates each page
 * and each API route on the same section list — a tab this drops is a URL that
 * still 403s if it is typed.
 *
 * Links rather than buttons: these are navigations, so they open in a new tab,
 * announce as links, and work with the browser's own back button.
 */
export function staffNav(active = staffView(), sections = null) {
  const base = staffBase();
  const views = sections === null ? STAFF_VIEWS : STAFF_VIEWS.filter((view) => sections.includes(view.section));

  return el(
    "nav",
    { class: "staff-nav", "aria-label": "Staff views" },
    views.map((view) =>
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
 * Who is signed in, shown beside the log-out button.
 *
 * An emergency session says so, loudly and in amber: it is nobody in
 * particular, it can see everything, and whoever is holding it should be
 * creating an Owner and signing in properly rather than working the shift on it.
 */
export function signedInAs(session) {
  if (session.emergency) {
    return el("span", { class: "signed-in emergency", text: "Emergency access — create an Owner" });
  }
  if (!session.name) return null;

  return el("span", { class: "signed-in" }, [
    el("span", { class: "signed-in-name", text: session.name }),
    session.role ? el("span", { class: "signed-in-role", text: session.role }) : null,
  ]);
}

/**
 * The sign-out control.
 *
 * A button, not a link: it changes state on the server, so it must not be
 * something a crawler or a prefetch can trip. The redirect happens either way —
 * a logout that fails to reach the server still has to get the person off a
 * board they wanted to leave, and the cookie's own expiry backstops it.
 */
export function logoutButton() {
  return el("button", {
    class: "logout",
    type: "button",
    text: "Log out",
    onclick: async (event) => {
      event.currentTarget.disabled = true;
      try {
        await fetch("/api/staff/logout", { method: "POST" });
      } catch {
        // Offline. Go to the login screen anyway.
      }
      redirectToLogin();
    },
  });
}

/**
 * Renders the header every staff view shares and returns the right-hand slot,
 * which is the one part a view fills in for itself.
 *
 * Log out sits after the slot so it is the last thing in the header on every
 * view, wherever that view's own controls end.
 */
export function mountStaffChrome({ title }) {
  const slot = el("div", { class: "header-slot" });
  // Empty until the server says what this role may reach. Drawn empty rather
  // than full-then-trimmed: a tab that flashes up and vanishes reads as a
  // glitch, and on a tablet it is a tab somebody may already have tapped.
  let nav = staffNav(staffView(), []);
  const identity = el("span", { class: "signed-in-slot" });
  const header = el("header", {}, [el("h1", { text: title }), nav, slot, identity, logoutButton()]);

  document.body.prepend(header);

  void staffSession().then((session) => {
    const drawn = staffNav(staffView(), session.sections ?? []);
    nav.replaceWith(drawn);
    nav = drawn;
    const who = signedInAs(session);
    if (who) identity.replaceChildren(who);
  });

  return { header, slot };
}
