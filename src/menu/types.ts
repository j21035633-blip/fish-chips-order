/**
 * Menu domain types (Phase 1).
 *
 * Money is always an integer count of sen (1 MYR = 100 sen). Never floats —
 * cart totals and the RM30+ bonus-chance threshold in later phases both depend
 * on exact arithmetic.
 */

export const CURRENCY = "MYR" as const;

/**
 * The categories the shop opened with. Staff can add their own from the menu
 * page, so this is the seed set rather than the closed set it used to be — which
 * is why `CategoryId` is a plain string. Ids stay stable once created: an item
 * points at one, and the agent groups its menu rundown by them.
 */
export const CATEGORY_IDS = ["fish", "chips", "combos", "drinks"] as const;
export type CategoryId = string;

/** Turns a category name typed by staff into a stable id. "Sides & Dips" -> "sides-dips". */
export function toCategoryId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Allergens we declare per item. Keep this list closed — the agent answers
 * allergen questions straight off it, so an unlisted allergen reads as "absent"
 * to a customer.
 */
export const ALLERGENS = [
  "fish",
  "crustacean",
  "mollusc",
  "gluten",
  "egg",
  "milk",
  "soy",
  "peanut",
  "tree_nut",
  "sesame",
  "sulphite",
  "mustard",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const DIETARY_TAGS = ["vegetarian", "vegan", "no_pork", "no_alcohol"] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

/** Merchandising tags. `signature` and `popular` drive the "not sure what to get" suggestion. */
export const ITEM_TAGS = ["signature", "popular", "new", "spicy", "value", "sharing"] as const;
export type ItemTag = (typeof ITEM_TAGS)[number];

export interface Portion {
  /** Customer-facing size name, e.g. "Regular", "Large". */
  label: string;
  /** Cooked weight where it is meaningful. Used to answer "how big is it?". */
  grams?: number;
  /** Rough head count. Used for "enough for two?". */
  serves?: number;
  /** Anything the label and grams do not convey, e.g. "2 fillets". */
  note?: string;
}

export interface OptionChoice {
  id: string;
  name: string;
  /** Added to the item price. May be 0 or negative. */
  priceDeltaSen: number;
  isDefault?: boolean;
  available: boolean;
  /** Allergens this choice adds on top of the item's own. */
  allergens?: Allergen[];
}

export interface OptionGroup {
  id: string;
  name: string;
  /** Fewest choices the customer must pick. 0 means the whole group is optional. */
  minSelections: number;
  /** Most choices allowed. 1 = pick-one, >1 = multi-select (e.g. sauces). */
  maxSelections: number;
  choices: OptionChoice[];
}

export interface MenuItem {
  id: string;
  categoryId: CategoryId;
  name: string;
  /** One line for the menu list. */
  description: string;
  /** How it actually tastes — the agent quotes this when asked about flavour. */
  flavourNotes: string;
  priceSen: number;
  portion: Portion;
  /** Allergens definitely present. */
  allergens: Allergen[];
  /** Shared-fryer / cross-contact risks. Declared separately so we never overstate. */
  mayContain: Allergen[];
  dietary: DietaryTag[];
  tags: ItemTag[];
  optionGroups: OptionGroup[];
  /**
   * False when 86'd for the day. Still listed to customers, shown as
   * unavailable, so nobody is left wondering whether it exists — the agent's
   * `get_menu` is the one caller that hides them by default.
   */
  available: boolean;
  /** Why it is off, e.g. "sold out today" — the agent repeats this verbatim. */
  unavailableReason?: string;
  /**
   * Path to the item's photo, as served: `/uploads/menu-items/<file>`. Absent
   * when nobody has uploaded one, which is the state every seeded item is in.
   */
  imageUrl?: string;
}

export interface Category {
  id: CategoryId;
  name: string;
  /** One line the agent can use when introducing the section. */
  blurb: string;
  /** Ascending order the categories are presented in. */
  sortOrder: number;
}

/**
 * Thrown for anything a member of staff could fix by filling the form in
 * differently. Mirrors `OrderValidationError` — same shape, same HTTP mapping.
 */
export class MenuValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "MenuValidationError";
  }
}

export interface Menu {
  /** Bumped whenever the seed data changes; lets later phases cache safely. */
  version: string;
  shopName: string;
  currency: typeof CURRENCY;
  categories: Category[];
  items: MenuItem[];
}
