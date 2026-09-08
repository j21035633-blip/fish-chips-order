/**
 * Individual sign-in, and roles deciding what each person can reach.
 *
 * Three things are being pinned down, and the first is the one that matters:
 *
 * - **The gate is the server.** A tab the nav does not draw is still a URL
 *   somebody can type, so every assertion about a role not having a section is
 *   made by calling that section's API directly with that person's cookie.
 * - **Owner cannot be taken away.** It is the role that can undo a mistake, so
 *   there must be no request that narrows or deletes it.
 * - **The emergency door is shut by default.** It grants everything and names
 *   nobody, so it opens only before the first Owner exists or when somebody has
 *   deliberately reopened it.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import { config } from "../src/config/env.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { createServer } from "../src/http/app.js";
import { MenuService } from "../src/menu/service.js";
import { MenuStore } from "../src/menu/store.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { createPaymentService } from "../src/payments/service.js";
import { InMemoryStaffAccountRepository, StaffAccountService } from "../src/staff/accounts.js";
import { resetLoginThrottle, resetRevokedSessions, sectionsForPath, STAFF_SESSION_COOKIE } from "../src/staff/auth.js";
import {
  DEFAULT_SECTIONS,
  InMemoryRoleRepository,
  NAV_SECTIONS,
  OWNER_ROLE,
  RoleError,
  RoleService,
} from "../src/staff/roles.js";

const SHOP_PASSWORD = "shop-recovery-42";

const OWNER = { staffId: "OWN1", name: "Nadia Owner", password: "owner-pass", role: OWNER_ROLE };
const CASHIER = { staffId: "CA10", name: "Aisyah Rahman", password: "cashier-pass", role: "Cashier" };
const BOOKKEEPER = { staffId: "BK20", name: "Ben Wong", password: "books-pass", role: "Bookkeeper" };

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
    staffRoles: new RoleService(new InMemoryRoleRepository()),
    storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} } as const,
  } as unknown as Services;
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

beforeEach(async () => {
  config.staffPassword = SHOP_PASSWORD;
  config.staffEmergencyLogin = false;
  resetLoginThrottle();
  resetRevokedSessions();

  // A fresh cast each time: these tests deactivate people, narrow roles and
  // delete roles, and none of that may leak into the next one.
  app.staffAccounts = new StaffAccountService(new InMemoryStaffAccountRepository());
  app.staffRoles = new RoleService(new InMemoryRoleRepository());
  await app.staffRoles.create({ name: "Cashier", permittedSections: ["kitchen_counter", "menu"] });
  await app.staffRoles.create({ name: "Bookkeeper", permittedSections: ["sales_report"] });
  for (const person of [OWNER, CASHIER, BOOKKEEPER]) await app.staffAccounts.create(person);
});

afterEach(() => {
  // Every other suite calls these routes unauthenticated and must keep working.
  config.staffPassword = undefined;
  config.staffEmergencyLogin = false;
  config.publicBaseUrl = LOCAL_BASE_URL;
});

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function call(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function page(path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: "manual",
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

async function signIn(who: { staffId: string; password: string }): Promise<string> {
  const response = await call("POST", "/api/staff/login", { staffId: who.staffId, password: who.password });
  expect(response.status, `${who.staffId} should be able to sign in`).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** One representative read per section, so "can they reach it" is one call. */
const SECTION_PROBE: Record<string, [string, string, unknown?]> = {
  dashboard: ["GET", "/api/staff/overview"],
  kitchen_counter: ["GET", "/api/staff/overview"],
  sales_report: ["GET", "/api/staff/sales-report"],
  menu: ["GET", "/api/staff/menu-items"],
  table_qr: ["GET", "/api/staff/qr-codes?tables=1"],
  approvals: ["GET", "/api/staff/proofs"],
  staff: ["GET", "/api/staff/accounts"],
};

