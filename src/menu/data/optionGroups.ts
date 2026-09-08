import type { OptionGroup } from "../types.js";

/**
 * Option groups shared across items. Built by function rather than shared as
 * constants so no two items ever alias the same object — a later phase mutating
 * availability on one item must not silently change another.
 *
 * These are written in the same shape the staff option-group builder saves:
 * `selectionType` + `required` + `maxSelect`. What the customer app sees is
 * unchanged — `toItemView` derives the `minSelections`/`maxSelections` pair it
 * has always rendered from these three fields.
 */

/** Regular / Large upsize. `upsizeSen` varies by item. */
export function sizeGroup(upsizeSen: number): OptionGroup {
  return {
    id: "size",
    name: "Size",
    selectionType: "single",
    required: true,
    choices: [
      { id: "regular", name: "Regular", priceDeltaSen: 0, isDefault: true, available: true },
      { id: "large", name: "Large", priceDeltaSen: upsizeSen, available: true },
    ],
  };
}

/** Fryer seasoning for anything that comes out of the basket. */
export function seasoningGroup(): OptionGroup {
  return {
    id: "seasoning",
    name: "Seasoning",
    selectionType: "single",
    required: true,
    choices: [
      { id: "sea_salt", name: "Sea salt", priceDeltaSen: 0, isDefault: true, available: true },
      { id: "salt_vinegar", name: "Salt & vinegar", priceDeltaSen: 0, available: true, allergens: ["sulphite"] },
      { id: "chicken_salt", name: "Chicken salt", priceDeltaSen: 0, available: true },
      { id: "salted_egg", name: "Salted egg dust", priceDeltaSen: 200, available: true, allergens: ["egg", "milk"] },
      { id: "no_seasoning", name: "No seasoning", priceDeltaSen: 0, available: true },
    ],
  };
}

/** Paid dips. Every fried item already ships with one tartar on the side. */
export function dipsGroup(): OptionGroup {
  return {
    id: "dips",
    name: "Extra dips",
    selectionType: "multi",
    required: false,
    maxSelect: 3,
    choices: [
      { id: "tartar", name: "Tartar sauce", priceDeltaSen: 150, available: true, allergens: ["egg", "milk", "fish"] },
      { id: "curry_sauce", name: "Curry sauce", priceDeltaSen: 150, available: true },
      { id: "chilli", name: "Chilli sauce", priceDeltaSen: 150, available: true },
      { id: "gravy", name: "Gravy", priceDeltaSen: 150, available: true, allergens: ["gluten", "soy"] },
      { id: "garlic_aioli", name: "Garlic aioli", priceDeltaSen: 150, available: true, allergens: ["egg"] },
    ],
  };
}

/** Ice level for cold drinks. */
export function iceGroup(): OptionGroup {
  return {
    id: "ice",
    name: "Ice",
    selectionType: "single",
    required: true,
    choices: [
      { id: "normal_ice", name: "Normal ice", priceDeltaSen: 0, isDefault: true, available: true },
      { id: "less_ice", name: "Less ice", priceDeltaSen: 0, available: true },
      { id: "no_ice", name: "No ice", priceDeltaSen: 0, available: true },
    ],
  };
}

/** Sugar level for anything we brew ourselves. */
export function sugarGroup(): OptionGroup {
  return {
    id: "sugar",
    name: "Sweetness",
    selectionType: "single",
    required: true,
    choices: [
      { id: "normal_sugar", name: "Normal", priceDeltaSen: 0, isDefault: true, available: true },
      { id: "less_sugar", name: "Less sweet", priceDeltaSen: 0, available: true },
      { id: "no_sugar", name: "No sugar", priceDeltaSen: 0, available: true },
    ],
  };
}

/** Drink slot inside a combo. Upgrades are priced against the RM4.50 soft drink. */
export function comboDrinkGroup(): OptionGroup {
  return {
    id: "combo_drink",
    name: "Pick your drink",
    selectionType: "single",
    required: true,
    choices: [
      { id: "soft_drink", name: "Soft drink", priceDeltaSen: 0, isDefault: true, available: true },
      { id: "teh_ais", name: "Teh ais", priceDeltaSen: 100, available: true, allergens: ["milk"] },
      { id: "limau_ais", name: "Limau ais", priceDeltaSen: 150, available: true },
      { id: "milo_ais", name: "Milo ais", priceDeltaSen: 250, available: true, allergens: ["milk", "gluten", "soy"] },
      // The one negative delta on the menu: swapping down to water takes RM1 off.
      { id: "mineral_water", name: "Mineral water", priceDeltaSen: -100, available: true },
    ],
  };
}
