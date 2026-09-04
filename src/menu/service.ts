import { formatDelta, formatSen } from "./money.js";
import type { MenuRepository } from "./repository.js";
import { defaultMenuStore } from "./store.js";
import { MenuValidationError } from "./types.js";
import type {
  Allergen,
  CategoryId,
  DietaryTag,
  ItemTag,
  MenuItem,
  OptionGroup,
} from "./types.js";

/**
 * How hard to read an allergen exclusion.
 *
 * - `strict` (default): also drop items that only *may* contain the allergen
 *   via a shared fryer. This is the right default — someone asking us to keep
 *   an allergen out is usually allergic, and a cross-contact item is not safe
 *   for them.
 * - `contains`: drop only items where the allergen is actually an ingredient.
 *   For preference, not allergy ("I don't like dairy").
 */
export type AllergenMode = "strict" | "contains";

export interface MenuQuery {
  categories?: CategoryId[] | undefined;
  tags?: ItemTag[] | undefined;
  dietary?: DietaryTag[] | undefined;
  excludeAllergens?: Allergen[] | undefined;
  allergenMode?: AllergenMode | undefined;
  /** Ceiling on the item's base price, in sen. Options can still push it over. */
  maxPriceSen?: number | undefined;
  /** Free text over name, description and flavour notes. */
  search?: string | undefined;
  /** Off by default so the agent never offers something the fryer cannot make. */
  includeUnavailable?: boolean | undefined;
}

export interface OptionChoiceView {
  id: string;
  name: string;
  priceDeltaSen: number;
  priceDelta: string;
  isDefault: boolean;
  available: boolean;
  allergens: Allergen[];
}

export interface OptionGroupView {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  required: boolean;
  choices: OptionChoiceView[];
}

export interface MenuItemView {
  id: string;
  categoryId: CategoryId;
  name: string;
  description: string;
  flavourNotes: string;
  priceSen: number;
  /** Pre-formatted so the agent never does ringgit arithmetic in its head. */
  price: string;
  portion: MenuItem["portion"];
  /** "Regular, about 220g, 2 fillets — serves 1" */
  portionSummary: string;
  allergens: Allergen[];
  mayContain: Allergen[];
  dietary: DietaryTag[];
  tags: ItemTag[];
  optionGroups: OptionGroupView[];
  available: boolean;
  unavailableReason?: string;
  /** Served path to the item's photo, when staff have uploaded one. */
  imageUrl?: string;
}

export interface CategoryView {
  id: CategoryId;
  name: string;
  blurb: string;
  items: MenuItemView[];
}

/** An item held back by an allergen filter, so the agent can say why. */
export interface WithheldItem {
  id: string;
  name: string;
  reason: "contains" | "cross_contact";
  allergens: Allergen[];
}

export interface MenuResult {
  version: string;
  shopName: string;
  currency: string;
  categories: CategoryView[];
  itemCount: number;
  filtersApplied: MenuQuery;
  /** Only populated when `excludeAllergens` was used. */
  withheld: WithheldItem[];
}

export interface SuggestionQuery {
  /** Narrow to one section, e.g. only suggest a drink. */
  categories?: CategoryId[] | undefined;
  dietary?: DietaryTag[] | undefined;
  excludeAllergens?: Allergen[] | undefined;
  allergenMode?: AllergenMode | undefined;
  limit?: number | undefined;
}

export interface Suggestion {
  item: MenuItemView;
  /** Why we are pushing this one — the agent says this out loud. */
  reason: string;
}

/** Ranked highest-first; drives the "not sure what to get" suggestion. */
const TAG_WEIGHT: Record<ItemTag, number> = {
  signature: 100,
  popular: 60,
  new: 30,
  value: 20,
  sharing: 5,
  spicy: 0,
};

const TAG_REASON: Partial<Record<ItemTag, string>> = {
  signature: "our signature",
  popular: "one of the most ordered",
  new: "new on the menu",
  value: "the better-value order",
  sharing: "good for sharing",
};