describe("signing in as yourself", () => {
  it("takes the staff ID and the password stored on that account", async () => {
    const response = await call("POST", "/api/staff/login", {
      staffId: CASHIER.staffId,
      password: CASHIER.password,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${STAFF_SESSION_COOKIE}=`);
    await expect(json(response)).resolves.toMatchObject({
      staffId: CASHIER.staffId,
      name: CASHIER.name,
      role: "Cashier",
      sections: ["kitchen_counter", "menu"],
      isOwner: false,
    });
  });

  it("is not case-sensitive about the staff ID, which is typed at a till", async () => {
    expect((await call("POST", "/api/staff/login", { staffId: "ca10", password: CASHIER.password })).status).toBe(200);
  });

  it("refuses a deactivated account, and says so rather than blaming the password", async () => {
    await app.staffAccounts.deactivate(CASHIER.staffId);

    const response = await call("POST", "/api/staff/login", {
      staffId: CASHIER.staffId,
      password: CASHIER.password,
    });
    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({ error: "account_inactive" });
  });

  it("locks somebody out mid-shift the moment they are deactivated", async () => {
    const cookie = await signIn(CASHIER);
    expect((await call("GET", "/api/staff/menu-items", undefined, cookie)).status).toBe(200);

    await app.staffAccounts.deactivate(CASHIER.staffId);

    // Not in twelve hours when the token expires: the account is re-read on
    // every request, which is the whole reason the token is a cache.
    expect((await call("GET", "/api/staff/menu-items", undefined, cookie)).status).toBe(401);
  });
});

describe("a role that is missing a section", () => {
  it("gets 403 on that section's API, asked directly", async () => {
    const cookie = await signIn(CASHIER);

    // Cashier has kitchen_counter and menu, and nothing else.
    for (const section of ["sales_report", "table_qr", "approvals", "staff"] as const) {
      const [method, path, body] = SECTION_PROBE[section]!;
      const response = await call(method, path, body, cookie);
      expect(`${section} -> ${response.status}`).toBe(`${section} -> 403`);
      await expect(json(response)).resolves.toMatchObject({ error: "staff_section_forbidden" });
    }
  });

  it("still reaches everything its role does include", async () => {
    const cookie = await signIn(CASHIER);

    for (const section of ["kitchen_counter", "menu"] as const) {
      const [method, path, body] = SECTION_PROBE[section]!;
      const response = await call(method, path, body, cookie);
      expect(`${section} -> ${response.status}`).toBe(`${section} -> 200`);
    }
  });

  it("is refused on writes, not only reads", async () => {
    const cookie = await signIn(BOOKKEEPER);

    // Bookkeeper has sales_report alone: no menu writes, no accounts, no till.
    expect((await call("DELETE", "/api/staff/menu-items/fish-dory-classic", undefined, cookie)).status).toBe(403);
    expect((await call("POST", "/api/staff/accounts", { name: "X", password: "abcdef" }, cookie)).status).toBe(403);
    expect(
      (await call("PATCH", "/api/staff/orders/anything/settle", { method: "cash" }, cookie)).status,
    ).toBe(403);
  });

  it("is turned away from the page as well as the API", async () => {
    const cookie = await signIn(BOOKKEEPER);

    const forbidden = await page("/staff/menu", cookie);
    expect(forbidden.status).toBe(403);
    const html = await forbidden.text();
    // The page never reaches the browser, so nothing of it is there for a
    // script to have "protected" after the fact.
    expect(html).not.toContain('data-staff-view="menu"');
    expect(html).toContain("Not your section");
    // Never a dead end: it offers the one page they do have.
    expect(html).toContain("/staff/sales");

    expect((await page("/staff/sales", cookie)).status).toBe(200);
  });

  it("takes effect on the next request when an Owner narrows it", async () => {
    const cookie = await signIn(CASHIER);
    expect((await call("GET", "/api/staff/menu-items", undefined, cookie)).status).toBe(200);

    await app.staffRoles.update("Cashier", { permittedSections: ["kitchen_counter"] });

    // Not at the next sign-in: the role is re-read per request, so somebody
    // taken off the menu is off it now.
    expect((await call("GET", "/api/staff/menu-items", undefined, cookie)).status).toBe(403);
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(200);
  });

  it("sees only the tabs it can open, on the session the nav draws from", async () => {
    const cookie = await signIn(BOOKKEEPER);
    await expect(json(await call("GET", "/api/staff/session", undefined, cookie))).resolves.toMatchObject({
      authenticated: true,
      name: BOOKKEEPER.name,
      sections: ["sales_report"],
      isOwner: false,
    });
  });
});

describe("the Owner role", () => {
  it("reaches every section", async () => {
    const cookie = await signIn(OWNER);

    for (const section of NAV_SECTIONS) {
      const [method, path, body] = SECTION_PROBE[section]!;
      const response = await call(method, path, body, cookie);
      expect(`${section} -> ${response.status}`).toBe(`${section} -> 200`);
    }
  });

  it("cannot be restricted, by any request", async () => {
    const cookie = await signIn(OWNER);

    const patched = await call("PATCH", "/api/staff/roles/Owner", { permittedSections: [] }, cookie);
    expect(patched.status).toBe(403);
    await expect(json(patched)).resolves.toMatchObject({ error: "reserved_role" });

    // However it is spelled, and whoever asks.
    for (const spelling of ["owner", "OWNER", "  Owner  "]) {
      const response = await call(
        "PATCH",
        `/api/staff/roles/${encodeURIComponent(spelling)}`,
        { permittedSections: ["menu"] },
        cookie,
      );
      expect(`${spelling} -> ${response.status}`).toBe(`${spelling} -> 403`);
    }

    // And it still has everything afterwards.
    const { roles } = await json(await call("GET", "/api/staff/roles", undefined, cookie));
    expect(roles.find((role: any) => role.name === OWNER_ROLE).permittedSections).toEqual([...NAV_SECTIONS]);
  });

  it("cannot be deleted", async () => {
    const cookie = await signIn(OWNER);

    const response = await call("DELETE", "/api/staff/roles/Owner", undefined, cookie);
    expect(response.status).toBe(403);
    await expect(json(response)).resolves.toMatchObject({ error: "reserved_role" });
    expect((await app.staffRoles.list()).some((role) => role.name === OWNER_ROLE)).toBe(true);
  });

  it("cannot be recreated as an ordinary role either", async () => {
    const cookie = await signIn(OWNER);
    // Otherwise a stored "Owner" with two sections would shadow the real one.
    expect((await call("POST", "/api/staff/roles", { name: "owner", permittedSections: [] }, cookie)).status).toBe(403);
  });

  it("is refused at the service too, not only at the route", async () => {
    // A second caller must not be able to get round the reservation.
    await expect(app.staffRoles.update(OWNER_ROLE, { permittedSections: [] })).rejects.toThrow(RoleError);
    await expect(app.staffRoles.remove(OWNER_ROLE)).rejects.toThrow(/cannot be deleted/);
    await expect(app.staffRoles.create({ name: OWNER_ROLE })).rejects.toThrow(/reserved/);
  });
});

describe("managing roles", () => {
  it("is Owner-only, and refuses everyone else with a 403", async () => {
    const cookie = await signIn(CASHIER);
    // The Cashier does not even have the staff section, so start from somebody
    // who does: a role with staff but not Owner must still be refused.
    await app.staffRoles.create({ name: "Supervisor", permittedSections: ["staff"] });
    await app.staffAccounts.create({ staffId: "SU30", name: "Sue Pervisor", password: "sup-pass", role: "Supervisor" });
    const supervisor = await signIn({ staffId: "SU30", password: "sup-pass" });

    // They can read the list — the account form needs it to offer roles.
    expect((await call("GET", "/api/staff/roles", undefined, supervisor)).status).toBe(200);

    // They cannot change one, nor hand one out.
    for (const [method, path, body] of [
      ["POST", "/api/staff/roles", { name: "Anything", permittedSections: [] }],
      ["PATCH", "/api/staff/roles/Cashier", { permittedSections: [...NAV_SECTIONS] }],
      ["DELETE", "/api/staff/roles/Cashier", undefined],
      ["PATCH", `/api/staff/accounts/${CASHIER.staffId}`, { role: OWNER_ROLE }],
    ] as [string, string, unknown][]) {
      const response = await call(method, path, body, supervisor);
      expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 403`);
    }

    expect((await call("GET", "/api/staff/roles", undefined, cookie)).status).toBe(403);
  });

  it("creates a role, assigns it, and the sections take effect at sign-in", async () => {
    const owner = await signIn(OWNER);

    expect(
      (await call("POST", "/api/staff/roles", { name: "Runner", permittedSections: ["dashboard"] }, owner)).status,
    ).toBe(201);
    expect(
      (await call("PATCH", `/api/staff/accounts/${BOOKKEEPER.staffId}`, { role: "Runner" }, owner)).status,
    ).toBe(200);

    const cookie = await signIn(BOOKKEEPER);
    expect((await call("GET", "/api/staff/overview", undefined, cookie)).status).toBe(200);
    expect((await call("GET", "/api/staff/sales-report", undefined, cookie)).status).toBe(403);
  });

  it("refuses a section that is not a section", async () => {
    const owner = await signIn(OWNER);
    const response = await call("POST", "/api/staff/roles", { name: "Odd", permittedSections: ["everything"] }, owner);

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ error: "invalid_sections" });
  });

  it("refuses a duplicate role name, however it is spelled", async () => {
    const owner = await signIn(OWNER);
    expect((await call("POST", "/api/staff/roles", { name: " cashier ", permittedSections: [] }, owner)).status).toBe(
      409,
    );
  });

  it("will not delete a role somebody still holds, and names them", async () => {
    const owner = await signIn(OWNER);

    const response = await call("DELETE", "/api/staff/roles/Cashier", undefined, owner);
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe("role_in_use");
    // Named, so the Owner knows who to move first.
    expect(body.message).toContain(CASHIER.name);

    // Move them, and it goes.
    await call("PATCH", `/api/staff/accounts/${CASHIER.staffId}`, { role: "Bookkeeper" }, owner);
    expect((await call("DELETE", "/api/staff/roles/Cashier", undefined, owner)).status).toBe(200);
  });

  it("lets a role have no sections at all, which is a real thing to want", async () => {
    const owner = await signIn(OWNER);
    await call("PATCH", "/api/staff/roles/Bookkeeper", { permittedSections: [] }, owner);

    const cookie = await signIn(BOOKKEEPER);
    // Signed in, and can see nothing. Different from being deactivated, and
    // both are states a shop might mean.
    expect((await call("GET", "/api/staff/sales-report", undefined, cookie)).status).toBe(403);
    await expect(json(await call("GET", "/api/staff/session", undefined, cookie))).resolves.toMatchObject({
      authenticated: true,
      sections: [],
    });
  });
});

