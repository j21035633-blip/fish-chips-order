/**
 * @vitest-environment jsdom
 *
 * The staff side of the accountability layer: the sheet that asks who is taking
 * a payment, and the line that says who took it.
 *
 * The sheet is the part worth testing against the real module rather than by
 * reading the source, because its whole job is to survive a rejection — a
 * mistyped name has to leave the operator looking at the message with the fields
 * still filled in, not at a closed dialog and a lost transaction.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const staffDir = resolve(process.cwd(), "src/staff-web");
const page = (file: string) => readFileSync(resolve(staffDir, file), "utf8");

let attribution: any;

beforeAll(async () => {
  // jsdom has no <dialog> behaviour; the customer tests stub it the same way.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLElement) {
    this.removeAttribute("open");
  };

  attribution = await import(pathToFileURL(resolve(staffDir, "assets/attribution.js")).href);
});

beforeEach(() => {
  document.body.replaceChildren();
  attribution.resetStaffPrompt();
});

afterEach(() => {
  attribution.resetStaffPrompt();
});

const sheet = () => document.querySelector(".attribution-dialog") as HTMLElement;
const idField = () => document.getElementById("attribution-id") as HTMLInputElement;
const nameField = () => document.getElementById("attribution-name") as HTMLInputElement;
const error = () => sheet().querySelector(".form-error") as HTMLElement;
const confirm = () => sheet().querySelector("button.advance") as HTMLButtonElement;
const cancelButton = () => sheet().querySelector("button.ghost") as HTMLButtonElement;

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Lets the click handler's promise settle before the assertions run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("asking who is taking the payment", () => {
  it("opens with two empty fields and says what it is for", async () => {
    void attribution.askStaff({
      title: "Take RM18.65 — cash",
      detail: "Order AB-4821. Who is taking this payment?",
      onConfirm: async () => {},
    });

    expect(sheet().hasAttribute("open")).toBe(true);
    expect(sheet().querySelector("h2")!.textContent).toBe("Take RM18.65 — cash");
    expect(sheet().querySelector(".attribution-detail")!.textContent).toContain("AB-4821");
    expect(idField().value).toBe("");
    expect(nameField().value).toBe("");
  });

  it("will not submit half a pair", async () => {
    let called = 0;
    void attribution.askStaff({ onConfirm: async () => void (called += 1) });

    type(idField(), "AR47");
    confirm().click();
    await settle();

    expect(called).toBe(0);
    expect(error().hidden).toBe(false);
    expect(error().textContent).toContain("staff ID and the name");
    expect(sheet().hasAttribute("open")).toBe(true);
  });

  it("hands the trimmed pair to the action and closes when it works", async () => {
    const seen: any[] = [];
    const done = attribution.askStaff({ onConfirm: async (who: any) => void seen.push(who) });

    type(idField(), "  AR47 ");
    type(nameField(), " Aisyah Rahman ");
    confirm().click();

    await expect(done).resolves.toBe(true);
    expect(seen).toEqual([{ staffId: "AR47", staffName: "Aisyah Rahman" }]);
    expect(sheet().hasAttribute("open")).toBe(false);
  });

  it("stays open on a rejection, showing the server's own words", async () => {
    let attempts = 0;
    const done = attribution.askStaff({
      onConfirm: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('That name does not match staff ID "AR47".');
      },
    });

    type(idField(), "AR47");
    type(nameField(), "Ben Wong");
    confirm().click();
    await settle();

    expect(sheet().hasAttribute("open")).toBe(true);
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe('That name does not match staff ID "AR47".');
    // The fields keep what was typed, so the fix is one correction rather than
    // both fields again.
    expect(idField().value).toBe("AR47");
    // And Confirm comes back, rather than leaving a dead sheet on screen.
    expect(confirm().disabled).toBe(false);

    type(nameField(), "Aisyah Rahman");
    confirm().click();
    await expect(done).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("resolves false on cancel, without running the action", async () => {
    let called = 0;
    const done = attribution.askStaff({ onConfirm: async () => void (called += 1) });

    cancelButton().click();

    await expect(done).resolves.toBe(false);
    expect(called).toBe(0);
    expect(sheet().hasAttribute("open")).toBe(false);
  });

  it("never carries one transaction's identity into the next", async () => {
    const first = attribution.askStaff({ onConfirm: async () => {} });
    type(idField(), "AR47");
    type(nameField(), "Aisyah Rahman");
    confirm().click();
    await first;

    // A remembered id one tap from Confirm is exactly the hole this closes.
    void attribution.askStaff({ onConfirm: async () => {} });
    expect(idField().value).toBe("");
    expect(nameField().value).toBe("");
  });
});

describe("saying who took it", () => {
  it('reads "Settled by" once the money is in', () => {
    const line = attribution.processedByLine({
      paymentStatus: "paid",
      processedBy: { staffId: "AR47", name: "Aisyah Rahman" },
    });

    expect(line.textContent).toBe("Settled by: Aisyah Rahman");
    expect(line.querySelector(".processed-by-name")!.textContent).toBe("Aisyah Rahman");
  });

  it('reads "Handled by" while the money is still coming', () => {
    // A card takeaway is rung up long before the webhook makes it paid. Saying
    // "settled" there would be the one place this system lies about money.
    const line = attribution.processedByLine({
      paymentStatus: "pending",
      processedBy: { staffId: "AR47", name: "Aisyah Rahman" },
    });

    expect(line.textContent).toBe("Handled by: Aisyah Rahman");
  });

  it("shows nothing on an order nobody behind the counter touched", () => {
    expect(attribution.processedByLine({ paymentStatus: "paid" })).toBeNull();
    expect(attribution.processedByLine({ paymentStatus: "paid", processedBy: {} })).toBeNull();
  });
});

describe("the boards ask before they settle", () => {
  it("routes both boards' settle through the sheet, with the pair in the body", () => {
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = page(file);
      expect(html, file).toContain('import { askStaff, processedByLine } from "{{STAFF_BASE}}/assets/attribution.js"');
      expect(html, file).toContain("await askStaff({");
      expect(html, file).toContain("JSON.stringify({ method, staffId, staffName })");
      // And the name is shown wherever the order is.
      expect(html, file).toContain("processedByLine(order)");
    }
  });

  it("keeps the note about an unsettled card payment until the sheet is gone", () => {
    // A banner painted behind a modal is a banner nobody reads.
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = page(file);
      expect(html, file).toContain("if (note) showError(note);");
    }
  });
});

describe("the takeaway pay sheet", () => {
  const html = () => page("kitchen.html");

  it("asks for the pair in the sheet that already asks how it is paid", () => {
    const source = html();
    expect(source).toContain('id="pay-staff-id"');
    expect(source).toContain('id="pay-staff-name"');
    expect(source).toContain("JSON.stringify({ cartId: walkin.cartId, payment, staffId, staffName })");
  });

  it("blanks the fields every time it opens", () => {
    const source = html();
    expect(source).toContain('payStaffId.value = "";');
    expect(source).toContain('payStaffName.value = "";');
  });

  it("keeps the order alive when the pair is refused", () => {
    // The cart is not spent until the server has accepted it, so a wrong code
    // is a correction rather than starting the whole walk-in again.
    const source = html();
    expect(source).toContain("if (payDialog.open) {");
    const place = source.slice(source.indexOf("async function place(payment)"));
    // The cart is only reset after the request came back.
    expect(place.indexOf("const result = await api")).toBeLessThan(place.indexOf("resetWalkin()"));
  });
});

describe("the Staff page", () => {
  const html = () => page("accounts.html");

  it("is a staff view like the others, asking for its assets through the mount path", () => {
    const source = html();
    expect(source).toContain('data-staff-view="accounts"');
    expect(source).toContain('data-staff-base="{{STAFF_BASE}}"');
    expect(source).toContain('href="{{STAFF_BASE}}/assets/staff.css"');
  });

  it("lists id, name, role and status, and offers Add, Edit and Deactivate", () => {
    const source = html();
    for (const heading of ["Staff ID", "Name", "Role", "Status"]) {
      expect(source, heading).toContain(`>${heading}</th>`);
    }
    expect(source).toContain('text: "Add staff"');
    expect(source).toContain('text: "Edit"');
    // Named for what it does, and it does not erase anybody.
    expect(source).toContain('text: armed ? "Deactivate — keeps their history" : "Deactivate"');
    expect(source).toContain('method: "DELETE"');
  });

  it("confirms before deactivating, in two taps", () => {
    const source = html();
    expect(source).toContain("if (confirming !== account.staffId) {");
  });

  it("does not let the staff ID be edited once it exists", () => {
    // Every order this person processed points back at it.
    const source = html();
    expect(source).toContain("idInput.disabled = account !== null;");
    expect(source).toContain("Fixed — orders this person processed point at it.");
  });

  it("sends a password only when one was typed", () => {
    expect(html()).toContain("...(password ? { password } : {})");
  });

  it("says these accounts are the sign-in, and that cashiering is a separate check", () => {
    // Both halves matter to whoever reads this page: the password on an account
    // is now what gets somebody in, and the id-and-name typed at the till is
    // still its own thing and not affected by any of it.
    const source = html();
    expect(source).toMatch(/Signing in is per person/);
    expect(source).toMatch(/separate check/);
  });

  it("keeps roles behind an Owner check that comes from the server", () => {
    const source = html();
    expect(source).toContain('id="roles-section"');
    expect(source).toContain("isOwner = session.isOwner === true;");
    // Hidden outright rather than shown disabled — a greyed control invites a try.
    expect(source).toContain("rolesSection.hidden = !isOwner;");
    // And Owner itself carries no controls at all.
    expect(source).toContain("role.reserved");
  });

  it("styles a deactivated row as readable rather than hidden", () => {
    const css = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8");
    expect(css).toContain(".accounts tr.inactive td");
    expect(css).toContain(".processed-by");
  });
});

/**
 * The "Who's on duty" pill.
 *
 * Its whole job is to be informational, so most of what is checked here is that
 * it says the right thing and that nothing anywhere depends on what it says.
 */
