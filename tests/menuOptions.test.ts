import { beforeEach, describe, expect, it } from "vitest";

import { MENU } from "../src/menu/data/menu.js";
import { migrateOptionGroups, normalizeOptionGroups } from "../src/menu/optionGroups.js";
import { MenuService, toItemView } from "../src/menu/service.js";
import { MenuStore, type MenuPersistence } from "../src/menu/store.js";
import { MenuValidationError, type Menu, type OptionGroup } from "../src/menu/types.js";
import { InMemoryCartRepository } from "../src/orders/repository.js";
import { CartService } from "../src/orders/service.js";
import { OrderValidationError } from "../src/orders/types.js";

/**
 * The staff option-group builder, from the store down.
 *
 * The thing under most scrutiny here is not the builder but everything that was
 * already working before it existed: the dory's Seasoning and Extra dips came
 * from a seed file written against a different shape, and a customer has to be
 * offered exactly the same choices at exactly the same prices afterwards.
 */

const DORY = "fish-dory-classic";
/** The combo is the one item on the menu with an option that takes money off. */
const COMBO = "combo-classic";

let store: MenuStore;
let menu: MenuService;

beforeEach(() => {
  store = new MenuStore();
  menu = new MenuService(store);
});

/** The dory's groups as the builder would post them back, untouched. */
function roundTrip(itemId: string): unknown {
  return toItemView(store.item(itemId)).optionGroups.map((group) => ({
    id: group.id,
    name: group.name,
    selectionType: group.selectionType,
    required: group.required,
    ...(group.maxSelect === undefined ? {} : { maxSelect: group.maxSelect }),
    choices: group.choices.map((choice) => ({
      id: choice.id,
      name: choice.name,
      priceDeltaSen: choice.priceDeltaSen,
      isDefault: choice.isDefault,
      available: choice.available,
      allergens: choice.allergens,
    })),
  }));
}

describe("what the seed menu already offered", () => {
  it("carries the dory's two groups in the new shape", () => {
    const groups = store.item(DORY).optionGroups;

    expect(groups.map((group) => group.name)).toEqual(["Seasoning", "Extra dips"]);

    const [seasoning, dips] = groups as [OptionGroup, OptionGroup];
    expect(seasoning.selectionType).toBe("single");
    expect(seasoning.required).toBe(true);
    expect(seasoning.maxSelect).toBeUndefined();

    expect(dips.selectionType).toBe("multi");
    expect(dips.required).toBe(false);
    expect(dips.maxSelect).toBe(3);
  });

  it("still hands the customer app the min/max pair it renders on", () => {
    // The item modal reads `maxSelections === 1` to decide radio versus
    // checkbox, and prints "pick up to 3" off the same number. Derived now
    // rather than stored, so this is what says the derivation is right.
    const [seasoning, dips] = menu.getItem(DORY)!.optionGroups;

    expect(seasoning).toMatchObject({ minSelections: 1, maxSelections: 1, required: true });
    expect(dips).toMatchObject({ minSelections: 0, maxSelections: 3, required: false });
  });

  it("keeps every price, default and allergen on the choices", () => {
    const dips = menu.getItem(DORY)!.optionGroups[1]!;
    expect(dips.choices.map((choice) => [choice.name, choice.priceDelta])).toEqual([
      ["Tartar sauce", "+RM1.50"],
      ["Curry sauce", "+RM1.50"],
      ["Chilli sauce", "+RM1.50"],
      ["Gravy", "+RM1.50"],
      ["Garlic aioli", "+RM1.50"],
    ]);

    const seasoning = menu.getItem(DORY)!.optionGroups[0]!;
    expect(seasoning.choices.find((choice) => choice.isDefault)?.name).toBe("Sea salt");
    expect(seasoning.choices.find((choice) => choice.id === "salted_egg")?.allergens).toEqual(["egg", "milk"]);
  });
});

