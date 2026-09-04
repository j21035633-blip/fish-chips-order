import { randomUUID } from "node:crypto";

import { MENU } from "./data/menu.js";
import type { MenuRepository } from "./repository.js";
import {
  MenuValidationError,
  toCategoryId,
  type Category,
  type Menu,
  type MenuItem,
} from "./types.js";

/**
 * The menu, editable by staff.
 *
 * Reads stay *synchronous*. `MenuService.getMenu`, `priceCart` and every cart
 * mutation go through `load()`, and making that async would turn the whole
 * pricing path into promises for no gain — so the store keeps the menu in memory
 * and writes through to the database behind it. The snapshot is the read model;
 * the database is the record.
 *
 * The whole menu is one document. At this size (tens of items) a per-item
 * collection buys nothing and costs the guarantee that `items`, `categories` and
 * `version` are always consistent with each other.
 */

export interface MenuPersistence {
  load(): Promise<Menu | undefined>;
  save(menu: Menu): Promise<void>;
}

/** What the staff form sends. Everything a seeded item has, but optional. */
export interface MenuItemInput {
  name?: string | undefined;
  description?: string | undefined;
  priceSen?: number | undefined;
  /** The category *name* as typed. Slugged to an id, creating the section if new. */
  category?: string | undefined;
  available?: boolean | undefined;
  unavailableReason?: string | undefined;
  flavourNotes?: string | undefined;
  /** As served, e.g. `/uploads/menu-items/<file>`. */
  imageUrl?: string | undefined;
  /** True to drop the current image without uploading a replacement. */
  removeImage?: boolean | undefined;
}

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_CATEGORY = 40;
/** RM10,000. Not a real price — a guard against a stray keystroke in the form. */
const MAX_PRICE_SEN = 1_000_000;

export class MenuStore implements MenuRepository {
  private menu: Menu;

  constructor(
    private readonly persistence?: MenuPersistence,
    seed: Menu = MENU,
  ) {
    this.menu = structuredClone(seed);
  }

  /** The live snapshot. Callers must not mutate it; every write goes through this class. */
  load(): Menu {
    return this.menu;
  }

  /**
   * Adopts what the database holds, seeding it on first boot.
   *
   * Safe to call more than once and safe to skip: with no persistence, or with a
   * database that has not answered, the store keeps serving the seed menu — the
   * customer can still order, the edits just do not survive a restart.
   */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;

