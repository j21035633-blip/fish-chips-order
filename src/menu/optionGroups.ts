import {
  ALLERGENS,
  MenuValidationError,
  SELECTION_TYPES,
  type Allergen,
  type Menu,
  type OptionChoice,
  type OptionGroup,
  type SelectionType,
} from "./types.js";

/**
 * Reading, checking and migrating the option groups staff build on an item.
 *
 * Two entry points, deliberately different in temperament:
 *
 * - `normalizeOptionGroups` is **strict**. It is what the staff form posts into,
 *   so every complaint it makes is something somebody can fix in the form.
 * - `migrateOptionGroups` is **lenient**. It is what an already-stored menu goes
 *   through on boot, and rejecting a document the shop is currently trading on
 *   would take the menu down over a field name.
 */

const MAX_GROUPS = 12;
const MAX_CHOICES = 20;
const MAX_GROUP_NAME = 60;
const MAX_CHOICE_NAME = 60;
/** RM1,000 on a single choice. A guard against a stray keystroke, not a real ceiling. */
const MAX_DELTA_SEN = 100_000;

/** The shape the staff builder posts. Every field optional; this is untrusted input. */
export interface OptionChoiceInput {
  id?: unknown;
  name?: unknown;
  priceDeltaSen?: unknown;
  isDefault?: unknown;
  available?: unknown;
  allergens?: unknown;
}

export interface OptionGroupInput {
  id?: unknown;
  name?: unknown;
  selectionType?: unknown;
  required?: unknown;
  maxSelect?: unknown;
  choices?: unknown;
}

/**
 * Validates and fills in a whole `optionGroups` array, replacing whatever the
 * item held.
 *
 * `existing` is the item's current groups, and is read for two things only:
 * carrying forward the per-choice fields the form has no control over
 * (allergens, and the default/availability flags when a caller omits them), and
 * letting a price delta that is already negative stay exactly as it is. Nothing
 * else is inherited — this is a replace, so a group left out of the payload is
 * a group that has been deleted.
 */
export function normalizeOptionGroups(raw: unknown, existing: readonly OptionGroup[] = []): OptionGroup[] {
  if (!Array.isArray(raw)) {
    throw new MenuValidationError("optionGroups must be a list.", "invalid_option_groups", { optionGroups: raw });
  }
  if (raw.length > MAX_GROUPS) {
    throw new MenuValidationError(`An item can have at most ${MAX_GROUPS} option groups.`, "too_many_option_groups", {
      count: raw.length,
      max: MAX_GROUPS,
    });
  }

  const groups: OptionGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const input = asRecord(entry, `Option group ${index + 1}`) as OptionGroupInput;
    const name = requireName(input.name, `Option group ${index + 1}`, MAX_GROUP_NAME);
    const selectionType = requireSelectionType(input.selectionType, name);
    const required = optionalBoolean(input.required, `${name}: required`) ?? false;

    const id = uniqueId(text(input.id), name, "group", usedGroupIds);
    const previous = existing.find((candidate) => candidate.id === id);

    const group: OptionGroup = {
      id,
      name,
      selectionType,
      required,
      choices: choicesFor(input.choices, name, selectionType, previous),
    };

    const maxSelect = readMaxSelect(input.maxSelect, name, selectionType);
    if (maxSelect !== undefined) group.maxSelect = maxSelect;

    // Nothing to pick means nothing can satisfy it, so the customer would be
    // held on a group they cannot answer. Asked for on `single`; it is just as
    // impossible on `multi`, so it is checked on both.
    if (required && group.choices.length === 0) {
      throw new MenuValidationError(`"${name}" is required, so it needs at least one choice.`, "option_group_empty", {
        group: name,
      });
    }

    groups.push(group);
  }

  return groups;
}

/**
 * One group's choices: named, priced, and with the fields the form cannot see
 * carried over from whatever choice already held that id.
 */
