import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { config } from "../config/env.js";
import { NAV_SECTIONS, type SectionKey } from "./roles.js";

/**
 * The staff gate: each person signs in as themselves, and their role says what
 * they can reach.
 *
 * This used to be one password the whole shop shared. It is now
 * `StaffAccount` + `Role`: the session names who is holding it and which nav
 * sections they may reach, and every `/api/staff` route declares the section it
 * belongs to. The shared password survives only as `emergency` — a door for
 * bootstrapping the first Owner, and for getting back in when nobody can.
 *
 * No JWT library, because nothing here needs one. The session is a payload and
 * an HMAC over it — the same primitive the Revenue Monster signing already
 * uses — and it is *not* a bearer token for third parties to read: it is a
 * cookie this server issues to itself.
 *
 * **The token is a cache, not the authority.** It carries the sections the role
 * had at sign-in, but the gate re-reads the account on every request, so a role
 * narrowed or an account deactivated mid-shift takes effect on the next request
 * rather than in twelve hours. The baked copy is what the gate falls back to
 * when the account cannot be read at all — a database blip must not sign the
 * whole kitchen out during service.
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
const OPEN_PATHS = new Set(["/login", "/login/emergency", "/logout", "/session"]);

/**
 * Which section each `/api/staff` route belongs to, and the whole authorization
 * policy in one table.
 *
 * A route matching more than one section is granted by **any** of them: the
 * boards share `/overview` and the order actions, and somebody with only
 * Kitchen & Counter has to be able to work them.
 *
 * **Unmatched means denied.** A route added below without an entry here is
 * refused rather than left open — forgetting to add a permission must fail
 * closed, and `staffRoles.test.ts` walks the real router to prove every
 * registered path matches something.
 */
const SECTION_ROUTES: readonly (readonly [RegExp, readonly SectionKey[]])[] = [
  [/^\/overview$/, ["dashboard", "kitchen_counter"]],
  [/^\/orders\/takeaway$/, ["kitchen_counter"]],
  [/^\/orders\/[^/]+\/(status|approve-cancel|deny-cancel|cancel|settle)$/, ["dashboard", "kitchen_counter"]],
  // The on-duty pill lives on both boards, so either section may work it.
  [/^\/checkin$/, ["dashboard", "kitchen_counter"]],
  [/^\/checkin\/current$/, ["dashboard", "kitchen_counter"]],
  [/^\/checkout$/, ["dashboard", "kitchen_counter"]],
  // The log itself is a management view, and lives on the Staff page.
  [/^\/checkin\/history$/, ["staff"]],
  [/^\/sales-report$/, ["sales_report"]],
  [/^\/menu-items(\/.*)?$/, ["menu"]],
  [/^\/qr-codes$/, ["table_qr"]],
  [/^\/proofs(\/.*)?$/, ["approvals"]],
  [/^\/accounts(\/.*)?$/, ["staff"]],
  [/^\/roles(\/.*)?$/, ["staff"]],
];

/** The sections that may reach this path, or undefined if nothing claims it. */
export function sectionsForPath(path: string): readonly SectionKey[] | undefined {
  for (const [pattern, sections] of SECTION_ROUTES) {
    if (pattern.test(path)) return sections;
  }
  return undefined;
}

export interface StaffSession {
  /**
   * This session's own id. The reason it exists: with nothing to name a single
   * session by, logging out can only ask the browser to forget its cookie —
   * the token itself stays valid until it expires, so anyone who copied it
   * keeps the keys for the rest of the twelve hours. See `revokeSession`.
   */
  sid: string;
  /** Seconds since the epoch, as in a JWT — both are integers, so both compare cleanly. */
  iat: number;
  exp: number;
  /** Who signed in. Absent on an emergency session, which is nobody in particular. */
  staffId?: string;
  name?: string;
  role?: string;
  /** The sections their role permitted at sign-in. Re-checked per request. */
  sections: SectionKey[];
  /** True for the shared-password recovery door. */
  emergency?: boolean;
}

/**
 * How the staff area is gated right now.
 *
 * - `password` — `STAFF_PASSWORD` is set. The normal case: sign in to get in.
 * - `open`     — no password, and nothing about this deployment says public.
 *                Local development stays runnable without a secret, loudly.
 * - `locked`   — no password on a deployment that *is* public. The staff area
 *                closes rather than opening: a variable someone forgot to set
 *                must not be the difference between a gate and no gate on a
 *                shop the whole internet can reach.
 *
 * The customer flow is untouched in all three. Only `/api/staff/*` and the
 * staff pages read this.
 */
