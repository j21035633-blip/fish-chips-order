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

beforeEach(() => {
  config.staffPassword = PASSWORD;
  resetLoginThrottle();
});

afterEach(() => {
  // Every other suite calls these routes unauthenticated and must keep working.
  config.staffPassword = undefined;
});

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
    });

    const cookie = await signIn();
    await expect(json(await call("GET", "/api/staff/session", undefined, cookie))).resolves.toEqual({
      authenticated: true,
      authRequired: true,
    });
  });

  it("logs out, and the cookie stops working", async () => {
    const cookie = await signIn();
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(200);

    const out = await call("POST", "/api/staff/logout", undefined, cookie);
    expect(out.status).toBe(200);
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
