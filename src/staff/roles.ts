/**
 * Roles, and what each one is allowed to see.
 *
 * A role is a name and a set of nav sections. It is deliberately that small:
 * this shop has seven screens, and a permission model finer than "which screens"
 * would be a lot of machinery for a fryer, a till and a tablet.
 *
 * **Owner is reserved and virtual.** It is never stored, always resolves to every
 * section, and every endpoint that could edit or delete it refuses. Keeping it
 * out of the database is what makes that guarantee cheap: there is no row to
 * corrupt, no migration that can drop it, and no way for a role edit to lock the
 * last administrator out of the staff page they would need to undo it.
 *
 * Roles are keyed by a normalised name, so "Cashier" and "cashier " are one
 * role. `StaffAccount.role` holds the name, which is why the free-text values
 * that predate this file keep working — see `ensureRolesFor`.
 */

/**
 * The nav sections a role can be given, and the vocabulary the API gate speaks.
 *
 * These are permission keys, not URLs: `assets/nav.js` maps each view to one of
 * them, and `sectionsForPath` in the HTTP layer maps each `/api/staff` route to
 * the one (or two) it serves. Both directions are tested, because a section that
 * names nothing is a permission nobody can be given and a route that names
 * nothing is a route nobody can reach.
 */
export const NAV_SECTIONS = [
  "dashboard",
  "kitchen_counter",
  "sales_report",
  "menu",
  "table_qr",
  "approvals",
  "staff",
] as const;
export type SectionKey = (typeof NAV_SECTIONS)[number];

/** The reserved role. Not stored, not editable, always everything. */
export const OWNER_ROLE = "Owner";

/**
 * What a free-text role becomes when it is migrated.
 *
 * The shop's existing values are things like "Cashier" and "Kitchen", and the
 * safe reading of both is "works the counter". Sales, QR codes and the staff
 * list are the three that carry money, printing and other people's accounts, so
 * none of them is granted by default — an Owner widens a role afterwards, which
 * is a deliberate act, rather than discovering it was wide all along.
 */
export const DEFAULT_SECTIONS: SectionKey[] = ["kitchen_counter", "menu"];

export interface Role {
  /** As typed, e.g. "Front of house". Unique on its normalised form. */
  name: string;
  permittedSections: SectionKey[];
  createdAt: string;
  updatedAt: string;
  /** True only for the virtual Owner role. Never stored. */
  reserved?: boolean;
}

export class RoleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RoleError";
  }
}

export interface RoleRepository {
  get(key: string): Promise<Role | undefined>;
  save(key: string, role: Role): Promise<void>;
  list(): Promise<Role[]>;
  remove(key: string): Promise<void>;
}

export class InMemoryRoleRepository implements RoleRepository {
  private readonly roles = new Map<string, Role>();

  async get(key: string): Promise<Role | undefined> {
    const role = this.roles.get(key);
    return role === undefined ? undefined : structuredClone(role);
  }

  async save(key: string, role: Role): Promise<void> {
    this.roles.set(key, structuredClone(role));
  }

  async list(): Promise<Role[]> {
    return [...this.roles.values()].map((role) => structuredClone(role));
  }

  async remove(key: string): Promise<void> {
    this.roles.delete(key);
  }
}

const MAX_NAME = 40;

/** "Front of house " → "front-of-house". Case and spacing are not identity. */
export function roleKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isOwnerRole(name: string | undefined): boolean {
  return roleKey(name ?? "") === roleKey(OWNER_ROLE);
}

/** The virtual Owner, built fresh so no caller can mutate a shared object. */
function ownerRole(): Role {
  return {
    name: OWNER_ROLE,
    permittedSections: [...NAV_SECTIONS],
    createdAt: "",
    updatedAt: "",
    reserved: true,
  };
}

export class RoleService {
  constructor(private readonly repo: RoleRepository) {}

  /** Owner first — it is the one everybody looks for — then the rest by name. */
  async list(): Promise<Role[]> {
    const stored = (await this.repo.list()).filter((role) => !isOwnerRole(role.name));
    stored.sort((left, right) => left.name.localeCompare(right.name));
    return [ownerRole(), ...stored];
  }

  /** The role by name, or an error. Owner always resolves without a lookup. */
  async get(name: string): Promise<Role> {
    if (isOwnerRole(name)) return ownerRole();

    const role = await this.repo.get(roleKey(name));
    if (role === undefined) {
      throw new RoleError(`No role called "${name}".`, "unknown_role", { role: name });
    }
    return role;
  }

  /**
   * The role, or a stand-in with the default sections.
   *
   * Never throws, because this is what the request gate calls: an account whose
   * role record has gone missing — deleted out from under it, or never migrated
   * because the process died halfway — must land on the safe default rather than
   * taking the staff area down for whoever holds it.
   */
  async resolve(name: string | undefined): Promise<Role> {
    if (isOwnerRole(name)) return ownerRole();

    const role = name === undefined ? undefined : await this.repo.get(roleKey(name));
    if (role) return role;

    const now = new Date().toISOString();
    return { name: name ?? "Staff", permittedSections: [...DEFAULT_SECTIONS], createdAt: now, updatedAt: now };
  }