describe("the on-duty pill", () => {
  let onDuty: any;
  let responses: Record<string, unknown>;
  let calls: { path: string; method: string; body: unknown }[];
  let widget: any;

  beforeAll(async () => {
    onDuty = await import(pathToFileURL(resolve(staffDir, "assets/onDuty.js")).href);
  });

  beforeEach(() => {
    calls = [];
    responses = { "/api/staff/checkin/current": { checkIn: null } };
    (globalThis as any).fetch = async (path: string, init?: any) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      return {
        ok: true,
        status: 200,
        json: async () => responses[path] ?? {},
      } as unknown as Response;
    };
  });

  afterEach(() => {
    widget?.stop();
    widget = undefined;
  });

  /** Mounts the pill and lets its first load settle. */
  async function mount() {
    widget = onDuty.onDutyWidget();
    document.body.replaceChildren(widget.node);
    await new Promise((done) => setTimeout(done, 0));
    return widget.node as HTMLElement;
  }

  const label = () => document.querySelector(".on-duty-label")!.textContent;
  const action = () => document.querySelector(".on-duty-action") as HTMLButtonElement;

  it("says nobody is on, and offers to check in", async () => {
    const pill = await mount();

    expect(label()).toBe("Not checked in");
    expect(action().textContent).toBe("Check in");
    expect(pill.className).toBe("on-duty");
  });

  it("shows the name and offers to check out when somebody is on", async () => {
    responses["/api/staff/checkin/current"] = { checkIn: { staffId: "AR47", name: "Aisyah Rahman" } };
    const pill = await mount();

    expect(label()).toBe("Aisyah Rahman");
    expect(action().textContent).toBe("Check out");
    // Styled apart, so a glance at the header answers the question.
    expect(pill.className).toBe("on-duty on");
  });

  it("reads its state from the server on load, not from this browser", async () => {
    await mount();
    // No localStorage, no cookie: the pill is the same on every tablet, and a
    // reload asks again rather than trusting anything local.
    expect(calls.map((entry) => entry.path)).toEqual(["/api/staff/checkin/current"]);
    expect(localStorage.length).toBe(0);
  });

  it("checks out on a tap, and goes back to saying nobody is on", async () => {
    responses["/api/staff/checkin/current"] = { checkIn: { staffId: "AR47", name: "Aisyah Rahman" } };
    await mount();

    responses["/api/staff/checkout"] = { checkIn: null };
    action().click();
    await new Promise((done) => setTimeout(done, 0));

    expect(calls.some((entry) => entry.path === "/api/staff/checkout" && entry.method === "POST")).toBe(true);
    expect(label()).toBe("Not checked in");
  });

  it("posts the pair as { staffId, name }, which is what the endpoint takes", () => {
    // The till's sheet calls its second field staffName; this endpoint calls it
    // name. The mapping happens here, once.
    const source = readFileSync(resolve(staffDir, "assets/onDuty.js"), "utf8");
    expect(source).toContain("body: JSON.stringify({ staffId, name: staffName })");
    // And it reuses the sheet rather than growing a second one.
    expect(source).toContain('import { askStaff } from "./attribution.js"');
  });

  it("says a shift's length, and that an open one is still running", () => {
    const start = "2026-03-01T10:00:00.000Z";
    const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60000).toISOString();

    expect(onDuty.shiftLength({ checkedInAt: start, checkedOutAt: at(45) })).toBe("45 min");
    expect(onDuty.shiftLength({ checkedInAt: start, checkedOutAt: at(120) })).toBe("2 h");
    expect(onDuty.shiftLength({ checkedInAt: start, checkedOutAt: at(135) })).toBe("2 h 15 min");
    // Still on: measured to now rather than reading as zero.
    expect(onDuty.shiftLength({ checkedInAt: start }, Date.parse(start) + 30 * 60000)).toBe("30 min");
  });

  it("dates a time from another day, and does not date today's", () => {
    const today = new Date();
    today.setHours(14, 5, 0, 0);
    expect(onDuty.shiftTime(today.toISOString(), today)).not.toMatch(/[A-Za-z]/);

    const earlier = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(onDuty.shiftTime(earlier.toISOString(), today)).toMatch(/[A-Za-z]/);
    expect(onDuty.shiftTime(undefined, today)).toBe("—");
  });
});