describe("the emergency door", () => {
  const knock = (password = SHOP_PASSWORD) => call("POST", "/api/staff/login/emergency", { password });

  it("is shut once the shop has an Owner", async () => {
    const response = await knock();
    expect(response.status).toBe(403);
    await expect(json(response)).resolves.toMatchObject({ error: "emergency_login_closed" });
  });

  it("opens when there is no active Owner to sign in as", async () => {
    await app.staffAccounts.deactivate(OWNER.staffId);

    const response = await knock();
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({ emergency: true });

    // And it grants everything, which is what makes it a recovery door.
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("GET", "/api/staff/accounts", undefined, cookie)).status).toBe(200);
    expect((await call("GET", "/api/staff/sales-report", undefined, cookie)).status).toBe(200);
  });

  it("opens when it has been deliberately reopened, Owner or not", async () => {
    config.staffEmergencyLogin = true;
    expect((await knock()).status).toBe(200);
  });

  it("still wants the right password", async () => {
    config.staffEmergencyLogin = true;
    const response = await knock("not-the-shop-password");
    expect(response.status).toBe(401);
    await expect(json(response)).resolves.toMatchObject({ error: "invalid_password" });
  });

  it("closes behind itself, so a recovery session does not outlive the recovery", async () => {
    await app.staffAccounts.deactivate(OWNER.staffId);
    const cookie = (await knock()).headers.get("set-cookie")!.split(";")[0]!;
    expect((await call("GET", "/api/staff/accounts", undefined, cookie)).status).toBe(200);

    // The recovery worked: there is an Owner again.
    await app.staffAccounts.reactivate(OWNER.staffId);

    // The session that let them do it stops being honoured, rather than
    // lingering as an unattributed key to everything for twelve hours.
    expect((await call("GET", "/api/staff/accounts", undefined, cookie)).status).toBe(401);
  });

  it("is not offered on the ordinary login screen while it is shut", async () => {
    const shut = await json(await call("GET", "/api/staff/session"));
    expect(shut.bootstrapAvailable).toBe(false);

    await app.staffAccounts.deactivate(OWNER.staffId);
    const open = await json(await call("GET", "/api/staff/session"));
    expect(open.bootstrapAvailable).toBe(true);
  });

  it("has its own page, separate from the normal one", async () => {
    const emergency = await page("/staff/login/emergency");
    expect(emergency.status).toBe(200);
    const html = await emergency.text();
    expect(html).toContain("Emergency access");
    // The normal screen asks for a staff ID; this one asks for the shop password.
    expect(html).not.toContain('id="staff-id"');

    const normal = await (await page("/staff/login")).text();
    expect(normal).toContain('id="staff-id"');
    // The link to the door exists but starts hidden — it is shown only when the
    // server says the door is genuinely open.
    expect(normal).toContain('id="bootstrap" class="login-alt" hidden');
  });

  it("says nothing useful when there is no shop password configured", async () => {
    config.staffPassword = undefined;
    config.staffSessionSecret = "a-session-secret";
    try {
      const response = await knock();
      expect(response.status).toBe(503);
      await expect(json(response)).resolves.toMatchObject({ error: "staff_auth_unconfigured" });
    } finally {
      config.staffSessionSecret = undefined;
    }
  });
});