  async sectionsFor(name: string | undefined): Promise<SectionKey[]> {
    return (await this.resolve(name)).permittedSections;
  }

  async create(input: { name?: unknown; permittedSections?: unknown }): Promise<Role> {
    const name = requireName(input.name);
    if (isOwnerRole(name)) {
      throw new RoleError(`"${OWNER_ROLE}" is reserved and always has every section.`, "reserved_role", { name });
    }
    if (await this.repo.get(roleKey(name))) {
      throw new RoleError(`There is already a role called "${name}".`, "duplicate_role", { name });
    }

    const now = new Date().toISOString();
    const role: Role = {
      name,
      permittedSections: requireSections(input.permittedSections),
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.save(roleKey(name), role);
    return role;
  }

  /**
   * Renames a role or changes what it can reach.
   *
   * Refuses Owner outright — that is the whole point of the reservation, and it
   * is refused here as well as at the route so a second caller cannot get round
   * it. A rename is refused too: `StaffAccount.role` holds the name, so renaming
   * would silently unassign everyone who holds it.
   */
  async update(name: string, input: { permittedSections?: unknown }): Promise<Role> {
    if (isOwnerRole(name)) {
      throw new RoleError(
        `"${OWNER_ROLE}" cannot be edited — it always has every section.`,
        "reserved_role",
        { name },
      );
    }

    const role = await this.get(name);
    if (input.permittedSections !== undefined) {
      role.permittedSections = requireSections(input.permittedSections);
    }
    role.updatedAt = new Date().toISOString();
    await this.repo.save(roleKey(role.name), role);
    return role;
  }

  /**
   * Deletes a role nobody holds.
   *
   * `inUseBy` is the list of accounts still on it. Deleting one out from under a
   * staff member would drop them to the default sections without anybody
   * choosing that, so it is refused and the names are handed back for the
   * Owner to reassign first.
   */
  async remove(name: string, inUseBy: string[] = []): Promise<Role> {
    if (isOwnerRole(name)) {
      throw new RoleError(`"${OWNER_ROLE}" cannot be deleted.`, "reserved_role", { name });
    }

    const role = await this.get(name);
    if (inUseBy.length > 0) {
      throw new RoleError(
        `${inUseBy.join(", ")} still ${inUseBy.length === 1 ? "has" : "have"} the "${role.name}" role. ` +
          "Move them to another role first.",
        "role_in_use",
        { role: role.name, inUseBy },
      );
    }

    await this.repo.remove(roleKey(role.name));
    return role;
  }

  /**
   * Turns the free-text role values on existing accounts into real records.
   *
   * Run at boot. Before roles existed `StaffAccount.role` was a string somebody
   * typed — "Cashier", "Kitchen" — and it stays exactly that string, so nobody's
   * account changes; what changes is that there is now a Role behind it with a
   * default section set an Owner can widen. Owner is skipped because it is
   * virtual, and a name that already has a record is left alone, so this is safe
   * to run on every boot.
   *
   * Returns the names it created, so the boot log can say what happened.
   */
  async ensureRolesFor(roleNames: readonly string[]): Promise<string[]> {
    const created: string[] = [];

    for (const name of roleNames) {
      const trimmed = (name ?? "").trim();
      if (trimmed.length === 0 || isOwnerRole(trimmed)) continue;
      if (await this.repo.get(roleKey(trimmed))) continue;

      const now = new Date().toISOString();
      await this.repo.save(roleKey(trimmed), {
        name: trimmed.slice(0, MAX_NAME),
        permittedSections: [...DEFAULT_SECTIONS],
        createdAt: now,
        updatedAt: now,
      });
      created.push(trimmed);
    }

    return created;
  }
}

// -------------------------------------------------------------------- parsing

function requireName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name.length === 0) {
    throw new RoleError("A role needs a name.", "missing_field", { field: "name" });
  }
  if (name.length > MAX_NAME) {
    throw new RoleError(`A role name must be ${MAX_NAME} characters or fewer.`, "field_too_long", { max: MAX_NAME });
  }
  if (roleKey(name).length === 0) {
    throw new RoleError(`"${name}" is not a role name.`, "invalid_role_name", { name });
  }
  return name;
}

/**
 * The sections a role may reach.
 *
 * An empty list is allowed and means exactly what it says: somebody with a
 * record and a password who can sign in and see nothing. That is a real state a
 * shop might want for a suspended account, and refusing it here would only push
 * the Owner into deactivating instead — which is a different thing.
 */
function requireSections(value: unknown): SectionKey[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RoleError("Sections must be a list.", "invalid_sections", { permittedSections: value });
  }

  const seen = new Set<SectionKey>();
  for (const entry of value) {
    const section = String(entry);
    if (!(NAV_SECTIONS as readonly string[]).includes(section)) {
      throw new RoleError(`"${section}" is not a section.`, "invalid_sections", {
        section,
        known: NAV_SECTIONS,
      });
    }
    seen.add(section as SectionKey);
  }

  // Returned in the canonical order rather than the order they arrived, so two
  // roles with the same access compare equal and read the same on the page.
  return NAV_SECTIONS.filter((section) => seen.has(section));
}
