import { z } from "zod";

import { renderItem, renderMenu, renderSuggestions } from "../menu/render.js";
import { MenuService, menuService } from "../menu/service.js";
import { ALLERGENS, CATEGORY_IDS, DIETARY_TAGS, ITEM_TAGS } from "../menu/types.js";

/**
 * The Phase 1 tool surface for the Order & Track agent.
 *
 * `get_menu` is the tool named in the skill. `get_menu_item` and `suggest_items`
 * exist because the skill also asks the agent to answer flavour/portion/allergen
 * questions and to suggest something to an undecided customer — both are reads
 * over the same service, kept as separate tools so the agent does not have to
 * pull the whole menu to answer one question.
 *
 * Every result carries a `text` field. The agent is meant to speak from that
 * rather than re-format the structured payload, which keeps its replies short.
 */

const allergenSchema = z.enum(ALLERGENS);
const categorySchema = z.enum(CATEGORY_IDS);
const dietarySchema = z.enum(DIETARY_TAGS);
const tagSchema = z.enum(ITEM_TAGS);

export const getMenuInput = z.object({
  categories: z.array(categorySchema).optional().describe("Limit to these sections."),
  tags: z.array(tagSchema).optional().describe("Only items carrying at least one of these tags."),
  dietary: z.array(dietarySchema).optional().describe("Only items carrying all of these dietary tags."),
  excludeAllergens: z
    .array(allergenSchema)
    .optional()
    .describe("Keep these allergens out. Ask before assuming — this is an allergy question, not a preference."),
  allergenMode: z
    .enum(["strict", "contains"])
    .optional()
    .describe(
      "strict (default) also drops shared-fryer cross-contact items; use contains only for a taste preference.",
    ),
  maxPriceSen: z.number().int().positive().optional().describe("Base-price ceiling in sen (RM1 = 100)."),
  search: z.string().min(1).optional().describe("Free text over name, description and flavour notes."),
  includeUnavailable: z.boolean().optional().describe("Include sold-out items. Off by default."),
  withDescriptions: z.boolean().optional().describe("Include the one-line description per item in `text`."),
});
export type GetMenuInput = z.infer<typeof getMenuInput>;

export const getMenuItemInput = z.object({
  itemId: z.string().min(1).describe("Menu item id, e.g. fish-dory-classic."),
});

export const suggestItemsInput = z.object({
  categories: z.array(categorySchema).optional(),
  dietary: z.array(dietarySchema).optional(),
  excludeAllergens: z.array(allergenSchema).optional(),
  allergenMode: z.enum(["strict", "contains"]).optional(),
  limit: z.number().int().min(1).max(5).optional().describe("Default 3. Keep it small — this is spoken aloud."),
});

export function createMenuTools(service: MenuService = menuService) {
  return {
    /** Stage 1: show the menu, filtered however the customer framed it. */
    get_menu(rawInput: unknown = {}) {
      const input = getMenuInput.parse(rawInput ?? {});
      const { withDescriptions, ...query } = input;
      const result = service.getMenu(query);

      return {
        ...result,
        text: renderMenu(result, { withDescriptions: withDescriptions ?? true }),
      };
    },

    /** Stage 1: answer a flavour / portion / allergen question about one dish. */
    get_menu_item(rawInput: unknown) {
      const { itemId } = getMenuItemInput.parse(rawInput);
      const item = service.getItem(itemId);
      if (!item) {
        return { found: false as const, itemId, text: `No menu item with id "${itemId}".` };
      }

      const report = service.allergenReport(itemId);
      return {
        found: true as const,
        item,
        allergens: {
          contains: report?.contains ?? [],
          mayContain: report?.mayContain ?? [],
          fromOptions: report?.fromOptions ?? [],
        },
        text: renderItem(item),
      };
    },

    /** Stage 1: the undecided customer. Signature first, one per section. */
    suggest_items(rawInput: unknown = {}) {
      const input = suggestItemsInput.parse(rawInput ?? {});
      const suggestions = service.suggest(input);
      return { suggestions, text: renderSuggestions(suggestions) };
    },
  };
}

export const menuTools = createMenuTools();

/** JSON Schema definitions, for wiring these into a model's tool list. */
export const menuToolDefinitions = [
  {
    name: "get_menu",
    description:
      "Show the fish & chips menu, grouped by section. Filter by section, dietary tag, allergen, price or free text. Sold-out items are hidden unless asked for.",
    inputSchema: getMenuInput,
  },
  {
    name: "get_menu_item",
    description:
      "Full detail on one dish: how it tastes, how big it is, what it contains, and which options can add an allergen. Use this for any question about a specific item.",
    inputSchema: getMenuItemInput,
  },
  {
    name: "suggest_items",
    description:
      "Suggest what to order when the customer is undecided. Returns signature and popular items with a short reason for each.",
    inputSchema: suggestItemsInput,
  },
] as const;