export class MenuService {
  constructor(private readonly repo: MenuRepository = defaultMenuStore) {}

  /** The whole menu, optionally filtered. Empty query returns everything available. */
  getMenu(query: MenuQuery = {}): MenuResult {
    const menu = this.repo.load();
    const withheld: WithheldItem[] = [];

    // Checked against the menu as it stands rather than against a fixed enum:
    // staff add sections from the menu page, so the valid set is only knowable
    // at call time. Still an error rather than an empty result — an agent that
    // asks for "desserts" needs telling we have none, not silence.
    for (const requested of query.categories ?? []) {
      if (!menu.categories.some((category) => category.id === requested)) {
        throw new MenuValidationError(`No menu section "${requested}".`, "unknown_category", {
          category: requested,
          known: menu.categories.map((category) => category.id),
        });
      }
    }

    const kept = menu.items.filter((item) => this.matches(item, query, withheld));

    const categories: CategoryView[] = [...menu.categories]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((category) => ({
        id: category.id,
        name: category.name,
        blurb: category.blurb,
        items: kept.filter((item) => item.categoryId === category.id).map(toItemView),
      }))
      // Drop sections a filter emptied out, so we never announce "Fish" then list nothing.
      .filter((category) => category.items.length > 0);

    return {
      version: menu.version,
      shopName: menu.shopName,
      currency: menu.currency,
      categories,
      itemCount: kept.length,
      filtersApplied: query,
      withheld,
    };
  }

  /** One item in full — for flavour, portion and allergen questions. */
  getItem(itemId: string): MenuItemView | undefined {
    const item = this.repo.load().items.find((candidate) => candidate.id === itemId);
    return item ? toItemView(item) : undefined;
  }

  /**
   * What to recommend to an undecided customer. Signature first, then popular,
   * with at most one item per category so we do not read out three kinds of chips.
   */
  suggest(query: SuggestionQuery = {}): Suggestion[] {
    const limit = query.limit ?? 3;
    const menuQuery: MenuQuery = { tags: ["signature", "popular", "new"] };
    if (query.categories) menuQuery.categories = query.categories;
    if (query.dietary) menuQuery.dietary = query.dietary;
    if (query.excludeAllergens) menuQuery.excludeAllergens = query.excludeAllergens;
    if (query.allergenMode) menuQuery.allergenMode = query.allergenMode;

    const candidates = this.getMenu(menuQuery).categories.flatMap((category) => category.items);

    candidates.sort((a, b) => {
      const byScore = score(b) - score(a);
      return byScore !== 0 ? byScore : a.priceSen - b.priceSen;
    });

    const seenCategories = new Set<CategoryId>();
    const picks: Suggestion[] = [];

    for (const item of candidates) {
      if (picks.length >= limit) break;
      if (seenCategories.has(item.categoryId)) continue;
      seenCategories.add(item.categoryId);
      picks.push({ item, reason: reasonFor(item) });
    }

    // Only after one per category do we allow a second from the same section.
    for (const item of candidates) {
      if (picks.length >= limit) break;
      if (picks.some((pick) => pick.item.id === item.id)) continue;
      picks.push({ item, reason: reasonFor(item) });
    }

    return picks;
  }

  /**
   * Everything an item can expose an allergen through, including its options.
   * Answers "is there dairy in this?" without the agent reading option groups itself.
   */
  allergenReport(itemId: string):
    | {
        item: MenuItemView;
        contains: Allergen[];
        mayContain: Allergen[];
        /** Allergens only present via a non-default option, and how to avoid them. */
        fromOptions: { allergen: Allergen; groupName: string; choiceName: string }[];
      }
    | undefined {
    const item = this.repo.load().items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;

    const fromOptions: { allergen: Allergen; groupName: string; choiceName: string }[] = [];
    for (const group of item.optionGroups) {
      for (const choice of group.choices) {
        for (const allergen of choice.allergens ?? []) {
          if (item.allergens.includes(allergen)) continue;
          fromOptions.push({ allergen, groupName: group.name, choiceName: choice.name });
        }
      }
    }

    return {
      item: toItemView(item),
      contains: item.allergens,
      mayContain: item.mayContain,
      fromOptions,
    };
  }

