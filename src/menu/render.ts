import type { MenuItemView, MenuResult, Suggestion } from "./service.js";

/**
 * Plain-text renderings of menu data.
 *
 * The agent is told to keep things short and hand over one thing at a time, so
 * the default rendering is a one-line-per-item list. Detail is opt-in via
 * `renderItem`, which is what you send when someone asks about a single dish.
 */

/** One line per item: name, price, and the short description. */
export function renderMenu(result: MenuResult, opts: { withDescriptions?: boolean } = {}): string {
  const withDescriptions = opts.withDescriptions ?? true;

  if (result.categories.length === 0) {
    return "Nothing on the menu matches that right now.";
  }

  const sections = result.categories.map((category) => {
    const lines = category.items.map((item) => {
      const flags = itemFlags(item);
      const head = `- ${item.name} — ${item.price}${flags ? ` ${flags}` : ""}`;
      return withDescriptions ? `${head}\n  ${item.description}` : head;
    });
    return `${category.name}\n${lines.join("\n")}`;
  });

  return sections.join("\n\n");
}

/** Everything about one dish: flavour, portion, allergens, options. */
export function renderItem(item: MenuItemView): string {
  const lines: string[] = [`${item.name} — ${item.price}`, item.flavourNotes, `Portion: ${item.portionSummary}`];

  if (item.allergens.length > 0) {
    lines.push(`Contains: ${item.allergens.map(allergenLabel).join(", ")}`);
  }
  if (item.mayContain.length > 0) {
    lines.push(`Shared fryer, so may contain: ${item.mayContain.map(allergenLabel).join(", ")}`);
  }

  for (const group of item.optionGroups) {
    const choices = group.choices
      .filter((choice) => choice.available)
      .map((choice) => (choice.priceDeltaSen === 0 ? choice.name : `${choice.name} ${choice.priceDelta}`))
      .join(", ");
    lines.push(`${group.name}${group.required ? "" : " (optional)"}: ${choices}`);
  }

  if (!item.available) {
    lines.push(`Not available — ${item.unavailableReason ?? "off the menu today"}`);
  }

  return lines.join("\n");
}

export function renderSuggestions(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return "Nothing to suggest with those filters.";
  return suggestions
    .map((suggestion) => `- ${suggestion.item.name} (${suggestion.reason}) — ${suggestion.item.price}`)
    .join("\n");
}

function itemFlags(item: MenuItemView): string {
  const flags: string[] = [];
  if (item.tags.includes("signature")) flags.push("signature");
  if (item.tags.includes("new")) flags.push("new");
  if (item.tags.includes("spicy")) flags.push("spicy");
  if (!item.available) flags.push(item.unavailableReason ?? "unavailable");
  return flags.length > 0 ? `[${flags.join(", ")}]` : "";
}

const ALLERGEN_LABELS: Record<string, string> = {
  fish: "fish",
  crustacean: "prawn/crab",
  mollusc: "squid/shellfish",
  gluten: "gluten",
  egg: "egg",
  milk: "dairy",
  soy: "soy",
  peanut: "peanut",
  tree_nut: "tree nuts",
  sesame: "sesame",
  sulphite: "sulphites",
  mustard: "mustard",
};

export function allergenLabel(allergen: string): string {
  return ALLERGEN_LABELS[allergen] ?? allergen;
}