    const stored = await this.persistence.load();
    if (stored) {
      this.menu = stored;
      return;
    }
    await this.persistence.save(this.menu);
  }

  /** Every item, sold-out ones included — what the staff menu page lists. */
  items(): MenuItem[] {
    return this.menu.items;
  }

  /** The sections, in the order they are presented. */
  categories(): Category[] {
    return [...this.menu.categories].sort((left, right) => left.sortOrder - right.sortOrder);
  }

  item(itemId: string): MenuItem {
    const found = this.menu.items.find((candidate) => candidate.id === itemId);
    if (!found) {
      throw new MenuValidationError(`No menu item "${itemId}".`, "unknown_menu_item", { itemId });
    }
    return found;
  }

  async create(input: MenuItemInput): Promise<MenuItem> {
    const name = requireText(input.name, "name", MAX_NAME);
    const priceSen = requirePrice(input.priceSen);
    const categoryId = this.resolveCategory(requireText(input.category, "category", MAX_CATEGORY));

    const item: MenuItem = {
      // A uuid rather than a slug of the name: two "Cod & Chips" would collide,
      // and an id that changes when the name is corrected breaks past orders.
      id: randomUUID(),
      categoryId,
      name,
      description: optionalText(input.description, "description", MAX_DESCRIPTION) ?? "",
      flavourNotes: optionalText(input.flavourNotes, "flavourNotes", MAX_DESCRIPTION) ?? "",
      priceSen,
      // Staff-added items carry no portion, allergen or option data — there is
      // no form for it. Empty is honest; a guess would be worse than nothing,
      // because the agent answers allergen questions straight off these.
      portion: { label: "Regular" },
      allergens: [],
      mayContain: [],
      dietary: [],
      tags: [],
      optionGroups: [],
      available: input.available ?? true,
    };
    if (input.imageUrl !== undefined) item.imageUrl = input.imageUrl;
    if (input.unavailableReason) item.unavailableReason = input.unavailableReason;

    this.menu.items.push(item);
    await this.commit();
    return item;
  }

  /** Patches whatever was sent and leaves the rest alone. */
  async update(itemId: string, input: MenuItemInput): Promise<MenuItem> {
    const item = this.item(itemId);

    if (input.name !== undefined) item.name = requireText(input.name, "name", MAX_NAME);
    if (input.priceSen !== undefined) item.priceSen = requirePrice(input.priceSen);
    if (input.category !== undefined) {
      item.categoryId = this.resolveCategory(requireText(input.category, "category", MAX_CATEGORY));
    }
    if (input.description !== undefined) {
      item.description = optionalText(input.description, "description", MAX_DESCRIPTION) ?? "";
    }
    if (input.flavourNotes !== undefined) {
      item.flavourNotes = optionalText(input.flavourNotes, "flavourNotes", MAX_DESCRIPTION) ?? "";
    }
    if (input.available !== undefined) item.available = input.available;
    if (input.unavailableReason !== undefined) {
      if (input.unavailableReason) item.unavailableReason = input.unavailableReason;
      else delete item.unavailableReason;
    }
    // A new upload wins; `removeImage` only applies when there is nothing to
    // replace it with, so an accidental both does not leave the item pictureless.
    if (input.imageUrl !== undefined) item.imageUrl = input.imageUrl;
    else if (input.removeImage) delete item.imageUrl;

    this.pruneCategories();
    await this.commit();
    return item;
  }

  /**
   * The one-tap toggle on the staff menu page. Deliberately narrow: it cannot
   * touch a price or a name, so a mis-tap on a busy service is not a data loss.
   */
  async setAvailability(itemId: string, available: boolean): Promise<MenuItem> {
    const item = this.item(itemId);
    item.available = available;
    // The reason belonged to the old state; keeping it would caption an
    // available item with "sold out".
    if (available) delete item.unavailableReason;
    await this.commit();
    return item;
  }

  /** Returns the removed item, so the caller can delete its image file. */
  async remove(itemId: string): Promise<MenuItem> {
    const item = this.item(itemId);
    this.menu.items = this.menu.items.filter((candidate) => candidate.id !== itemId);
    this.pruneCategories();
    await this.commit();
    return item;
  }

  /**
   * Finds the section for a typed category name, adding it if it is new.
   *
   * Matched on the slug, so "Sides" and "sides " are one section rather than
   * two, and the name staff typed first is the one that shows.
   */
  private resolveCategory(name: string): string {
    const id = toCategoryId(name);
    if (id.length === 0) {
      throw new MenuValidationError(`"${name}" is not a category name.`, "invalid_category", { category: name });
    }

    const existing = this.menu.categories.find((category) => category.id === id);
    if (existing) return existing.id;

    const sortOrder = Math.max(0, ...this.menu.categories.map((category) => category.sortOrder)) + 1;
    this.menu.categories.push({ id, name: name.trim(), blurb: "", sortOrder });
    return id;
  }

  /** Drops sections nothing points at any more, except the ones the shop opened with. */
  private pruneCategories(): void {
    const inUse = new Set(this.menu.items.map((item) => item.categoryId));
    this.menu.categories = this.menu.categories.filter(
      (category) => inUse.has(category.id) || (CATEGORY_SEED as readonly string[]).includes(category.id),
    );
  }

  /**
   * Bumps the version and writes through.
   *
   * The version is what a later phase caches on, so it has to change on every
   * edit. A failed write leaves the snapshot ahead of the database — the edit is
   * live but not durable, and it throws so the form says so rather than
   * pretending it saved.
   */
  private async commit(): Promise<void> {
    this.menu.version = `${new Date().toISOString().slice(0, 10)}.${Date.now() % 100000}`;
    await this.persistence?.save(this.menu);
  }
}

/** The four the shop opened with; they stay listed even when emptied. */
const CATEGORY_SEED = ["fish", "chips", "combos", "drinks"] as const;

function requireText(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw new MenuValidationError(`${field} is required.`, "missing_field", { field });
  }
  if (trimmed.length > max) {
    throw new MenuValidationError(`${field} must be ${max} characters or fewer.`, "field_too_long", { field, max });
  }
  return trimmed;
}

function optionalText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new MenuValidationError(`${field} must be ${max} characters or fewer.`, "field_too_long", { field, max });
  }
  return trimmed;
}

/** Sen, so an integer. A price in ringgit would round, and money never rounds here. */
function requirePrice(priceSen: number | undefined): number {
  if (priceSen === undefined) {
    throw new MenuValidationError("price is required.", "missing_field", { field: "price" });
  }
  if (!Number.isInteger(priceSen) || priceSen < 0 || priceSen > MAX_PRICE_SEN) {
    throw new MenuValidationError(
      `price must be a whole number of sen between 0 and ${MAX_PRICE_SEN}.`,
      "invalid_price",
      { priceSen },
    );
  }
  return priceSen;
}

/** The process-wide store, used by the module-level `menuService` and the CLI. */
export const defaultMenuStore = new MenuStore();
