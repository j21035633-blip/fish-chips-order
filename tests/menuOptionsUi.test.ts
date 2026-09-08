/**
 * @vitest-environment jsdom
 *
 * The staff option-group builder, against the real markup and the real API.
 *
 * The thing being proved is the one that cannot be proved from the store: that
 * opening the Classic Battered Dory for edit shows the Seasoning and Extra dips
 * it is *actually* configured with — the same two groups a customer is offered —
 * and that saving them straight back changes nothing.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServices } from "../src/app/container.js";
import { createServer } from "../src/http/app.js";

const staffDir = resolve(process.cwd(), "src/staff-web");
const editorUrl = pathToFileURL(resolve(staffDir, "assets/optionGroups.js")).href;

const DORY = "fish-dory-classic";
const COMBO = "combo-classic";

let server: Server;
let base: string;
let optionGroupsEditor: (root: Element) => { load(groups: unknown): void; value(): any[] };

beforeAll(async () => {
  server = createServer(createServices()).listen(0);
  await new Promise((done) => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ({ optionGroupsEditor } = (await import(pathToFileURL(resolve(staffDir, "assets/optionGroups.js")).href)) as any);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

/** The item exactly as the staff page lists it — what `openForm` hands the editor. */
async function staffItem(itemId: string): Promise<any> {
  const response = await fetch(`${base}/api/staff/menu-items`);
  const body = (await response.json()) as any;
  return body.items.find((item: { id: string }) => item.id === itemId);
}

let root: HTMLElement;
let editor: ReturnType<typeof optionGroupsEditor>;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("div");
  document.body.append(root);
  editor = optionGroupsEditor(root);
});

const groupCards = () => [...root.querySelectorAll(".option-group")];
const nameOf = (card: Element) => (card.querySelector(".option-name") as HTMLInputElement).value;
const typeOf = (card: Element) => (card.querySelector("select") as HTMLSelectElement).value;
const requiredOf = (card: Element) =>
  (card.querySelector('.checkbox input[type="checkbox"]') as HTMLInputElement).checked;
const maxFieldOf = (card: Element) => card.querySelector(".option-max") as HTMLElement;
const maxOf = (card: Element) => (maxFieldOf(card).querySelector("input") as HTMLInputElement).value;
const choiceRows = (card: Element) => [...card.querySelectorAll(".option-choice")];
const choiceName = (row: Element) => (row.querySelector(".choice-name") as HTMLInputElement).value;
const choicePrice = (row: Element) => (row.querySelector(".choice-price input") as HTMLInputElement).value;

