import { el } from "./common.js";

/**
 * The Options section of the staff item form.
 *
 * Builds the customization groups a customer is offered in the item modal:
 * "Seasoning" as a pick-one, "Extra dips" as a pick-up-to-three. It owns its own
 * little state array rather than reading the DOM back on save, because groups
 * and choices get reordered and removed and a half-typed name must survive the
 * redraw that follows.
 *
 * What it deliberately does *not* edit: the per-choice allergen list, and which
 * choice is preselected. There is no control for either, so both are carried
 * through untouched — a shop renaming a dip must not silently drop the egg
 * warning off it.
 *
 * Money is ringgit in the fields and sen on the wire, converted in `value()`
 * only, the same split the price field above it already uses.
 */

/** Ceiling matching the store's own; the button goes away rather than failing on save. */
const MAX_GROUPS = 12;
const MAX_CHOICES = 20;

export function optionGroupsEditor(root) {
  let groups = [];

  // ------------------------------------------------------------------ state

  /** Reads an item's groups off `/api/staff/menu-items` into editable state. */
  function load(itemGroups) {
    groups = (itemGroups ?? []).map(fromItem);
    draw();
  }

  /**
   * The `optionGroups` payload for the item endpoint.
   *
   * Throws on a price that is not a number, so the form's own error line says so
   * rather than the server saying it after a round trip.
   */
  function value() {
    return groups.map((group) => {
      const payload = {
        // Empty on a group that was just added — the server mints the id, and
        // an id has to stay put once it exists because carts point at it.
        id: group.id,
        name: group.name.trim(),
        selectionType: group.selectionType,
        required: group.required,
        choices: group.choices.map((choice) => ({
          id: choice.id,
          name: choice.name.trim(),
          priceDeltaSen: senFromRinggit(choice.price, choice.name),
          isDefault: choice.isDefault,
          available: choice.available,
          allergens: choice.allergens,
        })),
      };
      // Only ever sent on a pick-several group: the server rejects a ceiling on
      // a pick-one, which is the right complaint to make of a JSON client and
      // one this editor should never provoke.
      if (group.selectionType === "multi" && group.maxSelect !== "") {
        payload.maxSelect = Number(group.maxSelect);
      }
      return payload;
    });
  }

  // --------------------------------------------------------------- drawing

  function draw() {
    root.replaceChildren(
      ...groups.map(groupCard),
      groups.length >= MAX_GROUPS
        ? el("p", { class: "hint", text: `${MAX_GROUPS} option groups is the most one item can carry.` })
        : el("button", {
            class: "ghost wide add-group",
            type: "button",
            text: "+ Add option group",
            onClick: () => {
              groups.push(blankGroup());
              draw();
            },
          }),
    );
  }

  function groupCard(group, index) {
    const summary = el("span", { class: "option-summary", text: summarise(group) });

    const maxField = el("label", { class: "field option-max" }, [
      el("span", { text: "Max selections" }),
      el("input", {
        type: "number",
        min: "1",
        step: "1",
        value: group.maxSelect,
        placeholder: "any",
        onInput: (event) => {
          group.maxSelect = event.target.value;
          summary.textContent = summarise(group);
        },
      }),
    ]);
    // Hidden rather than absent, so flipping the toggle does not rebuild the
    // card and take the cursor out of whatever was being typed.
    maxField.hidden = group.selectionType !== "multi";

    const typeSelect = el(
      "select",
      {
        "aria-label": "Selection type",
        onChange: (event) => {
          group.selectionType = event.target.value;
          maxField.hidden = group.selectionType !== "multi";
          summary.textContent = summarise(group);
        },
      },
      [
        el("option", { value: "single", text: "Pick one", selected: group.selectionType === "single" }),
        el("option", { value: "multi", text: "Pick several", selected: group.selectionType === "multi" }),
      ],
    );

    return el("fieldset", { class: "option-group", "data-group": String(index) }, [
      el("div", { class: "option-head" }, [
        el("input", {
          class: "option-name",
          type: "text",
          maxlength: "60",
          placeholder: "Group name, e.g. Seasoning",
          value: group.name,
          "aria-label": "Option group name",
          onInput: (event) => {
            group.name = event.target.value;
          },
        }),
        reorder(groups, index, "option group"),
        el("button", {
          class: "destroy",
          type: "button",
          text: "Remove",
          "aria-label": `Remove option group ${index + 1}`,
          onClick: () => {
            groups.splice(index, 1);
            draw();
          },
        }),
      ]),

      el("div", { class: "option-rules" }, [
        el("label", { class: "field option-type" }, [el("span", { text: "Customer picks" }), typeSelect]),
        el("label", { class: "checkbox" }, [
          el("input", {
            type: "checkbox",
            checked: group.required,
            onChange: (event) => {
              group.required = event.target.checked;
              summary.textContent = summarise(group);
            },
          }),
          el("span", { text: "Required" }),
        ]),
        maxField,
        summary,
      ]),

      el("div", { class: "option-choices" }, group.choices.map((choice, at) => choiceRow(group, choice, at))),

      group.choices.length >= MAX_CHOICES
        ? el("p", { class: "hint", text: `${MAX_CHOICES} choices is the most one group can carry.` })
        : el("button", {
            class: "ghost add-choice",
            type: "button",
            text: "+ Add choice",
            onClick: () => {
              group.choices.push(blankChoice());
              draw();
            },
          }),
    ]);
  }

  function choiceRow(group, choice, index) {
    return el("div", { class: "option-choice", "data-choice": String(index) }, [
      el("input", {
        class: "choice-name",
        type: "text",
        maxlength: "60",
        placeholder: "Choice, e.g. Sea salt",
        value: choice.name,
        "aria-label": "Choice name",
        onInput: (event) => {
          choice.name = event.target.value;
        },
      }),
      el("label", { class: "choice-price" }, [
        el("span", { class: "hint", text: "RM" }),
        el("input", {
          type: "number",
          // Extras only. A choice that already takes money off — the mineral
          // water inside a combo — keeps its value; the server lets an untouched
          // negative through, and typing a new one is what it refuses.
          min: choice.price.startsWith("-") ? undefined : "0",
          step: "0.01",
          value: choice.price,
          placeholder: "0.00",
          "aria-label": `Extra charge for ${choice.name || "this choice"}`,
          onInput: (event) => {
            choice.price = event.target.value;
          },
        }),
      ]),
      reorder(group.choices, index, "choice"),
      el("button", {
        class: "destroy",
        type: "button",
        text: "×",
        "aria-label": `Remove choice ${index + 1}`,
        onClick: () => {
          group.choices.splice(index, 1);
          draw();
        },
      }),
    ]);
  }

  /** Up/down for one entry of `list`. Disabled at the ends rather than wrapping. */
  function reorder(list, index, label) {
    const step = (to) => () => {
      if (to < 0 || to >= list.length) return;
      const [entry] = list.splice(index, 1);
      list.splice(to, 0, entry);
      draw();
    };

    return el("div", { class: "option-move" }, [
      el("button", {
        class: "ghost move-up",
        type: "button",
        text: "↑",
        "aria-label": `Move ${label} ${index + 1} up`,
        disabled: index === 0,
        onClick: step(index - 1),
      }),
      el("button", {
        class: "ghost move-down",
        type: "button",
        text: "↓",
        "aria-label": `Move ${label} ${index + 1} down`,
        disabled: index === list.length - 1,
        onClick: step(index + 1),
      }),
    ]);
  }

  return { load, value };
}

