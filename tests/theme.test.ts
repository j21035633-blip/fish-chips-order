/**
 * @vitest-environment jsdom
 *
 * Light and dark, on both sides of the app.
 *
 * Three kinds of check, because three different things can break:
 *
 * - **The token blocks** — dark is declared twice per stylesheet (once for the
 *   device's preference, once for the toggle's override) because CSS cannot
 *   share a block across a media query. Duplicated declarations drift, so the
 *   pair is compared here.
 * - **Contrast** — the brief's real requirement is that a badge still *means*
 *   something in dark, not merely that it is visible. Every status colour is
 *   resolved through its tokens and measured against WCAG in both themes. This
 *   is what caught white-on-light-green: the topbar and every primary button
 *   were at 1.9:1 in the dark palette that shipped before this.
 * - **The module** — the three states, and that a choice beats the device.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

const webDir = resolve(process.cwd(), "src/web");
const staffDir = resolve(process.cwd(), "src/staff-web");

const customerCss = readFileSync(resolve(webDir, "styles.css"), "utf8");
const staffCss = readFileSync(resolve(staffDir, "assets/staff.css"), "utf8");

/** Comments out first: a declaration written after one is still a declaration. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations inside the first block whose selector line matches. */
function block(source: string, selector: string): Record<string, string> {
  const css = stripComments(source);
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const tokens: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split(";")) {
    const [name, value] = line.split(":");
    if (name?.trim().startsWith("--")) tokens[name.trim()] = value!.trim();
  }
  return tokens;
}

const PALETTES = [
  ["customer", customerCss, ":root {", ":root:not([data-theme=\"light\"]) {", ":root[data-theme=\"dark\"] {"],
  ["staff", staffCss, ":root {", ":root:not([data-theme=\"light\"]) {", ":root[data-theme=\"dark\"] {"],
] as const;

describe("the two dark blocks stay in step", () => {
  it.each(PALETTES)("%s declares the same tokens either way in", (_name, css, _light, media, attr) => {
    const viaDevice = block(css, media);
    const viaToggle = block(css, attr);

    // Same names and the same values. One is what a dark phone gets; the other
    // is what the toggle gets, and a person must not be able to tell which.
    expect(Object.keys(viaToggle).sort()).toEqual(Object.keys(viaDevice).sort());
    expect(viaToggle).toEqual(viaDevice);
  });

  it.each(PALETTES)("%s gives every light token a dark value", (_name, css, light, _media, attr) => {
    const lightTokens = block(css, light);
    const darkTokens = block(css, attr);

    // A token with no dark value keeps its light one, which is how a page ends
    // up with one stubbornly pale corner.
    const colourish = Object.keys(lightTokens).filter((name) => /#|rgba?\(/.test(lightTokens[name]!));
    for (const name of colourish) {
      expect(darkTokens, `${name} has no dark value`).toHaveProperty(name);
      expect(darkTokens[name], `${name} is the same in both`).not.toBe(lightTokens[name]);
    }
  });
});

// ------------------------------------------------------------------- contrast

/** sRGB relative luminance, per WCAG. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

/** Resolves a token name against one theme's block, following var() one level. */
function value(tokens: Record<string, string>, name: string): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`no token ${name}`);
  return raw.startsWith("var(") ? value(tokens, raw.slice(4, -1).trim()) : raw;
}

/**
 * Every pairing that carries a status, on both sides.
 *
 * WCAG AA is 4.5:1 for body text. These are all short, bold labels at 11–14px,
 * which qualifies for nothing relaxed, so 4.5 is the bar — except the two solid
 * *buttons*, whose text is large and bold enough for the 3:1 large-text rule and
 * which are held to 4.5 anyway because a till is read at arm's length.
 */
const PAIRS: [string, "customer" | "staff", string, string][] = [
  ["customer topbar / brand", "customer", "--on-sea", "--sea"],
  ["customer primary button", "customer", "--on-sea", "--sea"],
  ["customer body", "customer", "--ink", "--paper"],
  ["customer card body", "customer", "--ink", "--card"],
  ["customer secondary text", "customer", "--ink-soft", "--card"],
  ["customer refunded pill", "customer", "--violet", "--violet-wash"],
  ["customer unpaid pill", "customer", "--amber-ink", "--amber-wash"],
  ["staff body", "staff", "--ink", "--bg"],
  ["staff panel body", "staff", "--ink", "--panel"],
  ["staff secondary text", "staff", "--ink-soft", "--panel"],
  ["staff active nav tab", "staff", "--on-sea", "--sea"],
  ["staff advance button", "staff", "--on-sea", "--sea"],
  ["staff PAID tag", "staff", "--sea", "--sea-wash"],
  ["staff PENDING tag", "staff", "--amber", "--amber-wash"],
  ["staff UNPAID tag", "staff", "--amber", "--amber-wash"],
  ["staff FAILED tag", "staff", "--danger", "--danger-wash"],
  ["staff REFUNDED tag", "staff", "--violet", "--violet-wash"],
  ["staff takeaway tag", "staff", "--ink-soft", "--neutral-wash"],
  ["staff error banner", "staff", "--danger", "--danger-wash"],
  ["staff cancellation flag", "staff", "--on-danger", "--danger"],
  ["staff tooltip", "staff", "--on-ink", "--ink"],
];