function type(input: Element, value: string): void {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(button: Element | null | undefined): void {
  (button as HTMLButtonElement).click();
}

describe("opening the Classic Battered Dory for edit", () => {
  let dory: any;

  beforeEach(async () => {
    dory = await staffItem(DORY);
    editor.load(dory.optionGroups);
  });

  it("draws the two groups it is actually configured with", () => {
    expect(groupCards().map(nameOf)).toEqual(["Seasoning", "Extra dips"]);
  });

  it("shows Seasoning as a required pick-one, with no maximum to set", () => {
    const [seasoning] = groupCards();

    expect(typeOf(seasoning!)).toBe("single");
    expect(requiredOf(seasoning!)).toBe(true);
    // A pick-one is capped at one by definition, so the field is not offered.
    expect(maxFieldOf(seasoning!).hidden).toBe(true);
    expect(seasoning!.querySelector(".option-summary")!.textContent).toBe("Pick one · required");
  });

  it("shows Extra dips as an optional pick-up-to-three", () => {
    const dips = groupCards()[1]!;

    expect(typeOf(dips)).toBe("multi");
    expect(requiredOf(dips)).toBe(false);
    expect(maxFieldOf(dips).hidden).toBe(false);
    expect(maxOf(dips)).toBe("3");
    expect(dips.querySelector(".option-summary")!.textContent).toBe("Pick up to 3 · optional");
  });

  it("lists every choice, at the price the customer is charged", () => {
    const [seasoning, dips] = groupCards();

    expect(choiceRows(seasoning!).map(choiceName)).toEqual([
      "Sea salt",
      "Salt & vinegar",
      "Chicken salt",
      "Salted egg dust",
      "No seasoning",
    ]);
    // Ringgit in the field, sen on the wire. RM2.00 is the salted egg dust.
    expect(choiceRows(seasoning!).map(choicePrice)).toEqual(["0.00", "0.00", "0.00", "2.00", "0.00"]);

    expect(choiceRows(dips!).map(choiceName)).toEqual([
      "Tartar sauce",
      "Curry sauce",
      "Chilli sauce",
      "Gravy",
      "Garlic aioli",
    ]);
    expect(choiceRows(dips!).map(choicePrice)).toEqual(["1.50", "1.50", "1.50", "1.50", "1.50"]);
  });

  it("hands back a payload the item endpoint saves without changing anything", async () => {
    const response = await fetch(`${base}/api/staff/menu-items/${DORY}`, {
      method: "PUT",
      body: form({ optionGroups: JSON.stringify(editor.value()) }),
    });
    expect(response.status).toBe(200);

    // Straight in and straight back out: the same two groups, the same choices,
    // the same prices — and the allergen lists the form cannot even show.
    expect((await staffItem(DORY)).optionGroups).toEqual(dory.optionGroups);
  });
});

describe("editing what is there", () => {
  beforeEach(async () => {
    editor.load((await staffItem(DORY)).optionGroups);
  });

  it("renames a group and a choice, keeping both ids", () => {
    type(groupCards()[1]!.querySelector(".option-name")!, "Sauces");
    type(choiceRows(groupCards()[1]!)[0]!.querySelector(".choice-name")!, "House tartar");

    const dips = editor.value()[1];
    expect(dips).toMatchObject({ id: "dips", name: "Sauces" });
    expect(dips.choices[0]).toMatchObject({ id: "tartar", name: "House tartar" });
  });

  it("turns a pick-one into a pick-several, and offers the maximum only then", () => {
    const seasoning = groupCards()[0]!;
    const select = seasoning.querySelector("select") as HTMLSelectElement;

    select.value = "multi";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(maxFieldOf(seasoning).hidden).toBe(false);
    expect(seasoning.querySelector(".option-summary")!.textContent).toBe("Pick any number · required");

    type(maxFieldOf(seasoning).querySelector("input")!, "2");
    expect(editor.value()[0]).toMatchObject({ selectionType: "multi", maxSelect: 2 });
  });

  it("drops the maximum again when it goes back to a pick-one", () => {
    const dips = groupCards()[1]!;
    const select = dips.querySelector("select") as HTMLSelectElement;

    select.value = "single";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));

    // The server refuses a ceiling on a pick-one, so the payload must not carry
    // the 3 that is still sitting in the hidden field.
    expect(editor.value()[1].maxSelect).toBeUndefined();
    expect(maxFieldOf(dips).hidden).toBe(true);
  });

  it("toggles required", () => {
    const box = groupCards()[1]!.querySelector('.checkbox input') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(editor.value()[1].required).toBe(true);
    expect(groupCards()[1]!.querySelector(".option-summary")!.textContent).toBe("Pick up to 3 · required");
  });

  it("adds a choice, priced in ringgit and sent in sen", () => {
    click(groupCards()[1]!.querySelector(".add-choice"));

    const added = choiceRows(groupCards()[1]!)[5]!;
    type(added.querySelector(".choice-name")!, "Mushy pea dip");
    type(added.querySelector(".choice-price input")!, "1.75");

    const choices = editor.value()[1].choices;
    expect(choices).toHaveLength(6);
    // No id: it is new, and the server is what mints one.
    expect(choices[5]).toMatchObject({ id: "", name: "Mushy pea dip", priceDeltaSen: 175 });
  });

  it("removes one choice without touching the others", () => {
    click(choiceRows(groupCards()[1]!)[3]!.querySelector(".destroy"));

    expect(editor.value()[1].choices.map((choice: any) => choice.id)).toEqual([
      "tartar",
      "curry_sauce",
      "chilli",
      "garlic_aioli",
    ]);
  });

  it("removes a whole group", () => {
    click(groupCards()[0]!.querySelector(".option-head .destroy"));

    expect(groupCards()).toHaveLength(1);
    expect(editor.value().map((group) => group.id)).toEqual(["dips"]);
  });

  it("adds a group, ready to name", () => {
    click(root.querySelector(".add-group"));

    expect(groupCards()).toHaveLength(3);
    const added = groupCards()[2]!;
    expect(nameOf(added)).toBe("");
    // One empty choice to type into, rather than a group with nothing in it.
    expect(choiceRows(added)).toHaveLength(1);

    type(added.querySelector(".option-name")!, "Bread roll");
    type(choiceRows(added)[0]!.querySelector(".choice-name")!, "Buttered roll");
    expect(editor.value()[2]).toMatchObject({ id: "", name: "Bread roll", selectionType: "single", required: false });
  });

  it("moves a group up and down, and stops at the ends", () => {
    click(groupCards()[1]!.querySelector(".move-up"));
    expect(groupCards().map(nameOf)).toEqual(["Extra dips", "Seasoning"]);

    click(groupCards()[0]!.querySelector(".move-down"));
    expect(editor.value().map((group) => group.name)).toEqual(["Seasoning", "Extra dips"]);

    expect((groupCards()[0]!.querySelector(".move-up") as HTMLButtonElement).disabled).toBe(true);
    expect((groupCards()[1]!.querySelector(".move-down") as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves a choice within its group only", () => {
    click(choiceRows(groupCards()[1]!)[2]!.querySelector(".move-up"));

    expect(editor.value()[1].choices.map((choice: any) => choice.id)).toEqual([
      "tartar",
      "chilli",
      "curry_sauce",
      "gravy",
      "garlic_aioli",
    ]);
    expect(editor.value()[0].choices).toHaveLength(5);
  });

  it("keeps a half-typed name through a redraw somewhere else", () => {
    type(groupCards()[0]!.querySelector(".option-name")!, "Seasonin");
    click(root.querySelector(".add-group"));

    expect(nameOf(groupCards()[0]!)).toBe("Seasonin");
  });

  it("treats a price cleared to nothing as free rather than as an error", () => {
    // The field is a number input, so it holds a number or it holds nothing —
    // typing words into it leaves it empty. Empty is a free choice, which is
    // what most of them are.
    type(choiceRows(groupCards()[1]!)[0]!.querySelector(".choice-price input")!, "");

    expect(editor.value()[1].choices[0]).toMatchObject({ id: "tartar", priceDeltaSen: 0 });
  });

  it("rounds ringgit to whole sen rather than letting a fraction through", () => {
    // 1.15 * 100 is not exactly 115 in binary, and half a sen an option adds up
    // across a service. The store rejects a fraction outright, so this is what
    // stops a save failing on arithmetic nobody typed.
    type(choiceRows(groupCards()[1]!)[0]!.querySelector(".choice-price input")!, "1.15");

    expect(editor.value()[1].choices[0]!.priceDeltaSen).toBe(115);
  });
});

describe("an option that takes money off", () => {
  it("shows the combo's mineral water at -1.00 and saves it back untouched", async () => {
    const combo = await staffItem(COMBO);
    editor.load(combo.optionGroups);

    const drinks = groupCards().find((card) => nameOf(card) === "Pick your drink")!;
    const water = choiceRows(drinks).find((row) => choiceName(row) === "Mineral water")!;
    expect(choicePrice(water)).toBe("-1.00");
    // The field is not clamped at zero for this one, so it can be saved back.
    expect((water.querySelector(".choice-price input") as HTMLInputElement).getAttribute("min")).toBeNull();

    const response = await fetch(`${base}/api/staff/menu-items/${COMBO}`, {
      method: "PUT",
      body: form({ optionGroups: JSON.stringify(editor.value()) }),
    });
    expect(response.status).toBe(200);
    expect((await staffItem(COMBO)).optionGroups).toEqual(combo.optionGroups);
  });

  it("clamps every other price field at zero", async () => {
    editor.load((await staffItem(DORY)).optionGroups);
    const prices = [...root.querySelectorAll(".choice-price input")] as HTMLInputElement[];

    expect(prices.every((input) => input.getAttribute("min") === "0")).toBe(true);
  });
});

describe("the menu page wires it in", () => {
  const html = () => readFileSync(resolve(staffDir, "menu.html"), "utf8");

  it("imports the builder and mounts it in the form", () => {
    const page = html();
    expect(page).toContain("assets/optionGroups.js");
    expect(page).toContain('id="option-groups"');
    expect(page).toContain("optionGroupsEditor(document.getElementById(\"option-groups\"))");
  });

  it("loads the item's own groups when the form opens, and posts them on save", () => {
    const page = html();
    expect(page).toContain("options.load(item?.optionGroups ?? [])");
    expect(page).toContain('body.set("optionGroups", JSON.stringify(optionGroups))');
  });

  it("keeps the module importable on its own, with no page-level globals", () => {
    // It is loaded as a module by the page and by these tests; anything it
    // reached for on `window` would work in one and not the other.
    const source = readFileSync(resolve(staffDir, "assets/optionGroups.js"), "utf8");
    expect(source).not.toMatch(/\bwindow\./);
    expect(source).toContain('import { el } from "./common.js"');
    expect(editorUrl).toContain("optionGroups.js");
  });
});

/** What the staff form sends: multipart, with the builder as one JSON field. */
function form(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}