describe("migrating a menu stored in the old shape", () => {
  /** The dory exactly as it was written before the builder existed. */
  function legacyMenu(): Menu {
    const stored = structuredClone(MENU) as Menu & { items: Record<string, any>[] };
    for (const item of stored.items) {
      // Cast: this is deliberately the shape the current types no longer describe.
      item.optionGroups = item.optionGroups.map((group: OptionGroup) => ({
        id: group.id,
        name: group.name,
        minSelections: group.required ? 1 : 0,
        maxSelections: group.selectionType === "single" ? 1 : (group.maxSelect ?? group.choices.length),
        choices: group.choices,
      })) as unknown as OptionGroup[];
    }
    return stored as Menu;
  }

  it("rewrites the pair into selectionType, required and maxSelect", () => {
    const stored = legacyMenu();
    expect(migrateOptionGroups(stored)).toBe(true);

    const dory = stored.items.find((item) => item.id === DORY)!;
    expect(dory.optionGroups[0]).toMatchObject({ id: "seasoning", selectionType: "single", required: true });
    expect(dory.optionGroups[0]!.maxSelect).toBeUndefined();
    expect(dory.optionGroups[1]).toMatchObject({ id: "dips", selectionType: "multi", required: false, maxSelect: 3 });
    // Nothing about the choices themselves is the migration's business.
    expect(dory.optionGroups[1]!.choices).toEqual(MENU.items.find((item) => item.id === DORY)!.optionGroups[1]!.choices);
  });

  it("leaves the customer's view of every item byte-for-byte identical", () => {
    // The whole promise of the migration in one assertion: what an already-open
    // customer page would fetch before and after is the same JSON.
    const migrated = legacyMenu();
    migrateOptionGroups(migrated);

    const before = new MenuService(new MenuStore(undefined, MENU)).getMenu({ includeUnavailable: true });
    const after = new MenuService(new MenuStore(undefined, migrated)).getMenu({ includeUnavailable: true });

    expect(JSON.stringify(after.categories)).toBe(JSON.stringify(before.categories));
  });

  it("reports nothing to do on a menu that is already current", () => {
    expect(migrateOptionGroups(structuredClone(MENU) as Menu)).toBe(false);
  });

  it("runs on hydrate, and writes the migrated menu back exactly once", async () => {
    const saved: Menu[] = [];
    const legacy = legacyMenu();
    const persistence: MenuPersistence = {
      async load() {
        return structuredClone(legacy);
      },
      async save(next) {
        saved.push(structuredClone(next));
      },
    };

    const first = new MenuStore(persistence);
    await first.hydrate();
    expect(saved).toHaveLength(1);
    expect(first.item(DORY).optionGroups[1]).toMatchObject({ selectionType: "multi", maxSelect: 3 });

    // Second boot against what the first one wrote: nothing left to migrate,
    // so nothing is written.
    const persisted = saved[0]!;
    const second = new MenuStore({
      async load() {
        return structuredClone(persisted);
      },
      async save(next) {
        saved.push(structuredClone(next));
      },
    });
    await second.hydrate();
    expect(saved).toHaveLength(1);
  });
});