describe("migrating the free-text roles", () => {
  it("turns each distinct value into a real role with a sensible default", async () => {
    const roles = new RoleService(new InMemoryRoleRepository());
    // What accounts looked like before roles existed.
    const created = await roles.ensureRolesFor(["Cashier", "Kitchen", "Cashier", OWNER_ROLE, "", "  "]);

    expect(created.sort()).toEqual(["Cashier", "Kitchen"]);
    // Owner is virtual, so nothing is written for it and nothing can be.
    expect((await roles.list()).map((role) => role.name)).toEqual([OWNER_ROLE, "Cashier", "Kitchen"]);
    expect((await roles.get("Cashier")).permittedSections).toEqual(DEFAULT_SECTIONS);
  });

  it("preserves a migrated staff member's access reasonably", async () => {
    // They worked the counter and the menu before; they still can. Sales, QR
    // codes and other people's accounts are the three that were never theirs to
    // start with, so none is granted by a migration nobody chose.
    const roles = new RoleService(new InMemoryRoleRepository());
    await roles.ensureRolesFor(["Cashier"]);

    const sections = await roles.sectionsFor("Cashier");
    expect(sections).toContain("kitchen_counter");
    expect(sections).toContain("menu");
    expect(sections).not.toContain("sales_report");
    expect(sections).not.toContain("staff");
  });

  it("is safe to run on every boot, and never overwrites an adjusted role", async () => {
    const roles = new RoleService(new InMemoryRoleRepository());
    await roles.ensureRolesFor(["Cashier"]);
    await roles.update("Cashier", { permittedSections: [...NAV_SECTIONS] });

    // The Owner widened it after the migration. A redeploy must not undo that.
    expect(await roles.ensureRolesFor(["Cashier"])).toEqual([]);
    expect((await roles.get("Cashier")).permittedSections).toEqual([...NAV_SECTIONS]);
  });

  it("falls back to the default for a role record that has gone missing", async () => {
    // An account pointing at a name with no record — a delete that raced a
    // reassignment, or a migration that died halfway. The gate must land
    // somewhere safe rather than throwing the person out of the staff area.
    const roles = new RoleService(new InMemoryRoleRepository());
    expect(await roles.sectionsFor("Ghost")).toEqual(DEFAULT_SECTIONS);
  });
});

