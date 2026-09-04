// Helpers shared by the three staff views. No framework and no build step: this
// runs on whatever tablet is wedged next to the fryer.

/** Builds an element. Text goes in via textContent, never innerHTML. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Same for SVG, which needs the namespaced constructor. */
export function svgEl(tag, props = {}, children = []) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Throws with the server's own message, so a 400 explains itself on screen. */
export async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  return body;
}

/** A page-level error banner. Pass nothing to clear it. */
export function errorBanner(id = "error") {
  const node = document.getElementById(id);
  return (message) => {
    if (message) node.textContent = message;
    node.hidden = !message;
  };
}

/**
 * The shared live feed: `/api/staff/overview`, polled.
 *
 * Short polling rather than a websocket, as the board has always done — one
 * shop, one process, and a dropped socket on a kitchen tablet that silently
 * stops updating is worse than a request every two seconds. `onState` reports
 * staleness so a stall is visible rather than leaving the view quietly frozen.
 */
export function orderFeed({ onData, onError, onState, intervalMs = 2000, staleAfterMs = 8000 }) {
  let lastOk = 0;
  let timer;

  async function refresh() {
    const data = await api("/api/staff/overview");
    lastOk = Date.now();
    onData(data);
  }

  function tick() {
    refresh().catch((error) => onError?.(error));
    const stale = lastOk === 0 || Date.now() - lastOk > staleAfterMs;
    onState?.(stale ? "stale" : "live");
  }

  tick();
  timer = setInterval(tick, intervalMs);

  return { refresh, stop: () => clearInterval(timer) };
}

/** Formats `YYYY-MM-DD` for an axis or a table: "Wed 3 Sep". */
export function shortDay(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