describe("building and editing groups", () => {
  it("creates a group with its choices, and gives everything an id", async () => {
    const item = await store.update(DORY, {
      optionGroups: [
        {
          name: "Bread roll",
          selectionType: "single",
          required: true,
          choices: [{ name: "No roll" }, { name: "Buttered roll", priceDeltaSen: 250 }],
        },
      ],
    });

    expect(item.optionGroups).toHaveLength(1);
    expect(item.optionGroups[0]).toMatchObject({ id: "bread-roll", selectionType: "single", required: true });
    expect(item.optionGroups[0]!.choices.map((choice) => [choice.id, choice.name, choice.priceDeltaSen])).toEqual([
      ["no-roll", "No roll", 0],
      ["buttered-roll", "Buttered roll", 250],
    ]);
    // A required pick-one has to answer itself when the customer says nothing.
    expect(item.optionGroups[0]!.choices[0]!.isDefault).toBe(true);
  });

  it("replaces on save, so a group left out is a group deleted", async () => {
    const before = store.item(DORY).optionGroups.map((group) => group.id);
    expect(before).toEqual(["seasoning", "dips"]);

    const kept = roundTrip(DORY) as unknown[];
    const item = await store.update(DORY, { optionGroups: [kept[0]] });

    expect(item.optionGroups.map((group) => group.id)).toEqual(["seasoning"]);
  });

  it("removes one choice out of a group and leaves the rest alone", async () => {
    const groups = roundTrip(DORY) as any[];
    groups[1].choices = groups[1].choices.filter((choice: any) => choice.id !== "gravy");

    const item = await store.update(DORY, { optionGroups: groups });
    expect(item.optionGroups[1]!.choices.map((choice) => choice.id)).toEqual([
      "tartar",
      "curry_sauce",
      "chilli",
      "garlic_aioli",
    ]);
  });

  it("keeps the order the builder sent, which is the order the customer sees", async () => {
    const groups = (roundTrip(DORY) as any[]).slice().reverse();
    const item = await store.update(DORY, { optionGroups: groups });

    expect(item.optionGroups.map((group) => group.id)).toEqual(["dips", "seasoning"]);
    expect(menu.getItem(DORY)!.optionGroups.map((group) => group.name)).toEqual(["Extra dips", "Seasoning"]);
  });

  it("edits a group's name, type and maximum without disturbing its choices", async () => {
    const groups = roundTrip(DORY) as any[];
    groups[1].name = "Sauces";
    groups[1].maxSelect = 2;

    const item = await store.update(DORY, { optionGroups: groups });
    expect(item.optionGroups[1]!.name).toBe("Sauces");
    expect(item.optionGroups[1]!.maxSelect).toBe(2);
    expect(item.optionGroups[1]!.choices).toHaveLength(5);
    // The id is what a cart in someone's hand points at, so a rename must not
    // move it.
    expect(item.optionGroups[1]!.id).toBe("dips");
  });

  it("survives a full round trip through the builder untouched", async () => {
    const before = roundTrip(DORY);
    await store.update(DORY, { optionGroups: before });
    expect(roundTrip(DORY)).toEqual(before);
  });

  it("keeps allergens and defaults that the form has no control over", async () => {
    // The builder posts a rename and nothing else; the egg warning on salted egg
    // dust has to still be there afterwards, because the agent answers allergen
    // questions off it.
    const item = await store.update(DORY, {
      optionGroups: [
        {
          id: "seasoning",
          name: "Seasoning",
          selectionType: "single",
          required: true,
          choices: [
            { id: "sea_salt", name: "Sea salt", priceDeltaSen: 0 },
            { id: "salted_egg", name: "Salted egg", priceDeltaSen: 200 },
          ],
        },
      ],
    });

    const saltedEgg = item.optionGroups[0]!.choices[1]!;
    expect(saltedEgg.name).toBe("Salted egg");
    expect(saltedEgg.allergens).toEqual(["egg", "milk"]);
    expect(item.optionGroups[0]!.choices[0]!.isDefault).toBe(true);
  });

  it("accepts groups on a brand new item", async () => {
    const item = await store.create({
      name: "Mushy Peas",
      priceSen: 450,
      category: "Sides",
      optionGroups: [
        { name: "Portion", selectionType: "single", required: true, choices: [{ name: "Small" }, { name: "Large", priceDeltaSen: 200 }] },
      ],
    });

    expect(item.optionGroups[0]!.choices.map((choice) => choice.name)).toEqual(["Small", "Large"]);
  });

  it("leaves the groups alone when the field is not sent at all", async () => {
    await store.update(DORY, { name: "Classic Battered Dory" });
    expect(store.item(DORY).optionGroups.map((group) => group.id)).toEqual(["seasoning", "dips"]);
  });
});

