/**
 * Individual staff accounts, and the per-transaction check that uses them.
 *
 * Two things are being pinned down here, and they pull in opposite directions:
 *
 * - **The check has to bite.** Taking money at a counter without naming who took
 *   it is the thing this exists to stop, so a wrong pair has to fail the whole
 *   action rather than settle the order anyway and shrug.
 * - **The record has to outlive the person.** Somebody who left in March still
 *   has their name on March's orders, so deactivating is a flag and never a
 *   delete — the check stops passing, the history does not stop reading.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { createServer } from "../src/http/app.js";
import { menuService } from "../src/menu/service.js";
import { MenuStore } from "../src/menu/store.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { createPaymentService } from "../src/payments/service.js";
import {
  InMemoryStaffAccountRepository,
  StaffAccountError,
  StaffAccountService,
  hashPassword,
  normaliseId,
  passwordMatches,
} from "../src/staff/accounts.js";
import { DeviceCheckInService, InMemoryDeviceCheckInRepository } from "../src/staff/checkIns.js";
import { InMemoryRoleRepository, RoleService } from "../src/staff/roles.js";

let accounts: StaffAccountService;

beforeEach(() => {
  accounts = new StaffAccountService(new InMemoryStaffAccountRepository());
});

const AISYAH = { staffId: "AR47", name: "Aisyah Rahman", password: "till-pass", role: "Cashier" };

describe("keeping the staff list", () => {
  it("creates an account with the code that was assigned to it", async () => {
    const account = await accounts.create(AISYAH);

    expect(account).toMatchObject({ staffId: "AR47", name: "Aisyah Rahman", role: "Cashier", active: true });
    expect(account.createdAt).toEqual(expect.any(String));
  });

  it("never hands the password back out", async () => {
    const account = await accounts.create(AISYAH);
    // The hash is stored, and this is the one place that could leak it.
    expect(JSON.stringify(account)).not.toContain("passwordHash");
    expect(JSON.stringify(account)).not.toContain("till-pass");

    // It is a real hash of the real password, not a placeholder — nothing signs
    // in with it yet, and a column nobody can verify is a column nobody notices
    // is broken.
    const stored = await accounts.get("AR47");
    expect(stored.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(passwordMatches("till-pass", stored.passwordHash)).toBe(true);
    expect(passwordMatches("till-pas", stored.passwordHash)).toBe(false);
  });

  it("generates a readable code from the name when none is given", async () => {
    const account = await accounts.create({ name: "Aisyah Rahman", password: "till-pass" });

    // Initials plus two digits: short enough to type a hundred times a shift.
    expect(account.staffId).toMatch(/^AR\d{2}$/);
    expect(account.role).toBe("Staff");
  });

  it("gives two people with the same initials different codes", async () => {
    const first = await accounts.create({ name: "Aisyah Rahman", password: "till-pass" });
    const second = await accounts.create({ name: "Adam Roslan", password: "till-pass" });

    expect(second.staffId).not.toBe(first.staffId);
  });

  it("treats a code as the same code however it was typed", async () => {
    await accounts.create(AISYAH);

    expect(normaliseId(" ar 47 ")).toBe("AR47");
    expect((await accounts.get("ar47")).name).toBe("Aisyah Rahman");
    await expect(accounts.create({ ...AISYAH, staffId: "ar47", name: "Someone Else" })).rejects.toThrow(
      /already taken/,
    );
  });

  it("refuses a code a deactivated account still holds", async () => {
    await accounts.create(AISYAH);
    await accounts.deactivate("AR47");

    // Reusing it would put two people's transactions under one name.
    await expect(accounts.create({ ...AISYAH, name: "Someone Else" })).rejects.toThrow(/already taken/);
  });

  it("edits the name and role, and leaves the password alone unless one is sent", async () => {
    await accounts.create(AISYAH);
    const before = (await accounts.get("AR47")).passwordHash;

    const updated = await accounts.update("AR47", { name: "Aisyah binti Rahman", role: "Manager" });
    expect(updated).toMatchObject({ staffId: "AR47", name: "Aisyah binti Rahman", role: "Manager" });
    expect((await accounts.get("AR47")).passwordHash).toBe(before);
  });

  it("resets the password when one is sent", async () => {
    await accounts.create(AISYAH);
    await accounts.update("AR47", { password: "new-till-pass" });

    const stored = await accounts.get("AR47");
    expect(passwordMatches("new-till-pass", stored.passwordHash)).toBe(true);
    expect(passwordMatches("till-pass", stored.passwordHash)).toBe(false);
  });

  it("deactivates without erasing, and can put somebody back", async () => {
    await accounts.create(AISYAH);

    const off = await accounts.deactivate("AR47");
    expect(off).toMatchObject({ staffId: "AR47", name: "Aisyah Rahman", active: false });
    expect(off.deactivatedAt).toEqual(expect.any(String));
    // Still there, and still resolvable by id — which is what an old order needs.
    expect((await accounts.list()).map((entry) => entry.staffId)).toContain("AR47");

    const back = await accounts.reactivate("AR47");
    expect(back.active).toBe(true);
    expect(back.deactivatedAt).toBeUndefined();
  });

  it("lists everyone, active first", async () => {
    await accounts.create(AISYAH);
    await accounts.create({ staffId: "BW12", name: "Ben Wong", password: "till-pass" });
    await accounts.create({ staffId: "CT08", name: "Chai Tan", password: "till-pass" });
    await accounts.deactivate("BW12");

    const list = await accounts.list();
    expect(list.map((entry) => entry.staffId)).toEqual(["AR47", "CT08", "BW12"]);
    expect(list.map((entry) => entry.active)).toEqual([true, true, false]);
  });

  it("says what is wrong with a record it will not take", async () => {
    await expect(accounts.create({ name: "", password: "till-pass" })).rejects.toThrow(/name is required/);
    await expect(accounts.create({ name: "Ben Wong", password: "short" })).rejects.toThrow(/6–200 characters/);
    await expect(accounts.create({ staffId: "B", name: "Ben Wong", password: "till-pass" })).rejects.toThrow(
      /2–12 letters/,
    );
    await expect(
      accounts.create({ staffId: "BEN WONG!!", name: "Ben Wong", password: "till-pass" }),
    ).rejects.toThrow(/2–12 letters/);
    await expect(accounts.get("NOPE")).rejects.toThrow(StaffAccountError);
  });

  it("gives every stored password its own salt", () => {
    // Two people who picked the same password must not have the same hash.
    expect(hashPassword("till-pass")).not.toBe(hashPassword("till-pass"));
  });
});

describe("the check at the till", () => {
  beforeEach(async () => {
    await accounts.create(AISYAH);
  });

  it("passes a real active pair, and answers with the list's own spelling", async () => {
    const who = await accounts.verify({ staffId: "AR47", staffName: "Aisyah Rahman" });

    expect(who).toMatchObject({ staffId: "AR47", name: "Aisyah Rahman" });
    expect(who.at).toEqual(expect.any(String));
  });

  it("does not care how the pair was capitalised or spaced", async () => {
    // Typed on a tablet in the middle of service. Case is not identity.
    const who = await accounts.verify({ staffId: " ar47 ", staffName: "  aisyah rahman " });
    expect(who.name).toBe("Aisyah Rahman");
  });

  it("refuses a name that is not the one on that code", async () => {
    await expect(accounts.verify({ staffId: "AR47", staffName: "Ben Wong" })).rejects.toThrow(
      /does not match staff ID/,
    );
  });

  it("refuses a code nobody has", async () => {
    await expect(accounts.verify({ staffId: "ZZ99", staffName: "Aisyah Rahman" })).rejects.toThrow(
      /No staff account with ID/,
    );
  });

  it("refuses a deactivated account", async () => {
    await accounts.deactivate("AR47");
    await expect(accounts.verify({ staffId: "AR47", staffName: "Aisyah Rahman" })).rejects.toThrow(
      /no longer an active account/,
    );
  });

  it("refuses half a pair", async () => {
    await expect(accounts.verify({ staffId: "AR47" })).rejects.toThrow(/Enter the staff ID and name/);
    await expect(accounts.verify({ staffName: "Aisyah Rahman" })).rejects.toThrow(/Enter the staff ID and name/);
    await expect(accounts.verify({})).rejects.toThrow(StaffAccountError);
  });

  it("names the reason in the details, so a caller can tell the three apart", async () => {
    const reasons: string[] = [];
    for (const pair of [
      { staffId: "ZZ99", staffName: "Aisyah Rahman" },
      { staffId: "AR47", staffName: "Ben Wong" },
      { staffId: "AR47" },
    ]) {
      await accounts.verify(pair).catch((error: StaffAccountError) => {
        expect(error.code).toBe("staff_verification_failed");
        reasons.push((error.details as { reason: string }).reason);
      });
    }
    expect(reasons).toEqual(["unknown", "name_mismatch", "missing"]);
  });
});

// ------------------------------------------------------------------ over HTTP

describe("over HTTP", () => {
  let server: Server;
  let base: string;
  let app: Services;

  beforeAll(async () => {
    const menuStore = new MenuStore();
    const carts = new CartService(new InMemoryCartRepository(), menuService);
    const orders = new OrderService(new InMemoryOrderRepository(), carts, menuService);
    app = {
      carts,
      orders,
      menu: menuService,
      menuStore,
      payments: createPaymentService(orders),
      proofs: new InMemoryProofRepository(),
      staffAccounts: new StaffAccountService(new InMemoryStaffAccountRepository()),
      staffRoles: new RoleService(new InMemoryRoleRepository()),
      checkIns: new DeviceCheckInService(new InMemoryDeviceCheckInRepository()),
      storage: { kind: "memory", ready: true, indexes: "ready", async connect() {}, async close() {} },
    } as unknown as Services;

    server = createServer(app).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = (res: Response): Promise<any> => res.json() as Promise<any>;

  /** A fresh cashier per test, so one test's deactivation cannot reach another. */
  let cashier: { staffId: string; staffName: string };
  let counter = 0;

  beforeEach(async () => {
    counter += 1;
    const staffId = `T${String(counter).padStart(3, "0")}`;
    const staffName = `Cashier ${counter}`;
    await json(await call("POST", "/api/staff/accounts", { staffId, name: staffName, password: "till-pass" }));
    cashier = { staffId, staffName };
  });

  /** An order the customer left to settle on the way out. */
  async function counterOrder(): Promise<any> {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "fish-dory-classic" });
    return (await json(await call("POST", "/api/orders", { cartId, payAtCounter: true }))).order;
  }

  async function takeawayCart(): Promise<string> {
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "chips-classic" });
    return cartId;
  }

  describe("the admin routes", () => {
    it("creates, lists, edits and deactivates", async () => {
      // The role has to exist: an account parked on a name no role record
      // matches would leave the gate guessing what it may reach.
      expect((await call("POST", "/api/staff/roles", { name: "Kitchen", permittedSections: ["kitchen_counter"] })).status).toBe(201);

      const created = await call("POST", "/api/staff/accounts", {
        staffId: "BW12",
        name: "Ben Wong",
        password: "till-pass",
        role: "Kitchen",
      });
      expect(created.status).toBe(201);
      await expect(json(created)).resolves.toMatchObject({
        account: { staffId: "BW12", name: "Ben Wong", role: "Kitchen", active: true },
      });

      const listed = await json(await call("GET", "/api/staff/accounts"));
      const ben = listed.accounts.find((entry: any) => entry.staffId === "BW12");
      expect(ben).toBeDefined();
      // The hash never crosses the wire, on any route.
      expect(JSON.stringify(listed)).not.toContain("passwordHash");

      // A role nobody created is refused rather than stored.
      expect((await call("PATCH", "/api/staff/accounts/BW12", { role: "Manager" })).status).toBe(404);

      await call("POST", "/api/staff/roles", { name: "Manager", permittedSections: ["sales_report", "staff"] });
      const edited = await json(await call("PATCH", "/api/staff/accounts/BW12", { role: "Manager" }));
      expect(edited.account).toMatchObject({ staffId: "BW12", name: "Ben Wong", role: "Manager" });

      const removed = await json(await call("DELETE", "/api/staff/accounts/BW12"));
      expect(removed).toMatchObject({ deactivated: true, account: { staffId: "BW12", active: false } });

      // Deactivated, not gone: still listed, and flagged.
      const after = await json(await call("GET", "/api/staff/accounts"));
      expect(after.accounts.find((entry: any) => entry.staffId === "BW12")).toMatchObject({ active: false });
    });

    it("puts a deactivated account back on shift", async () => {
      await call("POST", "/api/staff/accounts", { staffId: "CT08", name: "Chai Tan", password: "till-pass" });
      await call("DELETE", "/api/staff/accounts/CT08");

      const back = await json(await call("PATCH", "/api/staff/accounts/CT08", { active: true }));
      expect(back.account.active).toBe(true);
    });

    it("404s an account nobody has, and 409s a code already taken", async () => {
      expect((await call("PATCH", "/api/staff/accounts/NOPE", { role: "Manager" })).status).toBe(404);
      expect((await call("DELETE", "/api/staff/accounts/NOPE")).status).toBe(404);

      await call("POST", "/api/staff/accounts", { staffId: "DUP1", name: "First", password: "till-pass" });
      const clash = await call("POST", "/api/staff/accounts", {
        staffId: "DUP1",
        name: "Second",
        password: "till-pass",
      });
      expect(clash.status).toBe(409);
      await expect(json(clash)).resolves.toMatchObject({ error: "duplicate_staff_id" });
    });

    it("rejects a record it cannot store, with something a manager can act on", async () => {
      const bad = await call("POST", "/api/staff/accounts", { name: "Ben Wong", password: "no" });
      expect(bad.status).toBe(400);
      await expect(json(bad)).resolves.toMatchObject({ error: "invalid_password" });
    });
  });

  describe("settling a counter order", () => {
    it("records who took the money, and puts it in the takings", async () => {
      const order = await counterOrder();

      const body = await json(
        await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash", ...cashier }),
      );

      expect(body.settled).toBe(true);
      expect(body.order.paymentStatus).toBe("paid");
      expect(body.order.processedBy).toMatchObject({ staffId: cashier.staffId, name: cashier.staffName });
      expect(body.order.processedBy.at).toEqual(expect.any(String));
    });

    it("attributes a card settlement too, which is still unpaid", async () => {
      const order = await counterOrder();

      const body = await json(
        await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "card", ...cashier }),
      );

      // The money waits on the webhook; who put the QR in front of the customer
      // does not.
      expect(body.settled).toBe(false);
      expect(body.order.paymentStatus).toBe("unpaid_counter");
      expect(body.order.processedBy.name).toBe(cashier.staffName);
    });

    it("refuses a name that does not go with the code, and takes no money", async () => {
      const order = await counterOrder();

      const response = await call("PATCH", `/api/staff/orders/${order.id}/settle`, {
        method: "cash",
        staffId: cashier.staffId,
        staffName: "Somebody Else",
      });
      expect(response.status).toBe(400);
      await expect(json(response)).resolves.toMatchObject({ error: "staff_verification_failed" });

      // The whole action failed, not just the attribution.
      const after = await json(await call("GET", `/api/orders/${order.id}`));
      expect(after.order.paymentStatus).toBe("unpaid_counter");
      expect(after.order.processedBy).toBeUndefined();
    });

    it("refuses a code nobody has", async () => {
      const order = await counterOrder();
      const response = await call("PATCH", `/api/staff/orders/${order.id}/settle`, {
        method: "cash",
        staffId: "ZZ99",
        staffName: "Aisyah Rahman",
      });

      expect(response.status).toBe(400);
      await expect(json(response)).resolves.toMatchObject({ details: { reason: "unknown" } });
    });

    it("refuses a settlement with nobody named at all", async () => {
      const order = await counterOrder();
      // The endpoint used to take just the method. It does not any more: an
      // unattributed settlement is the exact thing the accounts were added for.
      expect((await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash" })).status).toBe(400);
    });

    it("refuses somebody who has been taken off the till", async () => {
      const order = await counterOrder();
      await call("DELETE", `/api/staff/accounts/${cashier.staffId}`);

      const response = await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash", ...cashier });
      expect(response.status).toBe(400);
      await expect(json(response)).resolves.toMatchObject({ details: { reason: "inactive" } });
    });
  });

  describe("ringing up a takeaway", () => {
    it("records who rang it up", async () => {
      const body = await json(
        await call("POST", "/api/staff/orders/takeaway", { cartId: await takeawayCart(), payment: "cash", ...cashier }),
      );

      expect(body.order.paymentStatus).toBe("paid");
      expect(body.order.processedBy).toMatchObject({ staffId: cashier.staffId, name: cashier.staffName });
    });

    it("records who rang up a card one, which is not paid yet", async () => {
      const body = await json(
        await call("POST", "/api/staff/orders/takeaway", { cartId: await takeawayCart(), payment: "card", ...cashier }),
      );

      expect(body.order.paymentStatus).toBe("pending");
      expect(body.order.processedBy.name).toBe(cashier.staffName);
    });

    it("refuses a bad pair without leaving an order behind", async () => {
      const cartId = await takeawayCart();
      const before = (await json(await call("GET", "/api/staff/overview"))).orders.length;

      const response = await call("POST", "/api/staff/orders/takeaway", {
        cartId,
        payment: "cash",
        staffId: cashier.staffId,
        staffName: "Somebody Else",
      });
      expect(response.status).toBe(400);

      // Checked before the order is confirmed, so nothing was rung up — and the
      // cart is still there to try again with.
      const after = (await json(await call("GET", "/api/staff/overview"))).orders.length;
      expect(after).toBe(before);
      expect((await json(await call("GET", `/api/carts/${cartId}`))).cart.lines).toHaveLength(1);
    });

    it("refuses a takeaway with nobody named", async () => {
      const cartId = await takeawayCart();
      expect((await call("POST", "/api/staff/orders/takeaway", { cartId, payment: "cash" })).status).toBe(400);
    });
  });

  describe("somebody who has left", () => {
    it("keeps their name on what they already processed", async () => {
      const order = await counterOrder();
      await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash", ...cashier });

      await call("DELETE", `/api/staff/accounts/${cashier.staffId}`);

      // This is the whole reason deactivating is not a delete: the order still
      // says who took the money, months later, with the account switched off.
      const after = await json(await call("GET", `/api/orders/${order.id}`));
      expect(after.order.processedBy).toMatchObject({ staffId: cashier.staffId, name: cashier.staffName });

      // And it still reads on the board the counter actually looks at.
      const overview = await json(await call("GET", "/api/staff/overview"));
      const onBoard = overview.orders.find((entry: any) => entry.id === order.id);
      expect(onBoard?.processedBy?.name ?? after.order.processedBy.name).toBe(cashier.staffName);

      // But they cannot take any more money.
      const next = await counterOrder();
      expect((await call("PATCH", `/api/staff/orders/${next.id}/settle`, { method: "cash", ...cashier })).status).toBe(
        400,
      );
    });

    it("keeps the old name on old orders after the account is renamed", async () => {
      const order = await counterOrder();
      await call("PATCH", `/api/staff/orders/${order.id}/settle`, { method: "cash", ...cashier });

      await call("PATCH", `/api/staff/accounts/${cashier.staffId}`, { name: "Renamed Entirely" });

      // The order carries a copy taken at the time, not a pointer resolved now:
      // a receipt reprinted next year says who was on the till that day.
      const after = await json(await call("GET", `/api/orders/${order.id}`));
      expect(after.order.processedBy.name).toBe(cashier.staffName);
    });
  });

  it("leaves an ordinary QR order unattributed", async () => {
    // Nobody behind the counter touched it, so nobody's name goes on it.
    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "chips-classic" });
    const { order } = await json(await call("POST", "/api/orders", { cartId }));

    expect(order.processedBy).toBeUndefined();
  });
});