  private matches(item: MenuItem, query: MenuQuery, withheld: WithheldItem[]): boolean {
    if (!item.available && !query.includeUnavailable) return false;

    if (query.categories?.length && !query.categories.includes(item.categoryId)) return false;

    if (query.tags?.length && !query.tags.some((tag) => item.tags.includes(tag))) return false;

    if (query.dietary?.length && !query.dietary.every((tag) => item.dietary.includes(tag))) return false;

    if (query.maxPriceSen !== undefined && item.priceSen > query.maxPriceSen) return false;

    if (query.search) {
      const needle = query.search.toLowerCase().trim();
      const haystack = `${item.name} ${item.description} ${item.flavourNotes}`.toLowerCase();
      if (needle.length > 0 && !haystack.includes(needle)) return false;
    }

    if (query.excludeAllergens?.length) {
      const mode = query.allergenMode ?? "strict";

      const contains = query.excludeAllergens.filter((allergen) => item.allergens.includes(allergen));
      if (contains.length > 0) {
        withheld.push({ id: item.id, name: item.name, reason: "contains", allergens: contains });
        return false;
      }

      if (mode === "strict") {
        const crossContact = query.excludeAllergens.filter((allergen) => item.mayContain.includes(allergen));
        if (crossContact.length > 0) {
          withheld.push({ id: item.id, name: item.name, reason: "cross_contact", allergens: crossContact });
          return false;
        }
      }
    }

    return true;
  }
}

function score(item: MenuItemView): number {
  return item.tags.reduce((total, tag) => total + TAG_WEIGHT[tag], 0);
}

function reasonFor(item: MenuItemView): string {
  for (const tag of ["signature", "popular", "new", "value", "sharing"] as const) {
    if (item.tags.includes(tag)) {
      const label = TAG_REASON[tag];
      if (label) return label;
    }
  }
  return "worth a try";
}

function portionSummary(item: MenuItem): string {
  const parts: string[] = [item.portion.label];
  if (item.portion.grams !== undefined) parts.push(`about ${item.portion.grams}g`);
  if (item.portion.note) parts.push(item.portion.note);
  const head = parts.join(", ");
  if (item.portion.serves === undefined) return head;
  return `${head} — serves ${item.portion.serves}`;
}

function toOptionGroupView(group: OptionGroup): OptionGroupView {
  return {
    id: group.id,
    name: group.name,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    required: group.minSelections > 0,
    choices: group.choices.map((choice) => ({
      id: choice.id,
      name: choice.name,
      priceDeltaSen: choice.priceDeltaSen,
      priceDelta: formatDelta(choice.priceDeltaSen),
      isDefault: choice.isDefault ?? false,
      available: choice.available,
      allergens: choice.allergens ?? [],
    })),
  };
}

export function toItemView(item: MenuItem): MenuItemView {
  const view: MenuItemView = {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    flavourNotes: item.flavourNotes,
    priceSen: item.priceSen,
    price: formatSen(item.priceSen),
    portion: item.portion,
    portionSummary: portionSummary(item),
    allergens: item.allergens,
    mayContain: item.mayContain,
    dietary: item.dietary,
    tags: item.tags,
    optionGroups: item.optionGroups.map(toOptionGroupView),
    available: item.available,
  };
  if (item.unavailableReason !== undefined) view.unavailableReason = item.unavailableReason;
  if (item.imageUrl !== undefined) view.imageUrl = item.imageUrl;
  return view;
}

export const menuService = new MenuService();
