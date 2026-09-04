/**
 * The menu, as something you can tap.
 *
 * Shared by the customer app (`/app.js`) and the staff takeaway panel on the
 * Kitchen & Counter page, so an item card and an options group are one
 * implementation rather than two that drift. Everything here is presentation
 * over a payload from `/api/menu`; nothing in it talks to the network, holds
 * state, or knows which of the two pages it is on.
 *
 * It lives under the customer web root, and is therefore public, on purpose:
 * it is menu rendering, the same code `/app.js` already serves to anyone. The
 * rule that staff files stay out of this directory is about staff *pages* being
 * unreachable at the site root, and this is not one.
 */

/** Builds an element. Text goes in via textContent, never innerHTML. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/**
 * One row of the menu.
 *
 * A sold-out item is still listed — hiding it only moves "do you still do the
 * cod?" to the counter. It is greyed, not clickable, and where the price would
 * be it says why, so nobody taps it expecting a dialog.
 */
export function menuRow(item, onPick) {
  const sellable = item.available !== false;

  return el(
    "button",
    {
      class: "item",
      type: "button",
      // Not `disabled`: a disabled button is skipped by the keyboard and reads
      // as nothing at all to a screen reader. aria-disabled keeps it in the
      // page and announced, and the handler below declines the tap.
      "aria-disabled": sellable ? undefined : "true",
      onClick: () => sellable && onPick(item),
    },
    [
      item.imageUrl
        ? el("img", { class: "item-thumb", src: item.imageUrl, alt: "", loading: "lazy" })
        : null,
      el("div", { class: "item-main" }, [
        el("div", { class: "item-name", text: item.name }),
        el("div", { class: "item-desc", text: item.description }),
        item.tags.length > 0
          ? el(
              "div",
              { class: "tags" },
              item.tags
                .filter((tag) => ["signature", "popular", "new", "spicy"].includes(tag))
                .map((tag) => el("span", { class: `tag ${tag}`, text: tag })),
            )
          : null,
      ]),
      sellable
        ? el("div", { class: "item-price", text: item.price })
        : el("div", { class: "item-unavailable" }, [
            document.createTextNode("Currently unavailable"),
            item.unavailableReason
              ? el("span", { class: "item-unavailable-reason", text: item.unavailableReason })
              : null,
          ]),
    ],
  );
}

/** The whole menu, grouped by section. `onPick` gets the item that was tapped. */
export function menuSections(categories, onPick) {
  return categories.map((category) =>
    el("section", { class: "category" }, [
      el("div", { class: "category-head" }, [
        el("h2", { text: category.name }),
        el("p", { text: category.blurb }),
      ]),
      ...category.items.map((item) => menuRow(item, onPick)),
    ]),
  );
}

/**
 * One option group — the ice level, the chips size, the sauces.
 *
 * `onChange` fires on every choice, which is what keeps a live price in step
 * with what has been picked.
 */
export function optionGroup(group, onChange) {
  const pickOne = group.maxSelections === 1;
  const hint = pickOne ? (group.required ? "pick one" : "optional") : `pick up to ${group.maxSelections}`;

  return el("div", { class: "group", "data-group": group.id }, [
    el("div", { class: "group-name" }, [
      document.createTextNode(group.name + " "),
      el("span", { class: "group-hint", text: `(${hint})` }),
    ]),
    ...group.choices
      .filter((choice) => choice.available)
      .map((choice) =>
        el("label", { class: "choice" }, [
          el("input", {
            type: pickOne ? "radio" : "checkbox",
            name: group.id,
            value: choice.id,
            checked: pickOne && choice.isDefault,
            "data-delta": String(choice.priceDeltaSen),
            onChange,
          }),
          el("span", { class: "choice-name", text: choice.name }),
          choice.priceDeltaSen !== 0 ? el("span", { class: "choice-delta", text: choice.priceDelta }) : null,
        ]),
      ),
  ]);
}

/**
 * Everything an item needs shown above its options: notes, portion, allergens.
 *
 * Filtered before it is returned, so the empty slots never leave this function.
 * `replaceChildren` stringifies anything that is not a Node, and an item with no
 * allergens was putting the literal text "null" on the page of any caller that
 * spread this straight into it.
 */
export function itemDetails(item) {
  return [
    el("p", { class: "flavour", text: item.flavourNotes }),
    el("p", { class: "portion", text: item.portionSummary }),
    item.allergens.length > 0
      ? el("p", { class: "allergens", text: `Contains: ${item.allergens.join(", ")}` })
      : null,
  ].filter(Boolean);
}

/** What is ticked inside `root`, with the price delta each choice carries. */
export function selectedChoices(root) {
  return [...root.querySelectorAll(".group")].flatMap((groupEl) =>
    [...groupEl.querySelectorAll("input:checked")].map((input) => ({
      groupId: groupEl.dataset.group,
      choiceId: input.value,
      delta: Number(input.dataset.delta),
    })),
  );
}

/**
 * Prices what is on screen.
 *
 * Display only — the server re-derives every price from ids when the line is
 * added, so nothing here can decide what anyone is charged.
 */
export function pricedSelection(item, root, quantity) {
  const base = Math.round(Number(String(item.price).replace(/[^0-9.-]/g, "")) * 100);
  const deltas = selectedChoices(root).reduce((total, choice) => total + choice.delta, 0);
  return (base + deltas) * quantity;
}

export function formatSen(sen) {
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  return `${sign}RM${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