export type StaffGateMode = "password" | "open" | "locked";

/**
 * Does this look like a deployment strangers can reach?
 *
 * Two independent signals, either of which is enough, because the thing being
 * guarded against is someone forgetting to set something: an https public URL
 * (Railway hands one out) or an explicit production NODE_ENV. A plain
 * `http://localhost` dev server matches neither and behaves as it always has.
 */
function deploymentIsPublic(): boolean {
  return config.publicBaseUrl.startsWith("https://") || process.env.NODE_ENV === "production";
}

/**
 * Either secret turns the gate on: `STAFF_SESSION_SECRET` is enough on its own,
 * because individual accounts are what people sign in with now and the shared
 * password is only the recovery door. Setting neither on a public deployment
 * still locks rather than opens — a variable somebody forgot must not be the
 * difference between a gate and no gate.
 */
export function staffGateMode(): StaffGateMode {
  if (config.staffPassword !== undefined || config.staffSessionSecret !== undefined) return "password";
  return deploymentIsPublic() ? "locked" : "open";
}

/**
 * False when `STAFF_PASSWORD` is unset — there is then no **emergency**
 * password. Individual sign-in does not go through it; `staffGateMode` is what
 * says whether anybody can sign in at all.
 */
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
 * Per-process fallback secret.
 *
 * Only reached when neither `STAFF_SESSION_SECRET` nor `STAFF_PASSWORD` is set,
 * which is local development and the tests. Sessions then do not survive a
 * restart, which is the honest outcome: the alternative is a hard-coded key,
 * and a hard-coded key on a deployment somebody forgot to configure is worse
 * than a sign-in screen after every deploy. `server.ts` warns about it.
 */
const processSecret = randomUUID();

/**
 * The signing key.
 *
 * `STAFF_SESSION_SECRET` first, because sessions are no longer tied to the
 * shared password — that is an emergency door now, and rotating it must not
 * sign the whole shop out. `STAFF_PASSWORD` stays as the fallback so a
 * deployment that has not set the new variable keeps working as it did.
 *
 * v2: the payload gained an identity and a section list, so a v1 token signed
 * over the old shape must not verify. Everybody signs in again once, with their
 * own account, which is the point of the change anyway.
 */
function sessionKey(): Buffer {
  const secret = config.staffSessionSecret ?? config.staffPassword ?? processSecret;
  return createHash("sha256").update(`fish-chips-order:staff-session:v2:${secret}`).digest();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", sessionKey()).update(payload).digest("base64url");
}

/** Who a token is being minted for. Everything but the clock. */
export interface SessionIdentity {
  staffId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  sections: SectionKey[];
  emergency?: boolean | undefined;
}

/** A fresh session token, valid from now. */
export function issueSession(identity: SessionIdentity, now = Date.now()): string {
  const session: StaffSession = {
    sid: randomUUID(),
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + SESSION_TTL_MS) / 1000),
    sections: identity.sections,
  };
  if (identity.staffId !== undefined) session.staffId = identity.staffId;
  if (identity.name !== undefined) session.name = identity.name;
  if (identity.role !== undefined) session.role = identity.role;
  if (identity.emergency) session.emergency = true;

  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The recovery session: every section, and marked as what it is. */