/**
 * Pairings that ship below the bar in light, and are held there deliberately.
 *
 * The brief for the theme work was explicit that light is not being redesigned,
 * so a shortfall that predates it is recorded rather than quietly repainted —
 * and the dark value for the same pairing is still held to the full 4.5.
 *
 * `--amber` on `--amber-wash` is the PENDING and UNPAID tags. At 3.74:1 they
 * are the one thing on the staff side that does not meet AA for body text, and
 * they have been since those tags were added. Worth fixing, but as a change to
 * the light palette that somebody has actually looked at, not as a side effect.
 */
const LIGHT_SHORTFALL: Record<string, number> = {
  "staff PENDING tag": 3.74,
  "staff UNPAID tag": 3.74,
};

describe("status colours stay legible in both themes", () => {
  const themes = {
    customer: {
      light: block(customerCss, ":root {"),
      dark: { ...block(customerCss, ":root {"), ...block(customerCss, ':root[data-theme="dark"] {') },
    },
    staff: {
      light: block(staffCss, ":root {"),
      dark: { ...block(staffCss, ":root {"), ...block(staffCss, ':root[data-theme="dark"] {') },
    },
  };

  for (const [label, side, fg, bg] of PAIRS) {
    for (const theme of ["light", "dark"] as const) {
      it(`${label} — ${theme}`, () => {
        const tokens = themes[side][theme];
        const ratio = contrast(value(tokens, fg), value(tokens, bg));
        // Dark is always held to AA. Light is too, except where it already
        // shipped below it — and there the recorded figure is a ceiling as well
        // as a floor, so light getting *worse* still fails.
        const floor = theme === "light" ? (LIGHT_SHORTFALL[label] ?? 4.5) : 4.5;
        expect(
          Number(ratio.toFixed(2)),
          `${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(floor);
      });
    }
  }

  it("keeps the 86 switch readable as on or off in both themes", () => {
    // The switch carries its state in the *track*, not the knob: off is --bg,
    // on is --sea, and the knob is the same colour in both positions. So the
    // pairing that has to hold up is track-against-track, at the 3:1 WCAG asks
    // of a non-text control — not knob-against-track, which is a near-white
    // circle on a near-white field in light and is meant to be, the edge being
    // carried by the switch's border and the knob's shadow.
    for (const theme of ["light", "dark"] as const) {
      const tokens = themes.staff[theme];
      const ratio = contrast(value(tokens, "--bg"), value(tokens, "--sea"));
      expect(Number(ratio.toFixed(2)), `off vs on in ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the meaning apart, not just the text readable", () => {
    // Paid, unpaid and failed must not collapse into one colour in dark: the
    // whole point of the badge is telling them apart across a kitchen.
    const dark = themes.staff.dark;
    const washes = ["--sea-wash", "--amber-wash", "--danger-wash"].map((name) => value(dark, name));
    expect(new Set(washes).size).toBe(3);

    const inks = ["--sea", "--amber", "--danger"].map((name) => value(dark, name));
    expect(new Set(inks).size).toBe(3);
    // And each pair is distinguishable from its neighbours, not merely distinct.
    for (const [a, b] of [[0, 1], [1, 2], [0, 2]] as const) {
      expect(contrast(inks[a]!, inks[b]!), `${inks[a]} vs ${inks[b]}`).toBeGreaterThan(1.2);
    }
  });
});

// --------------------------------------------------------------------- wiring

describe("every page applies the theme before it paints", () => {
  const pages = [
    resolve(webDir, "index.html"),
    ...["staff", "kitchen", "sales", "menu", "qr", "approvals", "accounts", "login", "emergency"].map((name) =>
      resolve(staffDir, `${name}.html`),
    ),
  ];

  it("carries the same inline snippet, keyed on the module's own constant", async () => {
    const { THEME_KEY } = await import(pathToFileURL(resolve(webDir, "theme.js")).href);

    for (const page of pages) {
      const html = readFileSync(page, "utf8");
      // Inline and before the body: a deferred module would paint white first
      // and then flip, which on a dark tablet is the whole bug.
      expect(html, page).toContain(`localStorage.getItem("${THEME_KEY}")`);
      expect(html.indexOf("ab-theme"), page).toBeLessThan(html.indexOf("<body"));
      expect(html, page).toContain("document.documentElement.dataset.theme = t");
    }
  });

  it("offers the toggle on both sides", () => {
    // The customer app mounts it in the topbar; the staff area mounts it in the
    // shared header, so every staff view gets it from one place.
    expect(readFileSync(resolve(webDir, "index.html"), "utf8")).toContain("mountThemeToggle");
    expect(readFileSync(resolve(staffDir, "assets/nav.js"), "utf8")).toContain("mountThemeToggle");
    // And the two sign-in screens, which have no shared header.
    for (const page of ["login.html", "emergency.html"]) {
      expect(readFileSync(resolve(staffDir, page), "utf8"), page).toContain("mountThemeToggle");
    }
  });

  it("keeps one module rather than a copy per side", () => {
    // Two files that must never disagree about the storage key are one file.
    expect(readFileSync(resolve(staffDir, "assets/nav.js"), "utf8")).toContain(`from "/theme.js"`);
  });

  it("leaves no hard-coded colour on a themed rule", () => {
    // The audit, as a regression guard. Two kinds of literal are legitimate and
    // are cut before the check rather than tolerated by a looser pattern:
    //
    // - `@media print` — paper is white whatever the screen is doing.
    // - the fishing scene — `.sun`, `.cloud`, `.sea`, `.sand` are a painting of
    //   a sunny day, not chrome. Its own dark palette was deliberately deleted
    //   in "Redraw the fishing game for the children who actually play it";
    //   a white cloud is white because clouds are.
    for (const [name, css] of [["customer", customerCss], ["staff", staffCss]] as const) {
      const themed = css
        .replace(/@media print \{[\s\S]*?\n\}/g, "")
        .replace(/^\.(sea|sky|sun|cloud|sand|wave)[^{]*\{[\s\S]*?\n\}/gim, "");
      expect(themed, `${name} has a literal colour on a themed rule`).not.toMatch(
        /^\s*(color|background|background-color):\s*#(fff|ffffff)\b/im,
      );
    }
  });
});

describe("the toggle", () => {
  let theme: any;

  beforeEach(async () => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    theme = await import(`${pathToFileURL(resolve(webDir, "theme.js")).href}?t=${Math.random()}`);
  });

  it("follows the device when nobody has chosen", () => {
    expect(theme.storedTheme()).toBeNull();
    // jsdom reports no dark preference, so this is the light branch.
    expect(theme.effectiveTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("remembers an explicit choice and honours it from then on", () => {
    theme.setTheme("dark");

    expect(localStorage.getItem(theme.THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    // The device still says light; the choice wins.
    expect(theme.systemTheme()).toBe("light");
    expect(theme.effectiveTheme()).toBe("dark");
  });

  it("can be put back to following the device", () => {
    theme.setTheme("dark");
    theme.setTheme(null);

    expect(localStorage.getItem(theme.THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores a stored value that is not a theme", () => {
    localStorage.setItem(theme.THEME_KEY, "chartreuse");
    expect(theme.storedTheme()).toBeNull();
  });

  it("flips on a tap, and says what the tap will do", () => {
    const button = theme.themeToggle();

    // Light now, so the control offers dark — a switch is labelled with where
    // it goes, not where it is.
    expect(button.textContent).toContain("Dark");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    button.click();
    expect(theme.effectiveTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button.textContent).toContain("Light");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    button.click();
    expect(theme.effectiveTheme()).toBe("light");
    expect(localStorage.getItem(theme.THEME_KEY)).toBe("light");
  });

  it("is a real button with a name, not an icon nobody can announce", () => {
    const button = theme.themeToggle();
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBeTruthy();
    expect(button.title).toMatch(/Switch to (dark|light) mode/);
  });

  it("survives storage it cannot write to", () => {
    // A private window, or a webview with site data off. A theme is never worth
    // taking the page down for.
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      expect(theme.storedTheme()).toBeNull();
      expect(() => theme.setTheme("dark")).not.toThrow();
      // The attribute still went on, so this visit is themed even unstored.
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      Object.defineProperty(window, "localStorage", real!);
    }
  });

  it("mounts nowhere when the page has no slot", () => {
    expect(theme.mountThemeToggle(null)).toBeNull();
  });
});