describe("the section table", () => {
  it("claims every staff route the server actually registers", () => {
    // Fail-closed only helps if nothing was forgotten: an unclaimed route is a
    // 403 for everybody, including an Owner, so this walks the real router.
    const layers = (server as unknown as { _events: { request: { _router: { stack: any[] } } } })._events.request
      ._router.stack;
    const open = new Set(["/api/staff/session", "/api/staff/login", "/api/staff/login/emergency", "/api/staff/logout"]);

    const paths = layers
      .filter((layer) => layer.route?.path?.startsWith?.("/api/staff"))
      .map((layer) => layer.route.path as string);

    expect(paths.length).toBeGreaterThan(15);
    for (const path of paths) {
      if (open.has(path)) continue;
      const claimed = sectionsForPath(path.replace("/api/staff", ""));
      expect(claimed, `${path} has no section`).toBeDefined();
      for (const section of claimed!) expect(NAV_SECTIONS).toContain(section);
    }
  });

  it("refuses a staff path nothing claims", async () => {
    const cookie = await signIn(OWNER);
    // Even an Owner. Fail-closed means a route added without a section is dead
    // rather than open, which is the failure everybody notices immediately.
    const response = await call("GET", "/api/staff/not-a-real-route", undefined, cookie);
    expect(response.status).toBe(403);
    await expect(json(response)).resolves.toMatchObject({ error: "staff_section_unknown" });
  });
});
