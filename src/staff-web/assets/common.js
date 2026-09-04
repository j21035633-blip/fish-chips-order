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

/**
 * Sends the browser to the sign-in screen, remembering where it was.
 *
 * Latched, because the board polls every two seconds: without the flag an
 * expired session would fire a redirect per tick, and the in-flight requests
 * that land during the navigation would each fire another.
 */
let redirecting = false;

export function redirectToLogin() {
  if (redirecting) return;
  // Nothing to redirect to from the login page itself — that would loop.
  if (document.body.dataset.staffView === "login") return;

  redirecting = true;
  const base = document.body.dataset.staffBase ?? "";
  location.replace(`${base}/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

/** Throws with the server's own message, so a 400 explains itself on screen. */
export async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));

  // The session expired, or the password was rotated mid-shift. Sending them
  // to sign in again is the only useful answer; the thrown error still stops
  // the caller from carrying on as though the request had worked.
  if (response.status === 401) {
    redirectToLogin();
    throw new Error(body.message ?? "Session expired. Sign in again.");
  }

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
export function orderFeed({
  onData,
  onError,
  onState,
  // The board is the usual caller, so it is the default; the approvals queue
  // points the same poller at its own endpoint rather than growing a second one.
  path = "/api/staff/overview",
  intervalMs = 2000,
  staleAfterMs = 8000,
  maxIntervalMs = 30000,
  requestTimeoutMs = 10000,
}) {
  let lastOk = 0;
  let timer = null;
  let polling = false;
  let failures = 0;
  let stopped = false;

  /**
   * Says what has happened, never what is about to.
   *
   * The old version reported staleness in the same synchronous breath as firing
   * the request, so the first tick always read `lastOk === 0` and painted a red
   * "not updating" over a board that was drawing correctly two hundred
   * milliseconds later. The indicator was a tick behind the truth on every page
   * load and every navigation between staff pages.
   */
  function report() {
    onState?.(lastOk !== 0 && Date.now() - lastOk <= staleAfterMs ? "live" : "stale");
  }

  async function refresh() {
    // A request that never answers is the one failure a poller cannot see: no
    // response, no error, and the next poll never gets scheduled. Give it a
    // deadline so a dead connection becomes a normal failure.
    const options = {};
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(requestTimeoutMs);
    }

    const data = await api(path, options);
    lastOk = Date.now();
    failures = 0;
    onData(data);
    report();
    return data;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(poll, delay);
  }

  /**
   * One poll, then the next is scheduled — a chain rather than an interval.
   *
   * `setInterval` fires on the clock whether or not the last request came back,
   * so a slow connection during service stacks requests on a tablet that is
   * already struggling. This cannot overlap with itself.
   */
  async function poll() {
    if (polling) return;
    polling = true;

    try {
      await refresh();
    } catch (error) {
      failures += 1;
      onError?.(error);
      report();
    } finally {
      polling = false;
      // Back off while it is down — a kitchen tablet hammering a dead server
      // every two seconds helps nobody — and snap straight back on the first
      // success, because `failures` resets there.
      const backoff = Math.min(intervalMs * 2 ** Math.min(failures, 4), maxIntervalMs);
      schedule(failures === 0 ? intervalMs : backoff);
    }
  }

  /**
   * Catch up the moment the tablet is usable again.
   *
   * This is the one that matters during service. A browser throttles timers in
   * a background tab and stops them on a locked screen, so a tablet picked up
   * after ten minutes would otherwise sit on stale orders until its next
   * scheduled poll — which, after backoff, could be half a minute away.
   */
  function wake() {
    if (stopped) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    report();
    failures = 0;
    schedule(0);
  }

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);

  report();
  void poll();

  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
    },
  };
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

/**
 * How a ticket announces itself on the boards.
 *
 * Three cases, and the distinction that matters to a cook is the first one:
 * food that goes to a table, versus food someone is waiting at the counter for.
 * A staff-rung takeaway has the number that gets called out; a QR order with no
 * table is the same kind of thing without one.
 */
export function orderLabel(order) {
  if (order.tableNumber) return { text: `Table ${order.tableNumber}`, takeaway: false };
  if (order.takeawayNumber) return { text: `Takeaway #${order.takeawayNumber}`, takeaway: true };
  return { text: "Counter / takeaway", takeaway: true };
}

/** The badge that marks a ticket as not going to a table. */
export function takeawayTag() {
  return el("span", { class: "tag takeaway-tag", text: "Takeaway" });
}
