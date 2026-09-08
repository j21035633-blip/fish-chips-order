import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Individual staff accounts, for **attribution** — not for signing in.
 *
 * The shared password in `auth.ts` is still the only thing that opens the staff
 * area, and nothing here changes that. What this adds is the question that gate
 * cannot answer: *which* of the six people who know that password took the
 * money for order AB-4821. So an account is a short code and a name that a
 * cashier types at the moment they take a payment, checked against a real
 * active record, and stamped onto the order.
 *
 * The password is hashed and stored because these records are the obvious
 * foundation for per-user login later, and a column added afterwards would mean
 * a shop-wide password reset. Nothing reads it yet — see `passwordMatches`.
 *
 * Deactivating is a soft delete, and that is load-bearing rather than tidy:
 * every order this person ever settled carries their name, and a report that
 * cannot resolve who processed a transaction six months ago is not a record.
 */

export interface StaffAccount {
  /** Short code the cashier types, e.g. "AR47". Normalised uppercase; unique. */
  staffId: string;
  name: string;
  /** `scrypt$<salt>$<hash>`. Stored for a future login; nothing checks it today. */
  passwordHash: string;
  /** Free text — "Cashier", "Kitchen", "Manager". No permission hangs off it yet. */
  role: string;
  /** False once deactivated. The record stays, so old orders still resolve a name. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deactivatedAt?: string;
}

/** An account as the API hands it out: everything except the hash. */
export type StaffAccountView = Omit<StaffAccount, "passwordHash">;

/**
 * Who took the money, stamped on the order at the moment they did.
 *
 * The name is **copied**, not looked up later. That is the whole point of
 * recording it: the account can be renamed or deactivated, and the order still
 * says who handled it on the day.
 */
export interface ProcessedBy {
  staffId: string;
  name: string;
  at: string;
}

/** Thrown for anything a manager or a cashier could fix by typing something else. */
export class StaffAccountError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StaffAccountError";
  }
}

export interface StaffAccountRepository {
  get(staffId: string): Promise<StaffAccount | undefined>;
  save(account: StaffAccount): Promise<void>;
  /** Every account, deactivated ones included — this is the page that reactivates them. */
  list(): Promise<StaffAccount[]>;
}

export class InMemoryStaffAccountRepository implements StaffAccountRepository {
  private readonly accounts = new Map<string, StaffAccount>();

  async get(staffId: string): Promise<StaffAccount | undefined> {
    const account = this.accounts.get(staffId);
    return account === undefined ? undefined : structuredClone(account);
  }

  async save(account: StaffAccount): Promise<void> {
    this.accounts.set(account.staffId, structuredClone(account));
  }

  async list(): Promise<StaffAccount[]> {
    return [...this.accounts.values()].map((account) => structuredClone(account));
  }
}

const MAX_NAME = 60;
const MAX_ROLE = 40;
const MAX_ID = 12;
const MIN_ID = 2;
/** Short enough to type at a till, long enough not to be one keystroke from someone else's. */
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 200;

export interface CreateAccountInput {
  /** Optional: left out, one is generated from the name. */
  staffId?: string | undefined;
  name?: string | undefined;
  password?: string | undefined;
  role?: string | undefined;
}

export interface UpdateAccountInput {
  name?: string | undefined;
  role?: string | undefined;
  /** Only when it is being reset; absent leaves the stored hash alone. */
  password?: string | undefined;
}

export class StaffAccountService {
  constructor(private readonly repo: StaffAccountRepository) {}

  /** Newest last, active first — the working list at the top, the archive below. */
  async list(): Promise<StaffAccountView[]> {
    const accounts = await this.repo.list();
    accounts.sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return accounts.map(toView);
  }

  async get(staffId: string): Promise<StaffAccount> {
    const account = await this.repo.get(normaliseId(staffId));
    if (account === undefined) {
      throw new StaffAccountError(`No staff account "${staffId}".`, "unknown_staff_account", { staffId });
    }
    return account;
  }

