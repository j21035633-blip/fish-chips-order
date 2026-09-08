import { api, el } from "./common.js";
import { askStaff } from "./attribution.js";

/**
 * The "Who's on duty" pill, on both boards.
 *
 * A note on the wall, not a gate. Nothing anywhere is blocked on it: the boards,
 * Quick Add and settling all work exactly the same whether somebody has tapped
 * this or not. What it buys is the answer to "who was on at four o'clock", which
 * a shop with one tablet and one shared login has no other way to give.
 *
 * Its state lives on the server, not in this browser, so it survives a reload
 * and is the same on every tablet — which is the point of it. It is polled
 * slowly because it changes a few times a day, not a few times a minute.
 *
 * Checking in reuses `askStaff`, the same sheet the till uses to name a cashier:
 * one place knows how to ask for an id and a name and how to show the server
 * refusing them.
 */

/** Slow on purpose. A shift changes hands a few times a day. */
const POLL_MS = 30_000;

export function onDutyWidget() {
  const label = el("span", { class: "on-duty-label", text: "…" });
  const action = el("button", { class: "on-duty-action", type: "button", hidden: true });
  const pill = el("div", { class: "on-duty", "aria-live": "polite" }, [label, action]);

  let current = null;
  let busy = false;

  function draw() {
    pill.className = current ? "on-duty on" : "on-duty";
    label.textContent = current ? current.name : "Not checked in";
    action.textContent = current ? "Check out" : "Check in";
    action.hidden = false;
    action.disabled = busy;
    action.setAttribute(
      "aria-label",
      current ? `Check ${current.name} out of this device` : "Check in to this device",
    );
  }

  async function load() {
    try {
      const { checkIn } = await api("/api/staff/checkin/current");
      current = checkIn;
      draw();
    } catch {
      // A board whose poll is failing already says so in the feed indicator.
      // Saying it twice, in a pill about something informational, is noise.
    }
  }

  async function checkIn() {
    await askStaff({
      title: "Who is on duty?",
      detail: current
        ? `${current.name} is checked in. Whoever checks in next takes over from them.`
        : "This is a shift note for the shared tablet. It does not sign anybody in.",
      onConfirm: async ({ staffId, staffName }) => {
        const { checkIn: started } = await api("/api/staff/checkin", {
          method: "POST",
          body: JSON.stringify({ staffId, name: staffName }),
        });
        current = started;
      },
    });
    draw();
  }

  async function checkOut() {
    busy = true;
    draw();
    try {
      const { checkIn } = await api("/api/staff/checkout", { method: "POST" });
      current = checkIn;
    } catch {
      // Same reasoning as `load`: this is a note, not an action anybody is
      // blocked on. The next poll will put it right.
    } finally {
      busy = false;
      draw();
    }
  }

  action.addEventListener("click", () => {
    if (busy) return;
    void (current ? checkOut() : checkIn());
  });

  draw();
  void load();

  const timer = setInterval(() => void load(), POLL_MS);
  // A tablet's timers stop on a locked screen, so the shift could have changed
  // hands entirely while it was face down. Same reasoning as `orderFeed`.
  const onWake = () => {
    if (document.visibilityState === "visible") void load();
  };
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("focus", onWake);

  return {
    node: pill,
    refresh: load,
    stop() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    },
  };
}

/** "2 h 15 min", or "on now" for a shift nobody has closed yet. */
export function shiftLength(record, now = Date.now()) {
  if (!record.checkedInAt) return "";
  const end = record.checkedOutAt ? new Date(record.checkedOutAt).getTime() : now;
  const minutes = Math.max(0, Math.round((end - new Date(record.checkedInAt).getTime()) / 60000));

  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * A wall-clock time for the log.
 *
 * Date only when it is not today: a shift log read on the day should say
 * "14:05", and one read a week later has to say which day it was.
 */
export function shiftTime(iso, now = new Date()) {
  if (!iso) return "—";
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}
