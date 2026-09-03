import { formatSen } from "../menu/money.js";
import type { MenuItemView, MenuService, OptionGroupView } from "../menu/service.js";
import type { Allergen } from "../menu/types.js";
import {
  OrderValidationError,
  type CartLine,
  type OptionSelection,
  type PricedCart,
  type PricedLine,
  type PricedOption,
} from "./types.js";

/** A single order line cannot exceed this. Guards against a fat-fingered quantity. */
export const MAX_LINE_QUANTITY = 20;

/**
 * Turns what the customer asked for into what it costs, validating against the
 * live menu on the way. Pricing never trusts a client-supplied price — the
 * browser sends item and choice *ids* only, and everything is re-derived here.
 */
export function priceLine(line: CartLine, menu: MenuService): PricedLine {
  const item = menu.getItem(line.itemId);
  if (!item) {
    throw new OrderValidationError(`No menu item "${line.itemId}".`, "unknown_item", { itemId: line.itemId });
  }
  if (!item.available) {
    throw new OrderValidationError(
      `${item.name} is not available — ${item.unavailableReason ?? "off the menu today"}.`,
      "item_unavailable",
      { itemId: item.id },
    );
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) {
    throw new OrderValidationError(
      `Quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}.`,
      "invalid_quantity",
      { quantity: line.quantity },
    );
  }

  rejectUnknownGroups(item, line.selections);

  const options: PricedOption[] = [];
  for (const group of item.optionGroups) {
    options.push(...resolveGroup(item, group, line.selections));
  }

  const unitPriceSen = options.reduce((total, option) => total + option.priceDeltaSen, item.priceSen);
  if (unitPriceSen < 0) {
    throw new OrderValidationError("That combination prices below zero.", "invalid_price", { itemId: item.id });
  }

  const allergens = new Set<Allergen>(item.allergens);
  for (const option of options) {
    const group = item.optionGroups.find((candidate) => candidate.id === option.groupId);
    const choice = group?.choices.find((candidate) => candidate.id === option.choiceId);
    for (const allergen of choice?.allergens ?? []) allergens.add(allergen);
  }

  const lineTotalSen = unitPriceSen * line.quantity;

  const priced: PricedLine = {
    lineId: line.lineId,
    itemId: item.id,
    name: item.name,
    quantity: line.quantity,
    unitBasePriceSen: item.priceSen,
    options,
    unitPriceSen,
    unitPrice: formatSen(unitPriceSen),
    lineTotalSen,
    lineTotal: formatSen(lineTotalSen),
    allergens: [...allergens],
  };
  if (line.note !== undefined) priced.note = line.note;
  return priced;
}

export function priceCart(
  cartId: string,
  lines: CartLine[],
  menu: MenuService,
  tableNumber?: string,
): PricedCart {
  const priced = lines.map((line) => priceLine(line, menu));
  const subtotalSen = priced.reduce((total, line) => total + line.lineTotalSen, 0);

  const cart: PricedCart = {
    cartId,
    lines: priced,
    itemCount: priced.reduce((count, line) => count + line.quantity, 0),
    subtotalSen,
    subtotal: formatSen(subtotalSen),
    // No SST or service charge modelled yet.
    totalSen: subtotalSen,
    total: formatSen(subtotalSen),
  };
  if (tableNumber !== undefined) cart.tableNumber = tableNumber;
  return cart;
}

function rejectUnknownGroups(item: MenuItemView, selections: OptionSelection[]): void {
  for (const selection of selections) {
    if (!item.optionGroups.some((group) => group.id === selection.groupId)) {
      throw new OrderValidationError(
        `${item.name} has no option group "${selection.groupId}".`,
        "unknown_option_group",
        { itemId: item.id, groupId: selection.groupId },
      );
    }
  }
}

/**
 * Validates one group's selections and prices them.
 *
 * A required group the customer said nothing about falls back to its default
 * choice rather than erroring — someone ordering "chips" should not be blocked
 * on picking a seasoning they do not care about.
 */
function resolveGroup(
  item: MenuItemView,
  group: OptionGroupView,
  selections: OptionSelection[],
): PricedOption[] {
  const chosenIds = selections
    .filter((selection) => selection.groupId === group.id)
    .map((selection) => selection.choiceId);

  const duplicate = chosenIds.find((id, index) => chosenIds.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new OrderValidationError(
      `${group.name}: "${duplicate}" was picked twice.`,
      "duplicate_option",
      { itemId: item.id, groupId: group.id, choiceId: duplicate },
    );
  }

  if (chosenIds.length === 0 && group.minSelections > 0) {
    const fallback = group.choices.find((choice) => choice.isDefault && choice.available);
    if (!fallback) {
      throw new OrderValidationError(
        `${item.name} needs a ${group.name.toLowerCase()} choice.`,
        "option_required",
        { itemId: item.id, groupId: group.id },
      );
    }
    chosenIds.push(fallback.id);
  }

  if (chosenIds.length < group.minSelections) {
    throw new OrderValidationError(
      `${group.name}: pick at least ${group.minSelections}.`,
      "too_few_options",
      { itemId: item.id, groupId: group.id, minSelections: group.minSelections },
    );
  }
  if (chosenIds.length > group.maxSelections) {
    throw new OrderValidationError(
      `${group.name}: pick at most ${group.maxSelections}.`,
      "too_many_options",
      { itemId: item.id, groupId: group.id, maxSelections: group.maxSelections },
    );
  }

  return chosenIds.map((choiceId) => {
    const choice = group.choices.find((candidate) => candidate.id === choiceId);
    if (!choice) {
      throw new OrderValidationError(
        `${group.name} has no choice "${choiceId}".`,
        "unknown_option_choice",
        { itemId: item.id, groupId: group.id, choiceId },
      );
    }
    if (!choice.available) {
      throw new OrderValidationError(
        `${choice.name} is not available right now.`,
        "option_unavailable",
        { itemId: item.id, groupId: group.id, choiceId },
      );
    }
    return {
      groupId: group.id,
      groupName: group.name,
      choiceId: choice.id,
      choiceName: choice.name,
      priceDeltaSen: choice.priceDeltaSen,
    };
  });
}