describe("what the builder refuses to save", () => {
  const save = (groups: unknown) => store.update(DORY, { optionGroups: groups });
  const group = (over: Record<string, unknown> = {}) => ({
    name: "Seasoning",
    selectionType: "single",
    required: false,
    choices: [{ name: "Sea salt" }],
    ...over,
  });

  it("rejects a group with no name", async () => {
    await expect(save([group({ name: "   " })])).rejects.toThrow(MenuValidationError);
  });

  it("rejects a choice with no name", async () => {
    await expect(save([group({ choices: [{ name: "" }] })])).rejects.toThrow(/needs a name/);
  });

  it("rejects two choices with the same name in one group", async () => {
    await expect(save([group({ choices: [{ name: "Gravy" }, { name: "gravy" }] })])).rejects.toThrow(/twice/);
  });

  it("allows the same choice name in two different groups", async () => {
    const item = await save([
      group({ name: "Seasoning", choices: [{ name: "None" }] }),
      group({ name: "Dips", choices: [{ name: "None" }] }),
    ]);
    expect(item.optionGroups.map((entry) => entry.choices[0]!.name)).toEqual(["None", "None"]);
  });

  it("rejects a price in ringgit rather than sen", async () => {
    // 1.5 is what a form that forgot to convert would send. Rejected rather
    // than rounded: a dip priced at 2 sen is worse than a failed save.
    await expect(save([group({ choices: [{ name: "Gravy", priceDeltaSen: 1.5 }] })])).rejects.toThrow(
      /whole number of sen/,
    );
  });

  it("rejects a negative price", async () => {
    await expect(save([group({ choices: [{ name: "Gravy", priceDeltaSen: -150 }] })])).rejects.toThrow(
      /add to the price/,
    );
  });

  it("lets a price that is already negative stay exactly as it is", async () => {
    // The combo prices a downgrade to mineral water at -RM1.00. Refusing to
    // save it back would make that item uneditable.
    const item = await store.update(COMBO, { optionGroups: roundTrip(COMBO) });
    const water = item.optionGroups
      .flatMap((entry) => entry.choices)
      .find((choice) => choice.id === "mineral_water");
    expect(water?.priceDeltaSen).toBe(-100);
  });

  it("rejects a required group with nothing to pick", async () => {
    await expect(save([group({ required: true, choices: [] })])).rejects.toThrow(/at least one choice/);
  });

  it("rejects a maximum on a pick-one group", async () => {
    await expect(save([group({ selectionType: "single", maxSelect: 2 })])).rejects.toThrow(/pick-one/);
  });

  it("rejects a maximum below one", async () => {
    await expect(save([group({ selectionType: "multi", maxSelect: 0 })])).rejects.toThrow(/at least 1/);
    await expect(save([group({ selectionType: "multi", maxSelect: 2.5 })])).rejects.toThrow(/whole number/);
  });

  it("accepts a pick-several group with no maximum", async () => {
    const item = await save([group({ selectionType: "multi", maxSelect: undefined })]);
    expect(item.optionGroups[0]!.maxSelect).toBeUndefined();
    // "As many as there are" is what the customer app is then told.
    expect(menu.getItem(DORY)!.optionGroups[0]!.maxSelections).toBe(1);
  });

  it("rejects a selection type it does not recognise", async () => {
    await expect(save([group({ selectionType: "many" })])).rejects.toThrow(/"single" or "multi"/);
  });

  it("rejects anything that is not a list of groups", () => {
    expect(() => normalizeOptionGroups("seasoning")).toThrow(MenuValidationError);
    expect(() => normalizeOptionGroups([null])).toThrow(MenuValidationError);
  });
});