function choicesFor(
  raw: unknown,
  groupName: string,
  selectionType: SelectionType,
  previous: OptionGroup | undefined,
): OptionChoice[] {
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list)) {
    throw new MenuValidationError(`"${groupName}": choices must be a list.`, "invalid_option_choices", {
      group: groupName,
    });
  }
  if (list.length > MAX_CHOICES) {
    throw new MenuValidationError(
      `"${groupName}" can have at most ${MAX_CHOICES} choices.`,
      "too_many_option_choices",
      { group: groupName, count: list.length, max: MAX_CHOICES },
    );
  }

  const choices: OptionChoice[] = [];
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();

  for (const [index, entry] of list.entries()) {
    const input = asRecord(entry, `"${groupName}" choice ${index + 1}`) as OptionChoiceInput;
    const name = requireName(input.name, `"${groupName}" choice ${index + 1}`, MAX_CHOICE_NAME);

    // Compared case-insensitively: two choices a customer reads as the same word
    // are a mistake however they were capitalised.
    const nameKey = name.toLowerCase();
    if (usedNames.has(nameKey)) {
      throw new MenuValidationError(`"${groupName}" lists "${name}" twice.`, "duplicate_option_choice", {
        group: groupName,
        choice: name,
      });
    }
    usedNames.add(nameKey);

    const id = uniqueId(text(input.id), name, "choice", usedIds);
    const before = previous?.choices.find((candidate) => candidate.id === id);

    const choice: OptionChoice = {
      id,
      name,
      priceDeltaSen: readDelta(input.priceDeltaSen, groupName, name, before),
      available: optionalBoolean(input.available, `"${name}": available`) ?? before?.available ?? true,
    };

    const isDefault = optionalBoolean(input.isDefault, `"${name}": isDefault`) ?? before?.isDefault ?? false;
    if (isDefault) choice.isDefault = true;

    // The form has no allergen control, so an omitted list means "unchanged"
    // rather than "none" — otherwise saving a rename would quietly drop the
    // egg warning off the salted egg dust.
    const allergens = input.allergens === undefined ? before?.allergens : readAllergens(input.allergens, name);
    if (allergens !== undefined && allergens.length > 0) choice.allergens = allergens;

    choices.push(choice);
  }

  return withSingleDefault(choices, selectionType);
}

/**
 * A `single` group gets exactly one default, or none if it has no choices.
 *
 * Pricing falls back to the default when a customer says nothing about a
 * required group, so a staff-built group with nothing marked would block the
 * order on a question nobody wanted to answer. The first choice is the one
 * promoted — the same position every seeded group already marks.
 */
function withSingleDefault(choices: OptionChoice[], selectionType: SelectionType): OptionChoice[] {
  if (selectionType !== "single" || choices.length === 0) return choices;

  const marked = choices.filter((choice) => choice.isDefault);
  if (marked.length === 1) return choices;

  for (const choice of choices) delete choice.isDefault;
  (marked[0] ?? choices[0]!).isDefault = true;
  return choices;
}

function readMaxSelect(raw: unknown, groupName: string, selectionType: SelectionType): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;

  if (selectionType !== "multi") {
    throw new MenuValidationError(
      `"${groupName}" is a pick-one group, so it cannot carry a maximum.`,
      "max_select_not_multi",
      { group: groupName, maxSelect: raw },
    );
  }

  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CHOICES) {
    throw new MenuValidationError(
      `"${groupName}": the maximum must be a whole number of at least 1.`,
      "invalid_max_select",
      { group: groupName, maxSelect: raw },
    );
  }
  return value;
}

/**
 * A price delta in sen.
 *
 * Non-negative, as a surcharge: the form's field is "how much extra". The one
 * exception is a delta that is already stored negative and has not been
 * touched — the combos price a downgrade to mineral water at -RM1.00, and
 * refusing to save that back would make those three items uneditable.
 */
function readDelta(raw: unknown, groupName: string, choiceName: string, before: OptionChoice | undefined): number {
  if (raw === undefined || raw === null || raw === "") return 0;

  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MenuValidationError(
      `"${choiceName}": the extra must be a whole number of sen, not ${JSON.stringify(raw)}.`,
      "invalid_option_price",
      { group: groupName, choice: choiceName, priceDeltaSen: raw },
    );
  }
  if (value > MAX_DELTA_SEN) {
    throw new MenuValidationError(
      `"${choiceName}": ${MAX_DELTA_SEN / 100} ringgit is more than an option can add.`,
      "invalid_option_price",
      { group: groupName, choice: choiceName, priceDeltaSen: value, max: MAX_DELTA_SEN },
    );
  }
  if (value < 0 && value !== before?.priceDeltaSen) {
    throw new MenuValidationError(
      `"${choiceName}": an option can add to the price, not take off it.`,
      "invalid_option_price",
      { group: groupName, choice: choiceName, priceDeltaSen: value },
    );
  }
  return value;
}

function readAllergens(raw: unknown, choiceName: string): Allergen[] {
  if (!Array.isArray(raw)) {
    throw new MenuValidationError(`"${choiceName}": allergens must be a list.`, "invalid_allergens", {
      choice: choiceName,
    });
  }
  return raw.map((entry) => {
    const value = String(entry);
    if (!(ALLERGEN_SET as ReadonlySet<string>).has(value)) {
      throw new MenuValidationError(`"${choiceName}": "${value}" is not an allergen we declare.`, "invalid_allergens", {
        choice: choiceName,
        allergen: value,
      });
    }
    return value as Allergen;
  });
}

