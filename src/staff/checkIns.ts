import { randomUUID } from "node:crypto";

import type { ProcessedBy } from "./accounts.js";

/**
 * Who is physically standing at the shared tablet, and since when.
 *
 * This is the third and loosest of three things that all involve a staff id,
 * and the difference between them is worth being clear about:
 *
 * - **Signing in** (`auth.ts`) decides what the browser may open. It is a
 *   password and a session.
 * - **The cashiering check** (`accounts.ts`) decides whose name goes on a
 *   payment. It is per transaction and it blocks the transaction.
 * - **This** decides nothing. It is a shift log: a note on the wall saying who
 *   is on, kept because a shop with one tablet and one login has no other way
 *   to answer "who was working at four o'clock". Nothing is gated on it, on
 *   purpose — a fryer that stops working because somebody forgot to tap a pill
 *   is worse than not knowing who was on the fryer.
 *
 * **One check-in at a time, shop-wide.** The record has no device field, so
 * checking somebody in closes whoever was on. That is right for one tablet on
 * one pass, which is this shop; a second till would need a device id here and
 * in the two endpoints that read "the active one".
 */

export interface DeviceCheckIn {
  id: string;
  staffId: string;
  /** Copied at check-in, like `ProcessedBy` — the log must still read if the account is renamed. */
  name: string;
  checkedInAt: string;
  /** Absent while they are still on. */
  checkedOutAt?: string;
}

export interface DeviceCheckInRepository {
  /** Whoever is on, or undefined. There is at most one. */
  active(): Promise<DeviceCheckIn | undefined>;
  save(record: DeviceCheckIn): Promise<void>;
  /** Newest first — a shift log is read from the top. */
  recent(limit: number): Promise<DeviceCheckIn[]>;
}

export class InMemoryDeviceCheckInRepository implements DeviceCheckInRepository {
  private readonly records = new Map<string, DeviceCheckIn>();

  async active(): Promise<DeviceCheckIn | undefined> {
    const open = [...this.records.values()].filter((record) => record.checkedOutAt === undefined);
    open.sort((left, right) => right.checkedInAt.localeCompare(left.checkedInAt));
    const found = open[0];
    return found === undefined ? undefined : structuredClone(found);
  }

  async save(record: DeviceCheckIn): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async recent(limit: number): Promise<DeviceCheckIn[]> {
    return [...this.records.values()]
      .sort((left, right) => right.checkedInAt.localeCompare(left.checkedInAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

/** A shift log longer than this is a report, not a widget. */
export const MAX_HISTORY = 200;
const DEFAULT_HISTORY = 50;

export class DeviceCheckInService {
  constructor(private readonly repo: DeviceCheckInRepository) {}

  /** Whoever is on the tablet right now, or undefined. */
  async current(): Promise<DeviceCheckIn | undefined> {
    return this.repo.active();
  }

  /**
   * Puts somebody on, taking whoever was on off first.
   *
   * `who` has already been checked against a real active account — the caller
   * runs it through the same `StaffAccountService.verify` the till uses — so
   * this takes the answer, and the name it stores is the account's own spelling
   * rather than whatever was typed.
   *
   * Closing comes first. Two writes are not one transaction, so the order
   * decides what a half-failure leaves behind: closed-then-nobody is a gap in
   * the log, and open-then-two-actives is a log that cannot be read at all.
   */
  async checkIn(who: ProcessedBy): Promise<{ checkIn: DeviceCheckIn; replaced?: DeviceCheckIn }> {
    const now = new Date().toISOString();
    const previous = await this.closeActive(now);

    const checkIn: DeviceCheckIn = {
      id: randomUUID(),
      staffId: who.staffId,
      name: who.name,
      checkedInAt: now,
    };
    await this.repo.save(checkIn);

    return previous === undefined ? { checkIn } : { checkIn, replaced: previous };
  }

  /**
   * Takes whoever is on, off.
   *
   * Returns undefined when nobody was, which is not an error: a second tap on
   * Check Out, or a tap on a tablet somebody else already signed off, should be
   * boring rather than a red banner.
   */
  async checkOut(): Promise<DeviceCheckIn | undefined> {
    return this.closeActive(new Date().toISOString());
  }

  /** The shift log, newest first. The person still on is included, still open. */
  async history(limit = DEFAULT_HISTORY): Promise<DeviceCheckIn[]> {
    const capped = Math.max(1, Math.min(MAX_HISTORY, Math.floor(limit)));
    return this.repo.recent(capped);
  }

  private async closeActive(at: string): Promise<DeviceCheckIn | undefined> {
    const active = await this.repo.active();
    if (active === undefined) return undefined;

    active.checkedOutAt = at;
    await this.repo.save(active);
    return active;
  }
}
