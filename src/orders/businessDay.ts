/**
 * "Today" for the sales total.
 *
 * A calendar day in the shop's own timezone, not the server's — Railway runs in
 * UTC, and a shop in Kuala Lumpur closing at 22:00 would otherwise see its
 * evening trade land on tomorrow's total.
 *
 * Days are compared as `YYYY-MM-DD` strings rather than by arithmetic on
 * instants, which keeps DST and offset changes the formatter's problem.
 */

/** The business day an instant falls in, as `YYYY-MM-DD` in the shop's zone. */
export function businessDay(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`"${String(instant)}" is not a date.`);
  }
  // `en-CA` formats as YYYY-MM-DD, which sorts and compares as a plain string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * The UTC instants bounding a business day, as ISO strings.
 *
 * `[start, end)` — end is the first instant of the next day, so a query is a
 * half-open range and an order paid at exactly midnight belongs to one day only.
 *
 * Found by search rather than by offset arithmetic: the offset for a given zone
 * is itself a function of the date, so assuming one is how DST bugs start.
 */
export function businessDayRange(day: string, timeZone: string): { start: string; end: string } {
  return {
    start: firstInstantOf(day, timeZone),
    end: firstInstantOf(nextDay(day), timeZone),
  };
}

/** Midnight at the start of `day` in `timeZone`, as a UTC ISO string. */
function firstInstantOf(day: string, timeZone: string): string {
  // Midnight local is within a day of midnight UTC for every real zone, so start
  // from UTC midnight and step to the exact boundary.
  const guess = new Date(`${day}T00:00:00Z`);

  for (const stepMinutes of [720, 60, 15, 1]) {
    const step = stepMinutes * 60_000;
    // Walk back while we are still in `day` or later, then forward to the edge.
    while (businessDay(guess, timeZone) >= day) guess.setTime(guess.getTime() - step);
    while (businessDay(guess, timeZone) < day) guess.setTime(guess.getTime() + step);
  }

  return guess.toISOString();
}

function nextDay(day: string): string {
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