export function issueEmergencySession(now = Date.now()): string {
  return issueSession({ sections: [...NAV_SECTIONS], emergency: true }, now);
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
    // No sid means a token minted before sessions could be revoked one at a
    // time. There is no way to honour a logout against one, so it is not
    // honoured at all: the cost is that the deploy adding this signs the
    // kitchen out once.
    if (typeof session.sid !== "string" || session.sid.length === 0) return undefined;
    // A token carrying no section list predates roles. There is no honest way
    // to decide what it should reach, so it is not a session any more.
    if (!Array.isArray(session.sections)) return undefined;
    if (isRevoked(session.sid, now)) return undefined;
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

/**
 * Whether this request may see the staff area at all.
 *
 * `open` is the only mode that lets a request through without a session, and
 * it is the one that cannot happen on a public deployment — see
 * `staffGateMode`.
 */
/**
 * What a request has been granted, once the gate has looked at it.
 *
 * Put on `res.locals.staff` so a route can read who is asking without repeating
 * the work — `/session` reports it straight back to the page that draws the nav.
 */
export interface StaffGrant {
  sections: readonly SectionKey[];
  staffId?: string;
  name?: string;
  role?: string;
  /** Signed in through the shared-password recovery door. */
  emergency: boolean;
  /** The gate is off entirely — local development with no password set. */
  open: boolean;
}

/** The two lookups the gate needs. Structural, so nothing here imports a service. */
export interface StaffGateDeps {
  /** The account, or undefined when there is genuinely no such account. */
  account(staffId: string): Promise<{ name: string; role: string; active: boolean } | undefined>;
  sectionsFor(roleName: string | undefined): Promise<SectionKey[]>;
  /** Whether the shared-password door is currently open. See `login/emergency`. */
  emergencyAllowed(): Promise<boolean>;
}

/** Everything a grant carries when the gate is switched off. */
function openGrant(): StaffGrant {
  return { sections: [...NAV_SECTIONS], emergency: false, open: true };
}

/**
 * Resolves a request to a grant, or undefined for "not signed in".
 *
 * The account is re-read here rather than trusted from the token, which is what
 * makes deactivating somebody take effect on their next request instead of at
 * the end of their twelve-hour session. The one case that falls back to the
 * token is a lookup that *failed* — as opposed to one that came back empty —
 * because a database that is briefly unreachable must not turn into everybody
 * on shift being signed out at once.
 */
export async function resolveGrant(req: Request, deps: StaffGateDeps): Promise<StaffGrant | undefined> {
  const mode = staffGateMode();
  if (mode === "open") return openGrant();
  if (mode === "locked") return undefined;

  const session = readSession(readCookie(req, STAFF_SESSION_COOKIE));
  if (session === undefined) return undefined;

  if (session.emergency) {
    // The recovery door closes behind itself: once there is an Owner to sign in
    // as, a session minted from the shared password stops being honoured rather
    // than lingering for the rest of its twelve hours.
    if (!(await deps.emergencyAllowed())) return undefined;
    return { sections: [...NAV_SECTIONS], emergency: true, open: false };
  }

  if (session.staffId === undefined) return undefined;

  let account: Awaited<ReturnType<StaffGateDeps["account"]>>;
  try {
    account = await deps.account(session.staffId);
  } catch {
    // Could not ask. Fall back to what the token was issued with.
    return grantFromToken(session);
  }

  if (account === undefined) return undefined;
  if (!account.active) return undefined;

  let sections: readonly SectionKey[];
  try {
    sections = await deps.sectionsFor(account.role);
  } catch {
    sections = session.sections;
  }

  const grant: StaffGrant = { sections, emergency: false, open: false, staffId: session.staffId };
  grant.name = account.name;
  grant.role = account.role;
  return grant;
}

function grantFromToken(session: StaffSession): StaffGrant {
  const grant: StaffGrant = { sections: session.sections, emergency: false, open: false };
  if (session.staffId !== undefined) grant.staffId = session.staffId;
  if (session.name !== undefined) grant.name = session.name;
  if (session.role !== undefined) grant.role = session.role;
  return grant;
}

/** True when this grant may reach a route belonging to any of `sections`. */
export function grantPermits(grant: StaffGrant, sections: readonly SectionKey[]): boolean {
  return sections.some((section) => grant.sections.includes(section));
}

/**
 * Revoked session ids, held until the moment they would have expired anyway.
 *
 * This is what makes logging out a server-side act rather than a request the
 * browser is free to ignore. Clearing the cookie tells one browser to forget
 * one copy of the token; it does nothing about a copy taken off a shared
 * tablet, and nothing at all if the response never arrives. Naming the session
 * here means the *server* stops accepting it, whoever presents it.
 *
 * In-memory and per-process, like the login throttle above and for the same
 * reason: one shop, one process. A restart forgets its revocations, which is
 * survivable because it also drops every in-flight session's usefulness far
 * more cheaply than a database would — and the twelve-hour expiry is the
 * backstop underneath either way.
 */
const revoked = new Map<string, number>();

function isRevoked(sid: string, now: number): boolean {
  const expiresAt = revoked.get(sid);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    // Past its own expiry the token is refused by the clock, so the entry has
    // stopped earning its keep.
    revoked.delete(sid);
    return false;
  }
  return true;
}

/**
 * Stops accepting this token, now, for every request that presents it.
 *
 * Takes the raw cookie rather than a parsed session so callers cannot revoke
 * something they never verified: a token that does not check out is already
 * refused, and adding attacker-supplied ids to this map is how it would grow
 * without bound.
 */