// ------------------------------------------------------------------ migration

/**
 * Rewrites a stored menu's option groups into the current shape, in place.
 *
 * Before the staff builder existed a group was a `minSelections`/`maxSelections`
 * pair. That maps onto the current three fields exactly for every group the shop
 * has ever had: `maxSelections === 1` is a pick-one, anything higher is a
 * pick-several with that ceiling, and a minimum above zero is a required group.
 *
 * The one thing the pair could say that the current shape cannot is "pick at
 * least two" — no seeded or staff-saved group has ever set that, and it reads
 * back as "required", which is the closest true statement.
 *
 * Returns whether anything actually changed, so a boot against an
 * already-migrated database does not write.
 */
export function migrateOptionGroups(menu: Menu): boolean {
  let changed = false;

  for (const item of menu.items ?? []) {
    if (!Array.isArray(item.optionGroups)) {
      item.optionGroups = [];
      changed = true;
      continue;
    }
    for (const [index, group] of item.optionGroups.entries()) {
      const migrated = migrateGroup(group);
      if (migrated) {
        item.optionGroups[index] = migrated;
        changed = true;
      }
    }
  }

  return changed;
}

/** Returns the rewritten group, or undefined when it is already current. */
function migrateGroup(group: OptionGroup): OptionGroup | undefined {
  const legacy = group as OptionGroup & { minSelections?: unknown; maxSelections?: unknown };
  const hasSelectionType = (SELECTION_TYPES as readonly string[]).includes(String(legacy.selectionType));
  if (hasSelectionType && legacy.minSelections === undefined && legacy.maxSelections === undefined) return undefined;

  const maxSelections = Number(legacy.maxSelections);
  const minSelections = Number(legacy.minSelections);

  const selectionType: SelectionType = hasSelectionType
    ? (legacy.selectionType as SelectionType)
    : Number.isFinite(maxSelections) && maxSelections > 1
      ? "multi"
      : "single";

  const required =
    typeof legacy.required === "boolean" ? legacy.required : Number.isFinite(minSelections) && minSelections > 0;

  const next: OptionGroup = {
    id: group.id,
    name: group.name,
    selectionType,
    required,
    choices: group.choices ?? [],
  };

  const maxSelect =
    typeof legacy.maxSelect === "number"
      ? legacy.maxSelect
      : selectionType === "multi" && Number.isFinite(maxSelections)
        ? maxSelections
        : undefined;
  if (selectionType === "multi" && maxSelect !== undefined) next.maxSelect = maxSelect;

  return next;
}

// -------------------------------------------------------------------- helpers

const ALLERGEN_SET: ReadonlySet<string> = new Set(ALLERGENS);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MenuValidationError(`${label} is not filled in.`, "invalid_option_groups", { value });
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function requireName(value: unknown, label: string, max: number): string {
  const trimmed = text(value);
  if (trimmed.length === 0) {
    throw new MenuValidationError(`${label} needs a name.`, "missing_option_name", { field: label });
  }
  if (trimmed.length > max) {
    throw new MenuValidationError(`${label}: a name must be ${max} characters or fewer.`, "field_too_long", {
      field: label,
      max,
    });
  }
  return trimmed;
}

function requireSelectionType(value: unknown, groupName: string): SelectionType {
  const raw = text(value);
  if (!(SELECTION_TYPES as readonly string[]).includes(raw)) {
    throw new MenuValidationError(
      `"${groupName}": pick either "single" or "multi".`,
      "invalid_selection_type",
      { group: groupName, selectionType: value },
    );
  }
  return raw as SelectionType;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;

  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(raw)) return true;
  if (["false", "0", "off", "no"].includes(raw)) return false;
  throw new MenuValidationError(`${label}: "${String(value)}" is not true or false.`, "invalid_boolean", {
    field: label,
    value,
  });
}

/**
 * Keeps the id the client sent, or mints one from the name.
 *
 * Ids have to survive a rename: a cart in someone's hand holds `{ groupId,
 * choiceId }`, and re-slugging on every save would make that cart unpriceable
 * the moment staff fixed a typo. So the builder round-trips whatever it loaded,
 * and only something genuinely new gets a fresh id here.
 */
function uniqueId(sent: string, name: string, fallback: string, used: Set<string>): string {
  const base = slug(sent) || slug(name) || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
