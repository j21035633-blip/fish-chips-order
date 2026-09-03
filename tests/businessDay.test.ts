import { describe, expect, it } from "vitest";
import { businessDay, businessDayRange } from "../src/orders/businessDay.js";

const KL = "Asia/Kuala_Lumpur";

describe("businessDay", () => {
  it("uses the shop's zone, not the server's", () => {
    // 23:30 UTC is already tomorrow in KL (+08:00).
    expect(businessDay("2026-09-03T23:30:00Z", KL)).toBe("2026-09-04");
    expect(businessDay("2026-09-03T15:59:00Z", KL)).toBe("2026-09-03");
    expect(businessDay("2026-09-03T16:00:00Z", KL)).toBe("2026-09-04");
  });
});

describe("businessDayRange", () => {
  it("brackets a KL day", () => {
    const { start, end } = businessDayRange("2026-09-03", KL);
    expect(start).toBe("2026-09-02T16:00:00.000Z");
    expect(end).toBe("2026-09-03T16:00:00.000Z");
  });

  it("handles a zone with DST", () => {
    // London is UTC+1 in September.
    expect(businessDayRange("2026-09-03", "Europe/London").start).toBe("2026-09-02T23:00:00.000Z");
    // ...and UTC+0 in January.
    expect(businessDayRange("2026-01-03", "Europe/London").start).toBe("2026-01-03T00:00:00.000Z");
  });

  it("handles a half-hour offset", () => {
    expect(businessDayRange("2026-09-03", "Asia/Kolkata").start).toBe("2026-09-02T18:30:00.000Z");
  });

  it("is half-open, so midnight belongs to one day only", () => {
    const first = businessDayRange("2026-09-03", KL);
    const second = businessDayRange("2026-09-04", KL);
    expect(first.end).toBe(second.start);
  });
});