  async create(input: CreateAccountInput): Promise<StaffAccountView> {
    const name = requireText(input.name, "name", MAX_NAME);
    const role = optionalText(input.role, "role", MAX_ROLE) || "Staff";
    const password = requirePassword(input.password);

    const staffId =
      input.staffId === undefined || input.staffId.trim().length === 0
        ? await this.generateId(name)
        : requireId(input.staffId);

    // Checked against every account, not just the active ones: a deactivated
    // record still owns its code, and handing it to somebody new would make two
    // people share a history.
    if (await this.repo.get(staffId)) {
      throw new StaffAccountError(`Staff ID "${staffId}" is already taken.`, "duplicate_staff_id", { staffId });
    }

    const now = new Date().toISOString();
    const account: StaffAccount = {
      staffId,
      name,
      passwordHash: hashPassword(password),
      role,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.save(account);
    return toView(account);
  }

  /**
   * Edits the name, the role, and optionally the password.
   *
   * The id is deliberately not editable: it is what every order this person has
   * processed points back at, and changing it would orphan all of them.
   */
  async update(staffId: string, input: UpdateAccountInput): Promise<StaffAccountView> {
    const account = await this.get(staffId);

    if (input.name !== undefined) account.name = requireText(input.name, "name", MAX_NAME);
    if (input.role !== undefined) account.role = optionalText(input.role, "role", MAX_ROLE) || "Staff";
    if (input.password !== undefined) account.passwordHash = hashPassword(requirePassword(input.password));

    account.updatedAt = new Date().toISOString();
    await this.repo.save(account);
    return toView(account);
  }

  /**
   * Soft delete. The record stays exactly where it is; only `active` moves.
   *
   * Nothing this person processed is touched, and nothing should be: the order
   * carries a copy of their name, so a receipt reprinted next year still says
   * who took the money.
   */
  async deactivate(staffId: string): Promise<StaffAccountView> {
    const account = await this.get(staffId);
    if (account.active) {
      account.active = false;
      account.deactivatedAt = new Date().toISOString();
      account.updatedAt = account.deactivatedAt;
      await this.repo.save(account);
    }
    return toView(account);
  }

  /** Puts a deactivated account back on shift. */
  async reactivate(staffId: string): Promise<StaffAccountView> {
    const account = await this.get(staffId);
    if (!account.active) {
      account.active = true;
      delete account.deactivatedAt;
      account.updatedAt = new Date().toISOString();
      await this.repo.save(account);
    }
    return toView(account);
  }

  /**
   * The attribution check the two cashiering flows run.
   *
   * Not a login: there is no password here and no session comes out of it. It
   * asks one question — *is this a real person who is on shift, and is this
   * their name?* — and answers it strictly enough that a typo cannot land
   * somebody else's name on a transaction.
   *
   * The name is matched case-insensitively on trimmed text, because it is typed
   * on a tablet during service and "aisyah rahman" is the same person. The id is
   * matched on its normalised form for the same reason.
   *
   * One error code for all three failures, with the reason in `details`. The
   * message says which it was — this sits behind the shared password gate, so
   * there is nobody to withhold it from, and a cashier needs to know whether to
   * fix the code or the spelling.
   */
  async verify(input: { staffId?: unknown; staffName?: unknown }): Promise<ProcessedBy> {
    const staffId = normaliseId(String(input.staffId ?? ""));
    const staffName = String(input.staffName ?? "").trim();

    if (staffId.length === 0 || staffName.length === 0) {
      throw new StaffAccountError(
        "Enter the staff ID and name of whoever is taking this payment.",
        "staff_verification_failed",
        { reason: "missing" },
      );
    }

    const account = await this.repo.get(staffId);
    if (account === undefined) {
      throw new StaffAccountError(`No staff account with ID "${staffId}".`, "staff_verification_failed", {
        reason: "unknown",
        staffId,
      });
    }
    if (!account.active) {
      throw new StaffAccountError(
        `${account.name} (${account.staffId}) is no longer an active account.`,
        "staff_verification_failed",
        { reason: "inactive", staffId },
      );
    }
    if (account.name.trim().toLowerCase() !== staffName.toLowerCase()) {
      throw new StaffAccountError(
        `That name does not match staff ID "${account.staffId}".`,
        "staff_verification_failed",
        { reason: "name_mismatch", staffId },
      );
    }

    // The account's own spelling, not what was typed: this is what gets printed
    // on the order, so it should read the way the staff list does.
    return { staffId: account.staffId, name: account.name, at: new Date().toISOString() };
  }

  /**
   * A code from the person's initials plus two digits — "Aisyah Rahman" → "AR47".
   *
   * Readable and short, because somebody types it at a till a hundred times a
   * shift. Retried on collision, then given up on in favour of something random
   * rather than looping forever on a shop full of A. R.s.
   */
  private async generateId(name: string): Promise<string> {
    const initials =
      name
        .split(/\s+/)
        .map((part) => part.replace(/[^A-Za-z0-9]/g, "").charAt(0))
        .filter((letter) => letter.length > 0)
        .slice(0, 2)
        .join("")
        .toUpperCase() || "S";

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = `${initials}${String(randomInt(0, 100)).padStart(2, "0")}`;
      if (!(await this.repo.get(candidate))) return candidate;
    }

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = `S${randomBytes(3).toString("hex").toUpperCase()}`;
      if (!(await this.repo.get(candidate))) return candidate;
    }
    throw new StaffAccountError("Could not generate a free staff ID.", "staff_id_exhausted");
  }
}

export function toView(account: StaffAccount): StaffAccountView {
  const { passwordHash: _hash, ...view } = account;
  return view;
}

// ------------------------------------------------------------------ passwords

/**
 * scrypt, with a per-account salt. No dependency: `node:crypto` has it, and it
 * is the same reasoning as the session HMAC in `auth.ts` — a real primitive from
 * the standard library beats a library nothing else here needs.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}

/**
 * Checks a password against a stored hash.
 *
 * **Nothing calls this yet** — there is no per-account login, on purpose. It is
 * here so the hash being stored is a hash that demonstrably works, rather than a
 * write-only column nobody discovers is malformed until the day it matters.
 */
export function passwordMatches(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || saltHex === undefined || hashHex === undefined) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// -------------------------------------------------------------------- parsing

/** "ar-47 " → "AR-47". Case and spacing are typing noise, not identity. */
export function normaliseId(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

function requireId(raw: string): string {
  const id = normaliseId(raw);
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(id) || id.length < MIN_ID || id.length > MAX_ID) {
    throw new StaffAccountError(
      `A staff ID is ${MIN_ID}–${MAX_ID} letters, digits or dashes, e.g. "AR47".`,
      "invalid_staff_id",
      { staffId: raw },
    );
  }
  return id;
}

function requireText(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw new StaffAccountError(`${field} is required.`, "missing_field", { field });
  }
  if (trimmed.length > max) {
    throw new StaffAccountError(`${field} must be ${max} characters or fewer.`, "field_too_long", { field, max });
  }
  return trimmed;
}

function optionalText(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > max) {
    throw new StaffAccountError(`${field} must be ${max} characters or fewer.`, "field_too_long", { field, max });
  }
  return trimmed;
}

function requirePassword(password: string | undefined): string {
  const value = password ?? "";
  if (value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw new StaffAccountError(
      `A password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`,
      "invalid_password",
      { min: MIN_PASSWORD, max: MAX_PASSWORD },
    );
  }
  return value;
}