describe("what the customer is then held to", () => {
  let carts: CartService;

  beforeEach(() => {
    carts = new CartService(new InMemoryCartRepository(), menu);
  });

  it("enforces a multi-select group's maximum when the cart is built", async () => {
    const cart = await carts.create();

    await expect(
      carts.addLine(cart.id, {
        itemId: DORY,
        selections: [
          { groupId: "dips", choiceId: "tartar" },
          { groupId: "dips", choiceId: "curry_sauce" },
          { groupId: "dips", choiceId: "chilli" },
          { groupId: "dips", choiceId: "gravy" },
        ],
      }),
    ).rejects.toThrow(/pick at most 3/);
  });

  it("enforces a maximum staff have just lowered", async () => {
    const groups = roundTrip(DORY) as any[];
    groups[1].maxSelect = 1;
    await store.update(DORY, { optionGroups: groups });

    const cart = await carts.create();
    await expect(
      carts.addLine(cart.id, {
        itemId: DORY,
        selections: [
          { groupId: "dips", choiceId: "tartar" },
          { groupId: "dips", choiceId: "curry_sauce" },
        ],
      }),
    ).rejects.toThrow(OrderValidationError);

    // And one is still fine, at the price it has always been.
    const priced = await carts.addLine(cart.id, {
      itemId: DORY,
      selections: [{ groupId: "dips", choiceId: "tartar" }],
    });
    expect(priced.lines[0]!.lineTotalSen).toBe(1690 + 150);
  });

  it("adds every chosen delta to the line total", async () => {
    const cart = await carts.create();
    const priced = await carts.addLine(cart.id, {
      itemId: DORY,
      quantity: 2,
      selections: [
        { groupId: "seasoning", choiceId: "salted_egg" },
        { groupId: "dips", choiceId: "gravy" },
        { groupId: "dips", choiceId: "chilli" },
      ],
    });

    // RM16.90 + RM2.00 dust + RM1.50 + RM1.50, twice over.
    expect(priced.lines[0]!.unitPriceSen).toBe(1690 + 200 + 150 + 150);
    expect(priced.lines[0]!.lineTotalSen).toBe((1690 + 200 + 150 + 150) * 2);
  });

  it("prices a choice staff have just added", async () => {
    const groups = roundTrip(DORY) as any[];
    groups[1].choices.push({ name: "Mushy pea dip", priceDeltaSen: 175 });
    await store.update(DORY, { optionGroups: groups });

    const cart = await carts.create();
    const priced = await carts.addLine(cart.id, {
      itemId: DORY,
      selections: [{ groupId: "dips", choiceId: "mushy-pea-dip" }],
    });

    expect(priced.lines[0]!.unitPriceSen).toBe(1690 + 175);
    expect(priced.lines[0]!.options.map((option) => option.choiceName)).toContain("Mushy pea dip");
  });

  it("stops offering a choice staff have removed", async () => {
    const groups = roundTrip(DORY) as any[];
    groups[1].choices = groups[1].choices.filter((choice: any) => choice.id !== "gravy");
    await store.update(DORY, { optionGroups: groups });

    const cart = await carts.create();
    await expect(
      carts.addLine(cart.id, { itemId: DORY, selections: [{ groupId: "dips", choiceId: "gravy" }] }),
    ).rejects.toThrow(/no choice "gravy"/);
  });

  it("stops offering a group staff have removed", async () => {
    await store.update(DORY, { optionGroups: [(roundTrip(DORY) as unknown[])[0]] });

    const cart = await carts.create();
    await expect(
      carts.addLine(cart.id, { itemId: DORY, selections: [{ groupId: "dips", choiceId: "tartar" }] }),
    ).rejects.toThrow(/no option group "dips"/);
  });

  it("falls back to the default of a required group staff have just built", async () => {
    await store.update(DORY, {
      optionGroups: [
        {
          name: "Batter",
          selectionType: "single",
          required: true,
          choices: [{ name: "Classic" }, { name: "Extra crispy", priceDeltaSen: 100 }],
        },
      ],
    });

    const cart = await carts.create();
    const priced = await carts.addLine(cart.id, { itemId: DORY });

    // Nothing was picked, so the first choice answered for the customer rather
    // than the add failing on a question they did not care about.
    expect(priced.lines[0]!.options.map((option) => option.choiceName)).toEqual(["Classic"]);
    expect(priced.lines[0]!.unitPriceSen).toBe(1690);
  });
});
