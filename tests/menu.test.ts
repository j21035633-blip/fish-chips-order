import { describe, expect, it } from "vitest";

import { MENU } from "../src/menu/data/menu.js";
import { formatDelta, formatSen } from "../src/menu/money.js";
import { renderItem, renderMenu } from "../src/menu/render.js";
import { MenuService } from "../src/menu/service.js";
import { ALLERGENS, CATEGORY_IDS } from "../src/menu/types.js";
import { menuTools } from "../src/tools/menuTools.js";

const service = new MenuService();

describe("seed menu data", () => {
  it("has unique item ids", () => {
    const ids = MENU.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts every item in a declared category", () => {
    for (const item of MENU.items) {
      expect(CATEGORY_IDS).toContain(item.categoryId);
      expect(MENU.categories.some((category) => category.id === item.categoryId)).toBe(true);
    }
  });

  it("prices everything in whole sen", () => {
    for (const item of MENU.items) {
      expect(Number.isInteger(item.priceSen)).toBe(true);
      expect(item.priceSen).toBeGreaterThan(0);
    }
  });

  it("only declares known allergens, and never in both contains and mayContain", () => {
    for (const item of MENU.items) {
      for (const allergen of [...item.allergens, ...item.mayContain]) {
        expect(ALLERGENS).toContain(allergen);
      }
      const overlap = item.allergens.filter((allergen) => item.mayContain.includes(allergen));
      expect(overlap, `${item.id} lists ${overlap.join(",")} twice`).toEqual([]);
    }
  });

  it("gives every required option group a default choice", () => {
    for (const item of MENU.items) {
      for (const group of item.optionGroups) {
        if (group.minSelections === 0) continue;
        const defaults = group.choices.filter((choice) => choice.isDefault);
        expect(defaults.length, `${item.id}/${group.id} needs exactly one default`).toBe(1);
      }
    }
  });

  it("keeps option group bounds sane", () => {
    for (const item of MENU.items) {
      for (const group of item.optionGroups) {
        expect(group.maxSelections).toBeGreaterThanOrEqual(group.minSelections);
        expect(group.choices.length).toBeGreaterThanOrEqual(group.maxSelections);
      }
    }
  });

  it("gives every unavailable item a reason", () => {
    for (const item of MENU.items.filter((candidate) => !candidate.available)) {
      expect(item.unavailableReason, `${item.id} is off without a reason`).toBeTruthy();
    }
  });

  it("has at least one signature item to suggest", () => {
    expect(MENU.items.some((item) => item.tags.includes("signature"))).toBe(true);
  });
});

describe("money", () => {
  it("formats sen as ringgit", () => {
    expect(formatSen(1690)).toBe("RM16.90");
    expect(formatSen(250)).toBe("RM2.50");
    expect(formatSen(0)).toBe("RM0.00");
    expect(formatSen(5)).toBe("RM0.05");
    expect(formatSen(-100)).toBe("-RM1.00");
  });

  it("refuses fractional sen rather than rounding silently", () => {
    expect(() => formatSen(16.905)).toThrow(TypeError);
  });

  it("formats option deltas", () => {
    expect(formatDelta(0)).toBe("free");
    expect(formatDelta(200)).toBe("+RM2.00");
    expect(formatDelta(-100)).toBe("-RM1.00");
  });
});

