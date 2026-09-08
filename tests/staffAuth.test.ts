/**
 * The staff gate, exercised over real HTTP.
 *
 * The password lives in `config`, which the app reads per request rather than
 * capturing at construction — so a suite can turn the gate on and off around
 * a server it built once, the same way the menu suite moves `uploadsDir`.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { InMemoryStaffAccountRepository, StaffAccountService } from "../src/staff/accounts.js";
import { config } from "../src/config/env.js";
import { createServer } from "../src/http/app.js";
import { MenuService } from "../src/menu/service.js";
import { MenuStore } from "../src/menu/store.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { createPaymentService } from "../src/payments/service.js";
import {
  issueSession,
  readSession,
  resetLoginThrottle,
  resetRevokedSessions,
  revokeSession,
  SESSION_TTL_MS,
  STAFF_SESSION_COOKIE,
} from "../src/staff/auth.js";

const PASSWORD = "fry-station-42";

let server: Server;
let base: string;
let app: Services;

function buildServices(): Services {
  const menuStore = new MenuStore();
  const menu = new MenuService(menuStore);
  const carts = new CartService(new InMemoryCartRepository(), menu);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menu);
  return {
    carts,
    orders,
    menu,
    menuStore,
    payments: createPaymentService(orders),
    proofs: new InMemoryProofRepository(),
    staffAccounts: new StaffAccountService(new InMemoryStaffAccountRepository()),
    storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} } as const,
  };
}

beforeAll(async () => {
  app = buildServices();
  server = createServer(app).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const LOCAL_BASE_URL = config.publicBaseUrl;

beforeEach(() => {
  config.staffPassword = PASSWORD;
  resetLoginThrottle();
  resetRevokedSessions();
});

afterEach(() => {
  // Every other suite calls these routes unauthenticated and must keep working.
  config.staffPassword = undefined;
  // Restored because the gate reads it: an https base URL is what turns a
  // missing password from "open" into "locked".
  config.publicBaseUrl = LOCAL_BASE_URL;
});

/** Every staff page, including the two the original list forgot. */
const STAFF_PAGES = [
  "/staff",
  "/staff/kitchen",
  "/staff/sales",
  "/staff/menu",
  "/staff/qr",
  "/staff/approvals",
  "/staff/accounts",
];

/** A GET that follows nothing, so a redirect is visible rather than followed. */
function page(path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: "manual",
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Signs in and returns the cookie header to replay on later requests. */
async function signIn(password = PASSWORD): Promise<string> {
  const response = await fetch(`${base}/api/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0]!;
}

/** Every route the staff area actually uses, with a body where one is required. */
const PROTECTED: [string, string, unknown?][] = [
  ["GET", "/api/staff/overview"],
  ["GET", "/api/staff/sales-report"],
  ["GET", "/api/staff/menu-items"],
  ["PATCH", "/api/staff/orders/anything/status", { status: "cooking" }],
  ["PATCH", "/api/staff/orders/anything/cancel"],
  ["PATCH", "/api/staff/orders/anything/approve-cancel"],
  ["PATCH", "/api/staff/orders/anything/deny-cancel"],
  ["POST", "/api/staff/orders/anything/status", { status: "cooking" }],
  ["POST", "/api/staff/menu-items", { name: "Anything" }],
  ["PUT", "/api/staff/menu-items/no-such-item", { name: "Anything" }],
  ["PATCH", "/api/staff/menu-items/no-such-item/availability", { available: false }],
  ["DELETE", "/api/staff/menu-items/no-such-item"],
];

function call(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}

describe("staff API gate", () => {
  it("refuses every staff route without a session", async () => {
    for (const [method, path, body] of PROTECTED) {
      const response = await call(method, path, body);
      expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 401`);
      await expect(json(response)).resolves.toMatchObject({ error: "staff_auth_required" });
    }
  });

  it("lets every one of them through with a session", async () => {
    const cookie = await signIn();

    for (const [method, path, body] of PROTECTED) {
      const response = await call(method, path, body, cookie);
      // Past the gate is all this asserts: a 404 for an order that does not
      // exist is the route answering, which is the point.
      expect(`${method} ${path}`, `${method} ${path} was still refused`).toBeTruthy();
      expect(response.status).not.toBe(401);
    }
  });

  it("does not touch the customer flow", async () => {
    // The whole ordering path has to stay open with the gate on — this is the
    // thing a password on /api/staff must never break.
    const menu = await fetch(`${base}/api/menu`);
    expect(menu.status).toBe(200);

    const { cartId } = await json(await call("POST", "/api/carts", {}));
    const withLine = await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    expect(withLine.status).toBe(200);

    const order = await call("POST", "/api/orders", { cartId });
    expect(order.status).toBe(200);

    const placed = await json(order);
    expect((await call("GET", `/api/orders/${placed.order.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/payments/methods`)).status).toBe(200);
  });

  it("is open, and says so on /health, when no password is configured", async () => {
    config.staffPassword = undefined;

    await expect(json(await fetch(`${base}/health`))).resolves.toMatchObject({ staffAuth: "disabled" });
    expect((await call("GET", "/api/staff/overview")).status).toBe(200);

    config.staffPassword = PASSWORD;
    await expect(json(await fetch(`${base}/health`))).resolves.toMatchObject({ staffAuth: "password" });
    expect((await call("GET", "/api/staff/overview")).status).toBe(401);
  });
});