describe("the boards carry the pill, and nothing waits on it", () => {
  it("mounts it beside the live indicator on both boards", () => {
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = page(file);
      expect(html, file).toContain('import { onDutyWidget } from "{{STAFF_BASE}}/assets/onDuty.js"');
      expect(html, file).toContain("const onDuty = onDutyWidget();");
      expect(html, file).toContain("slot.append(onDuty.node, feedState");
    }
  });

  it("gates nothing on it, on either board", () => {
    // The line this feature must not cross. If any of these ever appears, the
    // pill has stopped being a note and started being a lock.
    for (const file of ["staff.html", "kitchen.html"]) {
      const html = page(file);
      for (const pattern of ["onDuty.current", "if (!onDuty", "checkedIn &&"]) {
        expect(html.includes(pattern), `${file} must not gate on ${pattern}`).toBe(false);
      }
    }
  });
});

describe("the shift log on the Staff page", () => {
  const html = () => page("accounts.html");

  it("lists name and both times", () => {
    const source = html();
    for (const heading of ["Name", "Checked in", "Checked out", "For"]) {
      expect(source, heading).toContain(`>${heading}</th>`);
    }
    expect(source).toContain('api("/api/staff/checkin/history")');
  });

  it("marks the shift nobody has closed rather than leaving a blank cell", () => {
    expect(html()).toContain('text: "On now"');
  });

  it("says what it is, and what it is not", () => {
    // Somebody reading this page must not think it is a login or an audit of
    // who took the money.
    expect(html()).toMatch(/does not sign anybody in and blocks nothing/);
  });
});