// ---------------------------------------------------------------- conversion

function fromItem(group) {
  return {
    id: group.id ?? "",
    name: group.name ?? "",
    // `selectionType` is what the API sends now. The fallback reads the older
    // min/max pair, so an editor pointed at a stale response still opens right.
    selectionType: group.selectionType ?? (group.maxSelections === 1 ? "single" : "multi"),
    required: group.required === true,
    maxSelect: group.maxSelect === undefined ? "" : String(group.maxSelect),
    choices: (group.choices ?? []).map((choice) => ({
      id: choice.id ?? "",
      name: choice.name ?? "",
      price: ringgitFromSen(choice.priceDeltaSen ?? 0),
      isDefault: choice.isDefault === true,
      available: choice.available !== false,
      // Not editable here; carried so a save does not erase it.
      allergens: choice.allergens ?? [],
    })),
  };
}

function blankGroup() {
  return { id: "", name: "", selectionType: "single", required: false, maxSelect: "", choices: [blankChoice()] };
}

function blankChoice() {
  return { id: "", name: "", price: "0.00", isDefault: false, available: true, allergens: [] };
}

function ringgitFromSen(sen) {
  return (sen / 100).toFixed(2);
}

/**
 * Ringgit in the field, whole sen on the wire.
 *
 * Rounded rather than truncated for the same reason the price field above is:
 * 1.50 * 100 is not exactly 150 in binary, and half a sen lost per option adds
 * up across a service.
 */
function senFromRinggit(raw, choiceName) {
  const text = String(raw ?? "").trim();
  if (text === "") return 0;

  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`"${choiceName.trim() || "A choice"}" needs a price in ringgit, e.g. 1.50.`);
  }
  return Math.round(value * 100);
}

/** The one-line description of what this group will ask the customer. */
function summarise(group) {
  const shape =
    group.selectionType === "single"
      ? "Pick one"
      : group.maxSelect === ""
        ? "Pick any number"
        : `Pick up to ${group.maxSelect}`;
  return `${shape} · ${group.required ? "required" : "optional"}`;
}