describe("login", () => {
  it("refuses the wrong password without saying why", async () => {
    const response = await call("POST", "/api/staff/login", { password: "not-it" });

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await json(response);
    expect(body.error).toBe("invalid_password");
    // Nothing about the real password's length, shape or existence.
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  it("rejects an empty password as a bad request, not a wrong one", async () => {
    // A blank field is a form error the page can explain; calling it a wrong
    // password would send someone hunting for a password that was never typed.
    expect((await call("POST", "/api/staff/login", { password: "" })).status).toBe(400);
    expect((await call("POST", "/api/staff/login", {})).status).toBe(400);
  });

  it("issues an httpOnly session cookie that is not the password", async () => {
    const response = await call("POST", "/api/staff/login", { password: PASSWORD });
    const header = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(header).toContain(`${STAFF_SESSION_COOKIE}=`);
    expect(header.toLowerCase()).toContain("httponly");
    expect(header.toLowerCase()).toContain("samesite=lax");
    expect(header).toContain("Path=/");
    // The cookie must be a token over the password, never a copy of it.
    expect(header).not.toContain(PASSWORD);
  });

  it("reports the session state for the login page", async () => {
    await expect(json(await call("GET", "/api/staff/session"))).resolves.toEqual({
      authenticated: false,
      authRequired: true,
      configured: true,
    });

    const cookie = await signIn();
    await expect(json(await call("GET", "/api/staff/session", undefined, cookie))).resolves.toEqual({
      authenticated: true,
      authRequired: true,
      configured: true,
    });
  });

  it("logs out, clearing the cookie with the attributes it was set with", async () => {
    const cookie = await signIn();
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(200);

    const out = await call("POST", "/api/staff/logout", undefined, cookie);
    expect(out.status).toBe(200);
    await expect(json(out)).resolves.toMatchObject({ ok: true, revoked: true });
    // Cleared with the same attributes it was set with, or the browser keeps it.
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${STAFF_SESSION_COOKIE}=`);
    expect(cleared).toContain("Path=/");
  });

  it("locks out after repeated failures, and a correct password later still works", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await call("POST", "/api/staff/login", { password: "guess" })).status).toBe(401);
    }

    // The ninth is refused before the password is even looked at — including
    // the right one, which is the point of a throttle.
    const throttled = await call("POST", "/api/staff/login", { password: PASSWORD });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();

    resetLoginThrottle();
    expect((await call("POST", "/api/staff/login", { password: PASSWORD })).status).toBe(200);
  });
});

describe("session tokens", () => {
  it("refuses a token that was tampered with", async () => {
    const token = issueSession();
    const [payload, signature] = token.split(".");

    for (const forged of [
      `${payload}.${signature!.slice(0, -2)}xx`, // resigned by hand
      `${payload}x.${signature}`, // payload edited
      payload!, // signature dropped
      "", // nothing at all
    ]) {
      const response = await call("GET", "/api/staff/overview", undefined, `${STAFF_SESSION_COOKIE}=${forged}`);
      expect(response.status).toBe(401);
    }
  });

  it("refuses a token signed under a different password", async () => {
    const cookie = await signIn();

    // The manager changes the password. Everyone signed in under the old one is
    // out, without anything having to be revoked.
    config.staffPassword = "new-password-after-someone-left";
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(401);
  });

  it("expires after twelve hours", async () => {
    const now = Date.now();
    const token = issueSession(now);

    expect(readSession(token, now + SESSION_TTL_MS - 1000)).toBeDefined();
    expect(readSession(token, now + SESSION_TTL_MS + 1000)).toBeUndefined();

    const expired = issueSession(now - SESSION_TTL_MS - 1000);
    expect((await call("GET", "/api/staff/overview", undefined, `${STAFF_SESSION_COOKIE}=${expired}`)).status).toBe(401);
  });
});

describe("staff pages", () => {
  const VIEWS = ["/staff", "/staff/kitchen", "/staff/sales", "/staff/menu"];

  it("redirects every view to login, remembering where it was headed", async () => {
    for (const path of VIEWS) {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });

      expect(`${path} -> ${response.status}`).toBe(`${path} -> 302`);
      expect(response.headers.get("location")).toBe(`/staff/login?next=${encodeURIComponent(path)}`);
      // The guard has to run before the page is sent, not after.
      await expect(response.text()).resolves.not.toContain("data-staff-view");
    }
  });

  it("serves every view once signed in", async () => {
    const cookie = await signIn();

    for (const path of VIEWS) {
      const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);
      await expect(response.text()).resolves.toContain("data-staff-view");
    }
  });

  it("serves the login page itself without one, and keeps it out of search", async () => {
    const response = await fetch(`${base}/staff/login`, { redirect: "manual" });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).toContain('data-staff-view="login"');
    expect(html).toContain('type="password"');
    // The mount path is substituted here as on every other staff page.
    expect(html).toContain('href="/staff/assets/staff.css"');
  });

  it("keeps the shared assets reachable, since the login page needs them", async () => {
    // They are code, not data: gating them would only lock the sign-in screen
    // out of its own stylesheet.
    for (const file of ["staff.css", "nav.js", "common.js"]) {
      expect((await fetch(`${base}/staff/assets/${file}`)).status).toBe(200);
    }
  });
});

describe("table QR codes", () => {
  it("is behind the staff password like the rest of the area", async () => {
    // The reason this can be a page at all: an open route that mints table
    // codes hands anyone a link that opens an order against someone's table.
    expect((await call("GET", "/api/staff/qr-codes?tables=1-4")).status).toBe(401);

    const cookie = await signIn();
    const response = await call("GET", "/api/staff/qr-codes?tables=1-4", undefined, cookie);
    expect(response.status).toBe(200);

    const body = await json(response);
    expect(body.codes).toHaveLength(4);
    expect(body.codes.map((code: any) => code.table)).toEqual(["1", "2", "3", "4"]);
    expect(body.codes[0].png.startsWith("data:image/png;base64,")).toBe(true);
    expect(body.codes[0].url).toContain("/order?table=1");
  });

  it("explains a table list it cannot read, rather than 500ing", async () => {
    const cookie = await signIn();

    const backwards = await call("GET", "/api/staff/qr-codes?tables=9-2", undefined, cookie);
    expect(backwards.status).toBe(400);
    await expect(json(backwards)).resolves.toMatchObject({ error: "invalid_table_list" });

    const empty = await call("GET", "/api/staff/qr-codes?tables=", undefined, cookie);
    expect(empty.status).toBe(400);

    // A whole dining room is fine; a typo asking for a thousand is not.
    const tooMany = await call("GET", "/api/staff/qr-codes?tables=1-400", undefined, cookie);
    expect(tooMany.status).toBe(400);
    await expect(json(tooMany)).resolves.toMatchObject({ error: "too_many_tables" });
  });

  it("serves the page itself only to a signed-in browser", async () => {
    const unauthenticated = await fetch(`${base}/staff/qr`, { redirect: "manual" });
    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.get("location")).toBe(`/staff/login?next=${encodeURIComponent("/staff/qr")}`);

    const cookie = await signIn();
    const page = await fetch(`${base}/staff/qr`, { headers: { cookie }, redirect: "manual" });
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('data-staff-view="qr"');
  });
});

describe("takeaway is a staff route", () => {
  it("cannot be rung up without a session", async () => {
    // It creates paid orders. Open, it would let anyone mark food as paid for.
    const response = await call("POST", "/api/staff/orders/takeaway", { cartId: "x", payment: "cash" });
    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({ error: "staff_auth_required" });
  });
});

/**
 * The bug this suite exists for.
 *
 * Logging out used to be one `clearCookie`, and the test above was happy with
 * it: the header said the cookie was cleared, so the test passed. But clearing
 * a cookie is a *request* to one browser, and the token it names stays valid
 * for the rest of its twelve hours. Anyone holding a copy — a second tablet, a
 * browser that never processed the response, anything that read the value off
 * a shared device — stayed signed in through a logout the screen said had
 * worked.
 *
 * So none of these assert on Set-Cookie. They replay the exact token that was
 * live before the logout, which is the only way to tell an invalidated session
 * from a forgotten one.
 */
describe("logging out invalidates the session server-side", () => {
  it("stops accepting the token itself, not just this browser's copy", async () => {
    const cookie = await signIn();
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(200);

    await call("POST", "/api/staff/logout", undefined, cookie);

    // The same header value, replayed as a browser that ignored the clear
    // would send it. Before the fix this was a 200.
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(401);
    await expect(json(await call("GET", "/api/staff/session", undefined, cookie))).resolves.toMatchObject({
      authenticated: false,
    });
  });

  it("closes every staff page to the revoked token, not only the API", async () => {
    const cookie = await signIn();
    await call("POST", "/api/staff/logout", undefined, cookie);

    for (const path of STAFF_PAGES) {
      const response = await page(path, cookie);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 302`);
      expect(response.headers.get("location")).toBe(`/staff/login?next=${encodeURIComponent(path)}`);
      // And the page body was never sent, which is the difference between a
      // gate and a curtain.
      await expect(response.text()).resolves.not.toContain("data-staff-view");
    }
  });

  it("closes the write routes too — a revoked token must not still edit the menu", async () => {
    const cookie = await signIn();
    await call("POST", "/api/staff/logout", undefined, cookie);

    for (const [method, path, body] of PROTECTED) {
      const response = await call(method, path, body, cookie);
      expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 401`);
    }
  });

  it("signs out one tablet, not the whole shop", async () => {
    // The counterpart risk: revocation that is too broad takes the kitchen
    // board down mid service because someone signed out at the till.
    const till = await signIn();
    const kitchen = await signIn();
    expect(till).not.toBe(kitchen);

    await call("POST", "/api/staff/logout", undefined, till);

    expect((await call("GET", "/api/staff/overview", undefined, till)).status).toBe(401);
    expect((await call("GET", "/api/staff/overview", undefined, kitchen)).status).toBe(200);
    expect((await page("/staff", kitchen)).status).toBe(200);
  });

  it("treats a second logout as boring rather than an error", async () => {
    const cookie = await signIn();

    await expect(json(await call("POST", "/api/staff/logout", undefined, cookie))).resolves.toMatchObject({
      revoked: true,
    });
    // Already revoked, so there is nothing left to retire — still a 200, because
    // a double-tap on Log out is not a failure.
    const second = await call("POST", "/api/staff/logout", undefined, cookie);
    expect(second.status).toBe(200);
    await expect(json(second)).resolves.toMatchObject({ ok: true, revoked: false });

    // And with no session at all.
    const none = await call("POST", "/api/staff/logout");
    expect(none.status).toBe(200);
    await expect(json(none)).resolves.toMatchObject({ ok: true, revoked: false });
  });

  it("will not let a forged or unverifiable token poison the revocation list", async () => {
    // `revokeSession` takes a raw cookie and verifies it first. If it did not,
    // an unauthenticated caller could add ids to a map that grows for twelve
    // hours a time.
    expect(revokeSession(undefined)).toBe(false);
    expect(revokeSession("not-a-token")).toBe(false);
    expect(revokeSession(`${issueSession().split(".")[0]}.forged`)).toBe(false);
  });

  it("survives the sessions it revoked expiring", async () => {
    const now = Date.now();
    const token = issueSession(now);

    expect(revokeSession(token, now)).toBe(true);
    expect(readSession(token, now + 1000)).toBeUndefined();
    // Past its own expiry it is refused by the clock, revocation or not.
    expect(readSession(token, now + SESSION_TTL_MS + 1000)).toBeUndefined();
  });
});

/**
 * Item 4 of the audit, as one test: the sequence a person actually performs.
 *
 * The individual guards each have their own test above; this is here because
 * the bug was in how they joined up, and a suite of correct parts is exactly
 * what shipped the broken whole.
 */
describe("the whole sign-in journey", () => {
  it("goes fresh browser -> login -> dashboard -> log out -> login, and back is still blocked", async () => {
    // 1. Fresh browser, no session, straight to the dashboard link.
    const cold = await page("/staff");
    expect(cold.status).toBe(302);
    expect(cold.headers.get("location")).toBe(`/staff/login?next=${encodeURIComponent("/staff")}`);

    // 2. The login page it was sent to renders, and renders a password field.
    const login = await page("/staff/login");
    expect(login.status).toBe(200);
    await expect(login.text()).resolves.toContain('type="password"');

    // 3. The wrong password gets nowhere.
    expect((await call("POST", "/api/staff/login", { password: "not-it" })).status).toBe(401);
    expect((await page("/staff")).status).toBe(302);

    // 4. The right one lands on the dashboard.
    const cookie = await signIn();
    const dashboard = await page("/staff", cookie);
    expect(dashboard.status).toBe(200);
    await expect(dashboard.text()).resolves.toContain('data-staff-view="dashboard"');

    // 5. Log out.
    expect((await call("POST", "/api/staff/logout", undefined, cookie)).status).toBe(200);

    // 6. Typing the dashboard URL back in — the back button, a bookmark, the
    //    tablet's home screen — lands on login, not the board.
    const afterLogout = await page("/staff", cookie);
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.get("location")).toBe(`/staff/login?next=${encodeURIComponent("/staff")}`);
    await expect(afterLogout.text()).resolves.not.toContain("data-staff-view");
  });
});

/**
 * Typing a URL is the attack, such as it is: the staff path is a secret only
 * until it is in somebody's history, and every one of these is a browser that
 * has the address but not the credentials.
 */
describe("a cleared or expired session reaches no staff page by URL", () => {
  const USELESS_COOKIES: [string, string | undefined][] = [
    ["no cookie at all", undefined],
    ["a cleared cookie", `${STAFF_SESSION_COOKIE}=`],
    ["a cookie cleared to the empty pair", `${STAFF_SESSION_COOKIE}=; other=1`],
    ["junk typed into devtools", `${STAFF_SESSION_COOKIE}=let-me-in`],
    ["an expired token", `${STAFF_SESSION_COOKIE}=${issueSession(Date.now() - SESSION_TTL_MS - 1000)}`],
  ];

  it("redirects every staff page to login, whatever is in the cookie jar", async () => {
    for (const [label, cookie] of USELESS_COOKIES) {
      for (const path of STAFF_PAGES) {
        const response = await page(path, cookie);
        expect(`${label} @ ${path} -> ${response.status}`).toBe(`${label} @ ${path} -> 302`);
        // The guard runs before the document is built, so nothing of the board
        // is on the wire for a script to have "protected" after the fact.
        await expect(response.text()).resolves.not.toContain("data-staff-view");
      }
    }
  });

  it("refuses the API the same way, so the pages have nothing to render either", async () => {
    for (const [label, cookie] of USELESS_COOKIES) {
      const response = await call("GET", "/api/staff/overview", undefined, cookie);
      expect(`${label} -> ${response.status}`).toBe(`${label} -> 401`);
    }
  });

  it("expires a session that was valid when the shift started", async () => {
    // Not a cleared cookie but a stale one: the tablet was signed in, and then
    // sat on the pass overnight.
    const overnight = `${STAFF_SESSION_COOKIE}=${issueSession(Date.now() - SESSION_TTL_MS - 1)}`;

    expect((await page("/staff", overnight)).status).toBe(302);
    expect((await call("GET", "/api/staff/overview", undefined, overnight)).status).toBe(401);
  });
});

/**
 * The reason the dashboard was reachable without a password in the first
 * place: none was configured, and an unset `STAFF_PASSWORD` used to mean
 * "open" everywhere rather than only on a developer's laptop.
 */
describe("a public deployment with no password configured", () => {
  beforeEach(() => {
    config.staffPassword = undefined;
    // What Railway hands out, and the signal that this is not a laptop.
    config.publicBaseUrl = "https://anchor-and-batter.up.railway.app";
  });

  it("closes the staff area instead of opening it", async () => {
    for (const path of STAFF_PAGES) {
      const response = await page(path);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 302`);
      await expect(response.text()).resolves.not.toContain("data-staff-view");
    }

    for (const [method, path, body] of PROTECTED) {
      expect(`${method} ${path} -> ${(await call(method, path, body)).status}`).toBe(`${method} ${path} -> 401`);
    }
  });

  it("says so on /health and on the session probe", async () => {
    await expect(json(await fetch(`${base}/health`))).resolves.toMatchObject({ staffAuth: "unconfigured" });
    await expect(json(await call("GET", "/api/staff/session"))).resolves.toEqual({
      authenticated: false,
      // Sign-in required, and nothing to sign in with. The login page needs
      // both halves to explain itself rather than showing a dead form.
      authRequired: true,
      configured: false,
    });
  });

  it("tells the login page why no password will work, rather than rejecting each attempt", async () => {
    const response = await call("POST", "/api/staff/login", { password: "anything" });

    expect(response.status).toBe(503);
    await expect(json(response)).resolves.toMatchObject({ error: "staff_auth_unconfigured" });
    // Emphatically not a session.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("leaves the customer ordering flow completely alone", async () => {
    // The whole point of locking the staff area rather than refusing to boot:
    // the shop keeps taking orders while someone sets the variable.
    expect((await fetch(`${base}/api/menu`)).status).toBe(200);

    const { cartId } = await json(await call("POST", "/api/carts", {}));
    expect((await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" })).status).toBe(200);
    expect((await call("POST", "/api/orders", { cartId })).status).toBe(200);
  });

  it("still serves the login page itself, which is the only way back", async () => {
    const response = await page("/staff/login");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('data-staff-view="login"');
  });

  it("keeps local development open, which is the case this must not break", async () => {
    config.publicBaseUrl = LOCAL_BASE_URL;
    expect(LOCAL_BASE_URL.startsWith("http://")).toBe(true);

    await expect(json(await fetch(`${base}/health`))).resolves.toMatchObject({ staffAuth: "disabled" });
    expect((await call("GET", "/api/staff/overview")).status).toBe(200);
    expect((await page("/staff")).status).toBe(200);
  });
});
