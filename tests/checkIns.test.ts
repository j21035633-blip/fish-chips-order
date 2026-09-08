/**
 * "Who's on duty" — the shift log for the shared tablet.
 *
 * The thing worth keeping straight is what this is *not*. It is not a login and
 * it is not the cashiering check: it decides nothing, blocks nothing, and a
 * board with nobody checked in works exactly as well as one with somebody on.
 * Several of the assertions below exist only to hold that line, because the
 * easiest way for this feature to go wrong is for something to start depending
 * on it.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Services } from "../src/app/container.js";
import { InMemoryProofRepository } from "../src/game/proofs.js";
import { createServer } from "../src/http/app.js";
import { MenuService } from "../src/menu/service.js";
import { MenuStore } from "../src/menu/store.js";
import { InMemoryCartRepository, InMemoryOrderRepository } from "../src/orders/repository.js";
import { CartService, OrderService } from "../src/orders/service.js";
import { createPaymentService } from "../src/payments/service.js";
import { InMemoryStaffAccountRepository, StaffAccountService } from "../src/staff/accounts.js";
import { DeviceCheckInService, InMemoryDeviceCheckInRepository } from "../src/staff/checkIns.js";
import { InMemoryRoleRepository, RoleService } from "../src/staff/roles.js";

const AISYAH = { staffId: "AR47", name: "Aisyah Rahman", password: "till-pass" };
const BEN = { staffId: "BW12", name: "Ben Wong", password: "till-pass" };

let server: Server;
let base: string;
let app: Services;

beforeAll(async () => {
  const menuStore = new MenuStore();
  const menu = new MenuService(menuStore);
  const carts = new CartService(new InMemoryCartRepository(), menu);
  const orders = new OrderService(new InMemoryOrderRepository(), carts, menu);
  app = {
    carts,
    orders,
    menu,
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

beforeEach(async () => {
  // A fresh log and a fresh cast each time — one test's shift must not show up
  // in another's history.
  app.checkIns = new DeviceCheckInService(new InMemoryDeviceCheckInRepository());
  app.staffAccounts = new StaffAccountService(new InMemoryStaffAccountRepository());
  for (const person of [AISYAH, BEN]) await app.staffAccounts.create(person);
});

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const checkIn = (who: { staffId: string; name: string }) =>
  call("POST", "/api/staff/checkin", { staffId: who.staffId, name: who.name });
const checkOut = () => call("POST", "/api/staff/checkout");
const current = async () => (await json(await call("GET", "/api/staff/checkin/current"))).checkIn;
const history = async () => (await json(await call("GET", "/api/staff/checkin/history"))).checkIns;

describe("checking in", () => {
  it("starts with nobody on", async () => {
    expect(await current()).toBeNull();
    expect(await history()).toEqual([]);
  });

  it("records who came on, and when", async () => {
    const response = await checkIn(AISYAH);
    expect(response.status).toBe(201);

    const body = await json(response);
    expect(body.checkIn).toMatchObject({ staffId: "AR47", name: "Aisyah Rahman" });
    expect(body.checkIn.checkedInAt).toEqual(expect.any(String));
    // Still on, so there is no end yet.
    expect(body.checkIn.checkedOutAt).toBeUndefined();
    expect(body.replaced).toBeNull();

    expect(await current()).toMatchObject({ staffId: "AR47", name: "Aisyah Rahman" });
  });

  it("stores the account's own spelling of the name, not what was typed", async () => {
    // The log has to read correctly, and it is the same rule `processedBy`
    // follows: a copy taken at the time, in the shop's own spelling.
    await checkIn({ staffId: "ar47", name: "aisyah rahman" });
    expect((await current()).name).toBe("Aisyah Rahman");
  });

  it("survives a reload, because the state is the server's", async () => {
    await checkIn(AISYAH);
    // Nothing here is a cookie or a localStorage key: a second "browser"
    // asking cold gets the same answer, which is what makes the pill the same
    // on every tablet.
    expect(await current()).toMatchObject({ staffId: "AR47" });
  });
});

describe("what it refuses", () => {
  it("rejects a name that does not go with the ID", async () => {
    const response = await checkIn({ staffId: AISYAH.staffId, name: "Somebody Else" });

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({
      error: "staff_verification_failed",
      details: { reason: "name_mismatch" },
    });
    expect(await current()).toBeNull();
  });

  it("rejects an ID nobody has", async () => {
    const response = await checkIn({ staffId: "ZZ99", name: "Aisyah Rahman" });
    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ details: { reason: "unknown" } });
  });

  it("rejects somebody whose account has been switched off", async () => {
    await app.staffAccounts.deactivate(AISYAH.staffId);

    const response = await checkIn(AISYAH);
    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ details: { reason: "inactive" } });
    expect(await current()).toBeNull();
  });

  it("rejects half a pair", async () => {
    expect((await call("POST", "/api/staff/checkin", { staffId: AISYAH.staffId })).status).toBe(400);
    expect((await call("POST", "/api/staff/checkin", { name: AISYAH.name })).status).toBe(400);
    expect((await call("POST", "/api/staff/checkin", {})).status).toBe(400);
  });

  it("leaves whoever was already on, on, when the new pair is refused", async () => {
    await checkIn(AISYAH);

    expect((await checkIn({ staffId: BEN.staffId, name: "Wrong Name" })).status).toBe(400);
    // The check runs before anything is closed, so a typo does not end
    // somebody's shift.
    expect(await current()).toMatchObject({ staffId: "AR47" });
    expect(await history()).toHaveLength(1);
  });
});

describe("handing the tablet over", () => {
  it("checks the previous person out when the next one checks in", async () => {
    const first = await json(await checkIn(AISYAH));
    const second = await json(await checkIn(BEN));

    expect(second.checkIn).toMatchObject({ staffId: "BW12" });
    // Named in the response, so the widget can say who was taken over from.
    expect(second.replaced).toMatchObject({ staffId: "AR47" });
    expect(second.replaced.checkedOutAt).toEqual(expect.any(String));

    // One person on, and it is the new one.
    expect(await current()).toMatchObject({ staffId: "BW12" });

    const log = await history();
    expect(log).toHaveLength(2);
    const aisyah = log.find((entry: any) => entry.id === first.checkIn.id);
    expect(aisyah.checkedOutAt).toBe(second.replaced.checkedOutAt);
  });

  it("closes the old shift exactly when the new one opens", async () => {
    await checkIn(AISYAH);
    const second = await json(await checkIn(BEN));

    // No gap and no overlap: the handover is one moment, so the log adds up.
    expect(second.replaced.checkedOutAt).toBe(second.checkIn.checkedInAt);
  });

  it("lets the same person check in again, which starts a new shift", async () => {
    await checkIn(AISYAH);
    await checkIn(AISYAH);

    expect(await history()).toHaveLength(2);
    expect((await history()).filter((entry: any) => !entry.checkedOutAt)).toHaveLength(1);
  });
});

describe("checking out", () => {
  it("closes the active shift", async () => {
    const { checkIn: started } = await json(await checkIn(AISYAH));

    const response = await checkOut();
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.checkIn).toMatchObject({ id: started.id, staffId: "AR47" });
    expect(body.checkIn.checkedOutAt).toEqual(expect.any(String));

    expect(await current()).toBeNull();
  });

  it("is boring when nobody is on", async () => {
    // A second tap, or a tablet somebody else already signed off. Not an error.
    const response = await checkOut();
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({ checkIn: null });
  });

  it("does not ask who is doing it", async () => {
    await checkIn(AISYAH);
    // Making somebody prove who they are in order to *stop* being recorded
    // would only produce shifts that never end.
    expect((await call("POST", "/api/staff/checkout")).status).toBe(200);
    expect(await current()).toBeNull();
  });
});

describe("the shift log", () => {
  it("reads newest first, with accurate timestamps", async () => {
    const one = await json(await checkIn(AISYAH));
    await checkOut();
    const two = await json(await checkIn(BEN));

    const log = await history();
    expect(log.map((entry: any) => entry.name)).toEqual(["Ben Wong", "Aisyah Rahman"]);

    // Every timestamp is the one the endpoint reported at the time.
    expect(log[1]).toMatchObject({ id: one.checkIn.id, checkedInAt: one.checkIn.checkedInAt });
    expect(log[1].checkedOutAt).toEqual(expect.any(String));
    expect(new Date(log[1].checkedOutAt).getTime()).toBeGreaterThanOrEqual(
      new Date(log[1].checkedInAt).getTime(),
    );

    // The person still on is in the log too, still open — a shift log that hid
    // the current shift would be the one thing nobody could look up.
    expect(log[0]).toMatchObject({ id: two.checkIn.id });
    expect(log[0].checkedOutAt).toBeUndefined();
  });

  it("caps how much it will hand back", async () => {
    expect((await call("GET", "/api/staff/checkin/history?limit=0")).status).toBe(400);
    expect((await call("GET", "/api/staff/checkin/history?limit=5000")).status).toBe(400);
    expect((await call("GET", "/api/staff/checkin/history?limit=5")).status).toBe(200);
  });

  it("honours a limit, keeping the newest", async () => {
    for (const person of [AISYAH, BEN, AISYAH]) await checkIn(person);

    const { checkIns } = await json(await call("GET", "/api/staff/checkin/history?limit=2"));
    expect(checkIns).toHaveLength(2);
    expect(checkIns[0].checkedOutAt).toBeUndefined();
  });
});

describe("it gates nothing", () => {
  it("leaves the boards and Quick Add working with nobody checked in", async () => {
    expect(await current()).toBeNull();

    // The two things the counter cannot do without: see the orders, and ring
    // one up. Neither asks whether anybody has tapped the pill.
    expect((await call("GET", "/api/staff/overview")).status).toBe(200);

    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "chips-classic" });
    const rung = await call("POST", "/api/staff/orders/takeaway", {
      cartId,
      payment: "cash",
      staffId: AISYAH.staffId,
      staffName: AISYAH.name,
    });
    expect(rung.status).toBe(200);
  });

  it("does not stand in for the cashiering check", async () => {
    // Checked in as Aisyah, then ringing up as Ben with the wrong name: the
    // till still refuses. One is a note on the wall; the other is attribution.
    await checkIn(AISYAH);

    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "chips-classic" });

    const wrong = await call("POST", "/api/staff/orders/takeaway", {
      cartId,
      payment: "cash",
      staffId: BEN.staffId,
      staffName: "Not Ben",
    });
    expect(wrong.status).toBe(400);

    // And being checked in as Aisyah does not let Ben skip naming himself.
    const missing = await call("POST", "/api/staff/orders/takeaway", { cartId, payment: "cash" });
    expect(missing.status).toBe(400);
  });

  it("attributes a payment to whoever rang it up, not to whoever is on duty", async () => {
    await checkIn(AISYAH);

    const { cartId } = await json(await call("POST", "/api/carts", {}));
    await call("POST", `/api/carts/${cartId}/lines`, { itemId: "chips-classic" });
    const body = await json(
      await call("POST", "/api/staff/orders/takeaway", {
        cartId,
        payment: "cash",
        staffId: BEN.staffId,
        staffName: BEN.name,
      }),
    );

    // Ben took the money while Aisyah was on duty. Both are true, and the order
    // records the one that is about the money.
    expect(body.order.processedBy).toMatchObject({ staffId: "BW12", name: "Ben Wong" });
    expect(await current()).toMatchObject({ staffId: "AR47" });
  });
});

describe("the service on its own", () => {
  it("keeps at most one shift open, whatever order things happen in", async () => {
    const service = new DeviceCheckInService(new InMemoryDeviceCheckInRepository());
    const who = (staffId: string, name: string) => ({ staffId, name, at: new Date().toISOString() });

    await service.checkIn(who("AR47", "Aisyah Rahman"));
    await service.checkIn(who("BW12", "Ben Wong"));
    await service.checkIn(who("AR47", "Aisyah Rahman"));

    const open = (await service.history()).filter((entry) => entry.checkedOutAt === undefined);
    expect(open).toHaveLength(1);
    expect(open[0]!.staffId).toBe("AR47");

    await service.checkOut();
    expect(await service.current()).toBeUndefined();
    expect((await service.history()).every((entry) => entry.checkedOutAt !== undefined)).toBe(true);
  });
});
