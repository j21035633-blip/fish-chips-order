import { menuTools } from "../tools/menuTools.js";

/**
 * Exercise the menu tools without booting the server.
 *
 *   npm run menu                          full menu
 *   npm run menu -- --category chips      one section
 *   npm run menu -- --exclude gluten,milk allergen filter
 *   npm run menu -- --item fish-cod-premium
 *   npm run menu -- --suggest
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

try {
  const itemId = flag("item");

  if (itemId !== undefined) {
    console.log(menuTools.get_menu_item({ itemId }).text);
  } else if (has("suggest")) {
    console.log(menuTools.suggest_items({ excludeAllergens: csv(flag("exclude")) }).text);
  } else {
    const result = menuTools.get_menu({
      categories: csv(flag("category")),
      excludeAllergens: csv(flag("exclude")),
      search: flag("search"),
      includeUnavailable: has("all"),
    });
    console.log(result.text);

    if (result.withheld.length > 0) {
      console.log(`\nHeld back for allergens:`);
      for (const item of result.withheld) {
        const why = item.reason === "contains" ? "contains" : "shared fryer";
        console.log(`- ${item.name} (${why}: ${item.allergens.join(", ")})`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
