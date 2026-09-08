/**
 * Light and dark, for the customer app and the staff area both.
 *
 * **One module, served from the customer web root at `/theme.js`.** The staff
 * pages import it by that absolute path rather than getting a copy of their own:
 * the two sides have to agree on the storage key and on the three states, and
 * two files that must never disagree are one file.
 *
 * Three states, not two:
 *
 * - **nothing stored** — follow the device. `data-theme` is absent and the
 *   stylesheets' `prefers-color-scheme` block decides, which is what the
 *   customer app already did before there was a toggle.
 * - **`data-theme="dark"` / `"light"`** — somebody chose, and their choice wins
 *   over the device from then on.
 *
 * Per browser, never per account: a customer's phone and the tablet on the pass
 * remember their own, and signing in or out does not touch either.
 *
 * The value is applied **before first paint** by a small inline script in each
 * page's `<head>` — see `THEME_KEY`. It cannot be done from here: a module is
 * deferred, so a dark-preferring tablet would flash white first.
 */

/** The one localStorage key. The inline head snippets must use this same string. */
export const THEME_KEY = "ab-theme";

const THEMES = ["light", "dark"];

/**
 * Reads the explicit choice, or null for "follow the device".
 *
 * Storage throws in a private window and in some embedded webviews, and a theme
 * is never worth taking a page down for.
 */
export function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** What the device asks for, when nobody has chosen. */
export function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

/** What is actually on screen: the choice if there is one, the device if not. */
export function effectiveTheme() {
  return storedTheme() ?? systemTheme();
}

/**
 * Applies a choice, or clears it back to following the device.
 *
 * The attribute is what the stylesheets key on; storage is only how it survives
 * a reload. Both move together here so they cannot drift apart.
 */
export function setTheme(theme) {
  const root = document.documentElement;
  if (theme === null) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }

  try {
    if (theme === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Unwritable storage. The page is themed for this visit and forgets after.
  }
}

/**
 * The toggle itself: one button, sun or moon.
 *
 * The icon shows **what tapping it will do** rather than what is on screen —
 * a moon means "go dark". That is the way a light switch works, and it is the
 * reading people check against by pressing it once.
 *
 * While nobody has chosen, it keeps following the device: if the tablet flips to
 * dark at sunset the icon flips with it. The first tap ends that and stores a
 * choice, which is what was asked for.
 */
export function themeToggle({ label = "Appearance" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-toggle";
  button.setAttribute("aria-label", label);

  const icon = document.createElement("span");
  icon.className = "theme-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "theme-toggle-text";
  button.append(icon, text);

  function draw() {
    const now = effectiveTheme();
    const next = now === "dark" ? "light" : "dark";
    icon.textContent = next === "dark" ? "☾" : "☀";
    text.textContent = next === "dark" ? "Dark" : "Light";
    button.title = `Switch to ${next} mode`;
    button.setAttribute("aria-pressed", now === "dark" ? "true" : "false");
    button.dataset.theme = now;
  }

  button.addEventListener("click", () => {
    setTheme(effectiveTheme() === "dark" ? "light" : "dark");
    draw();
  });

  // Only matters while nothing is stored; once somebody has chosen, `draw`
  // reads their choice and the device's opinion stops changing the answer.
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", draw);

  draw();
  return button;
}

/**
 * Puts the toggle in a container, if the page has one.
 *
 * Returns the button or null, so a page without the slot is a no-op rather than
 * a thrown error on load.
 */
export function mountThemeToggle(container, options) {
  if (!container) return null;
  const button = themeToggle(options);
  container.append(button);
  return button;
}
