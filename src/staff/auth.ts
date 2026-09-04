import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { config } from "../config/env.js";

/**
 * The staff gate: one shared password for everyone behind the counter.
 *
 * Deliberately not per-user accounts. There is one shop, one shared tablet on
 * the pass and a till nobody logs into either; individual logins would be
 * ceremony that ends with the password written on the wall anyway. What this
 * buys is the thing the unguessable path never could: `/api/staff/*` stops
 * being as open as the customer API, and that now covers menu writes and file
 * uploads, not just a status toggle.
 *
 * No JWT library, because nothing here needs one. The session is a payload and
 * an HMAC over it — the same primitive the Revenue Monster signing already
 * uses — and it is *not* a bearer token for third parties to read: it is a
 * cookie this server issues to itself.
 */

/** Name of the cookie the session lives in. */
export const STAFF_SESSION_COOKIE = "staff_session";

/**
 * Twelve hours: longer than the longest shift, so nobody is thrown out mid
 * service, and short enough that a tablet left on the pass overnight has to be
 * signed in again in the morning.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Paths under `/api/staff` that must stay reachable without a session. */
const OPEN_PATHS = new Set(["/login", "/logout", "/session"]);

export interface StaffSession {
  /** Seconds since the epoch, as in a JWT — both are integers, so both compare cleanly. */
  iat: number;
  exp: number;
}

/** False when `STAFF_PASSWORD` is unset: the gate is off and everything below is open. */
export function staffAuthEnabled(): boolean {
  return config.staffPassword !== undefined;
}

/**
 * Constant-time password check.
 *
 * Both sides are hashed first so the comparison is over two 32-byte digests:
 * `timingSafeEqual` throws on a length mismatch, and taking that shortcut would
 * leak the length of the real password to anyone watching the error.
 */
export function passwordMatches(candidate: string): boolean {
  const expected = config.staffPassword;
  if (expected === undefined) return false;
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

/**
 * The signing key, derived from the password itself rather than configured
 * separately.
 *
 * Two consequences worth wanting: there is no second secret to forget to set,
 * and changing `STAFF_PASSWORD` invalidates every session issued under the old
 * one — which is exactly what you want on the day someone leaves. It survives a
 * restart, so a redeploy does not sign the whole kitchen out.
 */
function sessionKey(): Buffer {
  return createHash("sha256").update(`fish-chips-order:staff-session:v1:${config.staffPassword ?? ""}`).digest();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", sessionKey()).update(payload).digest("base64url");
}

/** A fresh session token, valid from now. */
export function issueSession(now = Date.now()): string {
  const session: StaffSession = {
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + SESSION_TTL_MS) / 1000),
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Reads a token back, or `undefined` if it was tampered with, signed under a
 * different password, or has expired. Never throws: every failure here is just
 * "not signed in".
 */
export function readSession(token: string | undefined, now = Date.now()): StaffSession | undefined {
  if (token === undefined) return undefined;

  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined) return undefined;

  const expected = Buffer.from(sign(payload), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (typeof session?.exp !== "number" || session.exp * 1000 <= now) return undefined;
    return session;
  } catch {
    // A signature that verifies over a payload that is not JSON should not be
    // reachable, but a parse error is still just "not signed in".
    return undefined;
  }
}

/** Whether this request carries a session cookie that checks out. */
export function hasStaffSession(req: Request): boolean {
  return readSession(readCookie(req, STAFF_SESSION_COOKIE)) !== undefined;
}

/** Whether this request may see the staff area at all — true throughout when the gate is off. */
export function staffAccessAllowed(req: Request): boolean {
  return !staffAuthEnabled() || hasStaffSession(req);
}

/**
 * Cookie options, in one place so login and logout cannot disagree — a
 * mismatched `path` would leave a cookie that logout silently fails to clear.
 *
 * `path: "/"` because the cookie has two consumers under different prefixes:
 * the pages at `STAFF_DASHBOARD_PATH` and the API at `/api/staff`. `httpOnly`
 * keeps it out of reach of any script on the page, which is the point of using
 * a cookie rather than localStorage. `secure` follows the public URL's scheme,
 * so local http development still works.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicBaseUrl.startsWith("https://"),
    path: "/",
  };
}

/** Express 4 does not parse cookies, and one header read is cheaper than a dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * The gate on `/api/staff/*`.
 *
 * Mounted at the prefix rather than listed per route, so a route added later is
 * protected by default: forgetting to opt in is the failure mode that leaves a
 * hole, and forgetting to opt *out* only breaks the login page loudly. The
 * exemptions are checked here rather than relying on mount order, so moving the
 * routes around cannot quietly open one.
 */
export function requireStaffApi(req: Request, res: Response, next: NextFunction): void {
  if (OPEN_PATHS.has(req.path) || staffAccessAllowed(req)) {
    next();
    return;
  }
  // 401 rather than 404: the pages' fetch wrapper turns exactly this into a
  // redirect to the login screen when a session expires mid-service.
  res.status(401).json({ error: "staff_auth_required", message: "Sign in to use the staff area." });
}

/**
 * The gate on the staff *pages*. Redirects rather than 401s, because this is a
 * browser navigation and a bare 401 body is not something anyone can act on.
 *
 * Server-side on purpose: a guard that runs in the page's own script can only
 * hide a view that has already been sent. This is what makes the redirect a
 * real gate rather than a cosmetic one.
 */
export function requireStaffPage(req: Request, res: Response, next: NextFunction): void {
  if (staffAccessAllowed(req)) {
    next();
    return;
  }
  res.redirect(302, `${config.staffDashboardPath}/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/**
 * Failed-attempt throttle, per client address.
 *
 * A single shared password on a public URL is guessable at machine speed
 * otherwise. In-memory and per-process, which is the right size for one shop on
 * one dyno; it is a speed bump for online guessing, not a defence against a
 * password that has leaked.
 */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 10 * 60 * 1000;

interface Attempts {
  count: number;
  first: number;
}

const failures = new Map<string, Attempts>();

/** How long this caller must wait, in seconds. Zero means "go ahead". */
export function loginRetryAfter(key: string, now = Date.now()): number {
  const record = failures.get(key);
  if (record === undefined) return 0;
  if (now - record.first >= LOCKOUT_MS) {
    failures.delete(key);
    return 0;
  }
  if (record.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((record.first + LOCKOUT_MS - now) / 1000);
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  const record = failures.get(key);
  if (record === undefined || now - record.first >= LOCKOUT_MS) {
    // Keep the map from growing without bound on a deployment someone is
    // scanning: an expired window is cheap to drop and holds nothing worth
    // keeping.
    for (const [existing, value] of failures) {
      if (now - value.first >= LOCKOUT_MS) failures.delete(existing);
    }
    failures.set(key, { count: 1, first: now });
    return;
  }
  record.count += 1;
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** Test seam. Nothing in the app calls this. */
export function resetLoginThrottle(): void {
  failures.clear();
}

/** The throttle's bucket. `req.ip` is undefined behind some proxies; one shared bucket is the safe fallback. */
export function throttleKey(req: Request): string {
  return req.ip ?? "unknown";
}