export function revokeSession(token: string | undefined, now = Date.now()): boolean {
  const session = readSession(token, now);
  if (session === undefined) return false;

  // Bounded by the number of real sign-ins in a twelve-hour window, as long as
  // dead entries are swept: one shift's worth, not one scan's worth.
  for (const [sid, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(sid);
  }
  revoked.set(session.sid, session.exp * 1000);
  return true;
}

/** Test seam, alongside `resetLoginThrottle`. Nothing in the app calls this. */
export function resetRevokedSessions(): void {
  revoked.clear();
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
export function createRequireStaffApi(deps: StaffGateDeps) {
  return function requireStaffApi(req: Request, res: Response, next: NextFunction): void {
    if (OPEN_PATHS.has(req.path)) {
      next();
      return;
    }

    void resolveGrant(req, deps)
      .then((grant) => {
        if (grant === undefined) {
          // 401 rather than 404: the pages' fetch wrapper turns exactly this
          // into a redirect to the login screen when a session expires
          // mid-service.
          res.status(401).json({ error: "staff_auth_required", message: "Sign in to use the staff area." });
          return;
        }

        res.locals.staff = grant;

        const sections = sectionsForPath(req.path);
        if (sections === undefined) {
          // Fail closed. Either a route was added without a section, or this is
          // a path no route serves; both are safer refused than allowed.
          res.status(403).json({
            error: "staff_section_unknown",
            message: "That is not a staff route this role can be checked against.",
          });
          return;
        }

        if (!grantPermits(grant, sections)) {
          // 403, not 401: they are signed in, and signing in again changes
          // nothing. Only an Owner widening their role would.
          res.status(403).json({
            error: "staff_section_forbidden",
            message: "Your role does not include that part of the staff area.",
            details: { required: sections, granted: grant.sections },
          });
          return;
        }

        next();
      })
      .catch(next);
  };
}

/**
 * The gate on the staff *pages*. Redirects rather than 401s, because this is a
 * browser navigation and a bare 401 body is not something anyone can act on.
 *
 * Server-side on purpose: a guard that runs in the page's own script can only
 * hide a view that has already been sent. This is what makes the redirect a
 * real gate rather than a cosmetic one.
 */
export function createRequireStaffPage(deps: StaffGateDeps, pageSection: (path: string) => SectionKey | undefined) {
  return function requireStaffPage(req: Request, res: Response, next: NextFunction): void {
    void resolveGrant(req, deps)
      .then((grant) => {
        if (grant === undefined) {
          res.redirect(302, `${config.staffDashboardPath}/login?next=${encodeURIComponent(req.originalUrl)}`);
          return;
        }

        const section = pageSection(req.path);
        if (section !== undefined && !grantPermits(grant, [section])) {
          // Enforced here as well as in the nav, because hiding a tab is not a
          // gate — the URL is still typeable, and the page behind it would have
          // been sent before its own script could decide otherwise.
          res.status(403).type("html").send(forbiddenPage(grant));
          return;
        }

        next();
      })
      .catch(next);
  };
}

/**
 * What somebody sees when they reach a page their role does not include.
 *
 * A page rather than a redirect: bouncing them somewhere else makes it look
 * like the link was broken, and a bookmark that silently lands somewhere
 * different is worse than being told why. It offers the first section they do
 * have, so it is never a dead end.
 */
function forbiddenPage(grant: StaffGrant): string {
  const base = config.staffDashboardPath;
  const first = grant.sections[0];
  const home = first === undefined ? `${base}/login` : `${base}${PAGE_FOR_SECTION[first]}`;
  const label = first === undefined ? "Sign in as somebody else" : "Go to what you can open";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Not your section — Anchor &amp; Batter</title>
<link rel="stylesheet" href="${base}/assets/staff.css" /></head>
<body class="login-page"><main><div class="login-card">
<h1>Not your section</h1>
<p class="sub">${escapeHtml(grant.name ?? "This account")}${
    grant.role === undefined ? "" : ` (${escapeHtml(grant.role)})`
  } does not have access to this part of the staff area. Ask an Owner if you need it.</p>
<a class="advance wide" href="${home}">${label}</a>
</div></main></body></html>`;
}

/** Where each section lives, for the "go somewhere you can open" link. */
const PAGE_FOR_SECTION: Record<SectionKey, string> = {
  dashboard: "",
  kitchen_counter: "/kitchen",
  sales_report: "/sales",
  menu: "/menu",
  table_qr: "/qr",
  approvals: "/approvals",
  staff: "/accounts",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
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