describe("getMenu", () => {
  it("hides sold-out items by default and shows them on request", () => {
    const soldOut = MENU.items.find((item) => !item.available);
    expect(soldOut, "seed data should include a sold-out item").toBeDefined();

    const ids = (result: ReturnType<MenuService["getMenu"]>) =>
      result.categories.flatMap((category) => category.items.map((item) => item.id));

    expect(ids(service.getMenu())).not.toContain(soldOut!.id);
    expect(ids(service.getMenu({ includeUnavailable: true }))).toContain(soldOut!.id);
  });

  it("filters by category", () => {
    const result = service.getMenu({ categories: ["drinks"] });
    expect(result.categories.map((category) => category.id)).toEqual(["drinks"]);
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it("returns categories in sort order", () => {
    const order = service.getMenu().categories.map((category) => category.id);
    expect(order).toEqual(["fish", "chips", "combos", "drinks"]);
  });

  it("drops sections a filter emptied", () => {
    const result = service.getMenu({ dietary: ["vegan"] });
    expect(result.categories.every((category) => category.items.length > 0)).toBe(true);
    expect(result.categories.map((category) => category.id)).not.toContain("fish");
  });

  it("requires every requested dietary tag, not just one", () => {
    const result = service.getMenu({ dietary: ["vegan", "vegetarian"] });
    for (const item of result.categories.flatMap((category) => category.items)) {
      expect(item.dietary).toContain("vegan");
      expect(item.dietary).toContain("vegetarian");
    }
  });

  it("matches at least one of the requested tags", () => {
    const result = service.getMenu({ tags: ["signature"] });
    for (const item of result.categories.flatMap((category) => category.items)) {
      expect(item.tags).toContain("signature");
    }
  });

  it("caps by base price", () => {
    const result = service.getMenu({ maxPriceSen: 800 });
    for (const item of result.categories.flatMap((category) => category.items)) {
      expect(item.priceSen).toBeLessThanOrEqual(800);
    }
  });

  it("searches name, description and flavour notes", () => {
    const byName = service.getMenu({ search: "cod" });
    expect(byName.categories.flatMap((c) => c.items).map((item) => item.id)).toContain("fish-cod-premium");

    const byFlavour = service.getMenu({ search: "buttery" });
    expect(byFlavour.itemCount).toBeGreaterThan(0);
  });

  it("formats prices so the agent never does arithmetic", () => {
    const dory = service.getItem("fish-dory-classic");
    expect(dory?.price).toBe("RM16.90");
  });
});

describe("allergen filtering", () => {
  it("strict mode drops cross-contact items and says why", () => {
    const result = service.getMenu({ excludeAllergens: ["gluten"] });
    const ids = result.categories.flatMap((category) => category.items.map((item) => item.id));

    // Plain chips have no gluten ingredient but share the fryer with battered fish.
    expect(ids).not.toContain("chips-classic");

    const withheld = result.withheld.find((entry) => entry.id === "chips-classic");
    expect(withheld?.reason).toBe("cross_contact");
    expect(withheld?.allergens).toContain("gluten");
  });

  it("contains mode keeps cross-contact items", () => {
    const result = service.getMenu({ excludeAllergens: ["gluten"], allergenMode: "contains" });
    const ids = result.categories.flatMap((category) => category.items.map((item) => item.id));

    expect(ids).toContain("chips-classic");
    expect(ids).not.toContain("fish-dory-classic");
  });

  it("never returns an item carrying an excluded allergen, in either mode", () => {
    for (const mode of ["strict", "contains"] as const) {
      const result = service.getMenu({ excludeAllergens: ["milk", "egg"], allergenMode: mode });
      for (const item of result.categories.flatMap((category) => category.items)) {
        expect(item.allergens).not.toContain("milk");
        expect(item.allergens).not.toContain("egg");
      }
    }
  });

  it("reports allergens that only arrive through an option", () => {
    const report = service.allergenReport("chips-classic");
    expect(report).toBeDefined();
    expect(report!.contains).toEqual([]);

    const saltedEgg = report!.fromOptions.find((entry) => entry.choiceName === "Salted egg dust");
    expect(saltedEgg?.allergen === "egg" || saltedEgg?.allergen === "milk").toBe(true);
  });

  it("leaves withheld empty when no allergen filter was used", () => {
    expect(service.getMenu().withheld).toEqual([]);
  });
});

describe("suggest", () => {
  it("leads with a signature item", () => {
    const [first] = service.suggest();
    expect(first).toBeDefined();
    expect(first!.item.tags).toContain("signature");
    expect(first!.reason).toBe("our signature");
  });

  it("spreads across categories before repeating one", () => {
    const suggestions = service.suggest({ limit: 3 });
    const categories = suggestions.map((suggestion) => suggestion.item.categoryId);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("honours the limit", () => {
    expect(service.suggest({ limit: 1 })).toHaveLength(1);
    expect(service.suggest({ limit: 5 }).length).toBeLessThanOrEqual(5);
  });

  it("respects allergen exclusions", () => {
    for (const suggestion of service.suggest({ excludeAllergens: ["fish"] })) {
      expect(suggestion.item.allergens).not.toContain("fish");
      expect(suggestion.item.mayContain).not.toContain("fish");
    }
  });

  it("can be scoped to one category", () => {
    for (const suggestion of service.suggest({ categories: ["drinks"] })) {
      expect(suggestion.item.categoryId).toBe("drinks");
    }
  });
});

describe("rendering", () => {
  it("renders one line per item with a price", () => {
    const text = renderMenu(service.getMenu({ categories: ["drinks"] }), { withDescriptions: false });
    expect(text).toContain("Drinks");
    expect(text).toContain("Teh Ais — RM4.90");
  });

  it("flags signature and spicy items", () => {
    const text = renderMenu(service.getMenu({ categories: ["chips"] }), { withDescriptions: false });
    expect(text).toContain("Salted Egg Chips — RM13.90 [signature, new, spicy]");
  });

  it("says so plainly when nothing matches", () => {
    expect(renderMenu(service.getMenu({ search: "durian sundae" }))).toBe(
      "Nothing on the menu matches that right now.",
    );
  });

  it("renders an item with flavour, portion, allergens and options", () => {
    const text = renderItem(service.getItem("fish-dory-classic")!);
    expect(text).toContain("Classic Battered Dory — RM16.90");
    expect(text).toContain("Portion: Regular, about 220g, 2 fillets — serves 1");
    expect(text).toContain("Contains: fish, gluten, egg, dairy");
    expect(text).toContain("Shared fryer, so may contain: prawn/crab, squid/shellfish");
    expect(text).toContain("Extra dips (optional):");
  });

  it("hides unavailable option choices from the rendered line", () => {
    const text = renderItem(service.getItem("chips-classic")!);
    expect(text).toContain("Size: Regular, Large +RM4.00");
  });
});

describe("tools", () => {
  it("get_menu accepts an empty call and returns spoken text", () => {
    const result = menuTools.get_menu();
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("get_menu rejects an unknown allergen instead of ignoring it", () => {
    expect(() => menuTools.get_menu({ excludeAllergens: ["shellfishh"] })).toThrow();
  });

  it("get_menu rejects an unknown category", () => {
    expect(() => menuTools.get_menu({ categories: ["desserts"] })).toThrow();
  });

  it("get_menu_item reports a miss rather than throwing", () => {
    const result = menuTools.get_menu_item({ itemId: "nope" });
    expect(result.found).toBe(false);
    expect(result.text).toContain("No menu item");
  });

  it("get_menu_item returns the allergen breakdown", () => {
    const result = menuTools.get_menu_item({ itemId: "fish-dory-classic" });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.allergens.contains).toContain("fish");
    expect(result.allergens.mayContain).toContain("crustacean");
  });

  it("suggest_items caps the limit at 5", () => {
    expect(() => menuTools.suggest_items({ limit: 9 })).toThrow();
  });
});
