import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";
import { MulterError } from "multer";
import { z, ZodError } from "zod";

import { services, type Services } from "../app/container.js";
import { config } from "../config/env.js";
import { newProof, PROOF_STATUSES, PROOF_TYPES, triggerFor } from "../game/proofs.js";
import { deleteImage, imageUpload, MENU_IMAGES, PROOF_IMAGES, servedImageUrl } from "../menu/images.js";
import { toItemView } from "../menu/service.js";
import type { MenuItemInput } from "../menu/store.js";
import { MenuValidationError } from "../menu/types.js";
import { KITCHEN_STATUSES, OrderValidationError, PAYMENT_METHODS, PAYMENT_PROVIDERS } from "../orders/types.js";
import { PaymentProviderError } from "../payments/types.js";
import { expandTables, MAX_TABLES, tableCodes } from "../qr/tables.js";
import {
  clearLoginFailures,
  hasStaffSession,
  issueSession,
  loginRetryAfter,
  passwordMatches,
  recordLoginFailure,
  requireStaffApi,
  requireStaffPage,
  sessionCookieOptions,
  staffAuthEnabled,
  STAFF_SESSION_COOKIE,
  throttleKey,
} from "../staff/auth.js";
import { createMenuTools } from "../tools/menuTools.js";
import { createOrderTools } from "../tools/orderTools.js";

/**
 * HTTP surface.
 *
 * Three shapes over the same services: REST for the customer web app,
 * POST /api/tools/:name for the agent runtime, and the provider webhooks.
 */

export function createServer(app: Services = services) {
  const server = express();
  const tools = createOrderTools(app);
  const menuTools = createMenuTools(app.menu);

  // ---------------------------------------------------------------- webhooks
  // Mounted before express.json() on purpose: signature verification needs the
  // exact bytes the provider signed. Re-serialising parsed JSON changes key
  // order and whitespace and invalidates every signature scheme there is.
  server.post(
    "/api/payments/webhook/:provider",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req: Request, res: Response) => {
      const provider = req.params.provider ?? "";
      if (!isProvider(provider)) {
        res.status(404).json({ error: "unknown_provider", provider });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      const outcome = await app.payments.handleWebhook(provider, rawBody, req.headers);

      if (!outcome.handled) {
        // 400 tells the provider to retry. That is what we want for a missing
        // order; for a bad signature it costs nothing and reveals nothing.
        res.status(400).json({ error: "webhook_rejected", reason: outcome.reason });
        return;
      }

      res.json({
        received: true,
        changed: outcome.changed,
        orderId: outcome.order?.id,
        paymentStatus: outcome.order?.paymentStatus,
      });
    },
  );

  server.use(express.json());

  // ------------------------------------------------------------------ health
  server.get("/health", (_req, res) => {
    // `storage` makes an accidental in-memory deploy visible from outside, and
    // a configured database we have not reached yet is not "ok" — orders cannot
    // be recorded until it is.
    res.status(app.storage.ready ? 200 : 503).json({
      ok: app.storage.ready,
      phase: 2,
      storage: app.storage.kind,
      indexes: app.storage.indexes,
      // Same reasoning as `storage`: a deploy that forgot STAFF_PASSWORD is
      // serving an open staff area, and that should be visible without having
      // to go and try the door.
      staffAuth: staffAuthEnabled() ? "password" : "disabled",
    });
  });

  // -------------------------------------------------------------------- menu
  server.get("/api/menu", (req, res) => {
    run(res, () =>
      menuTools.get_menu({
        categories: list(req.query.category),
        tags: list(req.query.tag),
        dietary: list(req.query.dietary),
        excludeAllergens: list(req.query.exclude),
        allergenMode: single(req.query.allergenMode),
        maxPriceSen: int(req.query.maxPriceSen),
        search: single(req.query.search),
        // Sold-out items are *included* here, unlike the agent's own
        // `get_menu`: the customer page lists them greyed out with the
        // add button disabled, which answers "do you still do the cod?"
        // without anyone having to ask.
        includeUnavailable: bool(req.query.includeUnavailable) ?? true,
        withDescriptions: bool(req.query.withDescriptions),
      }),
    );
  });

  server.get("/api/menu/items/:itemId", (req, res) => {
    run(res, () => {
      const result = menuTools.get_menu_item({ itemId: req.params.itemId });
      if (!result.found) {
        res.status(404).json(result);
        return undefined;
      }
      return result;
    });
  });

  server.get("/api/menu/suggestions", (req, res) => {
    run(res, () =>
      menuTools.suggest_items({
        categories: list(req.query.category),
        dietary: list(req.query.dietary),
        excludeAllergens: list(req.query.exclude),
        allergenMode: single(req.query.allergenMode),
        limit: int(req.query.limit),
      }),
    );
  });

  // ------------------------------------------------------------------- carts
  server.post("/api/carts", (req, res) => {
    void runAsync(res, () => tools.create_cart(req.body ?? {}));
  });

  server.get("/api/carts/:cartId", (req, res) => {
    void runAsync(res, () => tools.view_cart({ cartId: req.params.cartId }));
  });

  server.post("/api/carts/:cartId/lines", (req, res) => {
    void runAsync(res, () => tools.add_to_cart({ ...req.body, cartId: req.params.cartId }));
  });

  server.patch("/api/carts/:cartId/lines/:lineId", (req, res) => {
    void runAsync(res, () =>
      tools.update_cart_line({
        cartId: req.params.cartId,
        lineId: req.params.lineId,
        quantity: req.body?.quantity,
      }),
    );
  });

  server.delete("/api/carts/:cartId/lines/:lineId", (req, res) => {
    void runAsync(res, () => tools.remove_from_cart({ cartId: req.params.cartId, lineId: req.params.lineId }));
  });

  // ------------------------------------------------------------------ orders
  server.post("/api/orders", (req, res) => {
    void runAsync(res, () => tools.confirm_order(req.body ?? {}));
  });

  server.get("/api/orders/:orderId", (req, res) => {
    void runAsync(res, () => tools.get_order({ orderId: req.params.orderId }));
  });

  // -------------------------------------------------------- chances and game
  /**
   * The customer's own chance ledger, polled.
   *
   * This is the "real time" half of the approval loop: there is no WebSocket in
   * this project — the staff boards have always short-polled — so the customer
   * page polls this while something of theirs is pending, and the count moves
   * the moment a staff member taps Approve. Scoped to one cart id, which is the
   * session, so nobody sees anyone else's.
   */
  server.get("/api/order/chances", (req, res) => {
    void runAsync(res, async () => chancesView(app, single(req.query.cartId) ?? ""));
  });

  /**
   * A contact, for a chance.
   *
   * Stored on the session and nowhere else: no consent flag, no unsubscribe, no
   * list. Anything beyond "reach this customer about this order" would need a
   * consent model this does not have — see the note on `Cart.contact`.
   */
  server.post("/api/order/chances/register", (req, res) => {
    void runAsync(res, async () => {
      const { cartId, contact } = registerInput.parse(req.body ?? {});
      await app.carts.registerContact(cartId, contact);
      return chancesView(app, cartId);
    });
  });

  /**
   * A screenshot of a review or a share.
   *
   * Same upload machinery as the menu photos — same limits, same volume, same
   * refusal of SVG — differing only in the subdirectory. **The same Railway
   * volume caveat applies**: without one mounted at `/app/uploads`, these
   * screenshots vanish on the next redeploy, and a staff member opening the
   * queue would see a broken image with no way to judge it.
   */
  server.post("/api/order/proof", withProofImage, (req, res) => {
    void runAsync(res, async () => {
      const file = (req as Request & { file?: { filename: string } }).file;
      const { cartId, type } = proofInput.parse(req.body ?? {});

      if (!file) {
        throw new OrderValidationError("A screenshot is required.", "missing_image", { cartId });
      }

      const imageUrl = servedImageUrl(file, PROOF_IMAGES);
      try {
        // The hold comes first: it is the call that refuses a second submission
        // for the same trigger, and an orphaned upload is cheaper than a
        // duplicate claim.
        const cart = await app.carts.holdChanceForProof(cartId, triggerFor(type));
        const proof = newProof({ cartId, type, imageUrl, tableNumber: cart.tableNumber });
        await app.proofs.save(proof);
        return { proof, chances: await chancesView(app, cartId) };
      } catch (error) {
        await deleteImage(imageUrl, PROOF_IMAGES);
        throw error;
      }
    });
  });

  /**
   * One cast. The server rolls and applies; the client animates what it is told.
   *
   * Nothing in the request influences the outcome, and the reward is on the cart
   * before this responds — so the total in the reply, and the amount Stripe is
   * later asked for, already have it in.
   */
  server.post("/api/order/fish/play", (req, res) => {
    void runAsync(res, async () => {
      const { cartId } = playInput.parse(req.body ?? {});
      const { cart, reward } = await app.carts.play(cartId);
      return { cart, reward, chances: await chancesView(app, cartId) };
    });
  });

  // ---------------------------------------------------------------- payments
  server.get("/api/payments/methods", (_req, res) => {
    run(res, () => tools.get_payment_methods());
  });

  server.post("/api/orders/:orderId/payment", (req, res) => {
    void runAsync(res, () =>
      tools.start_payment({ orderId: req.params.orderId, method: req.body?.method }),
    );
  });

  /** Development only — refuses any order whose provider has real credentials. */
  server.post("/api/payments/simulate/:orderId", (req, res) => {
    void runAsync(res, async () => {
      const order = await app.payments.settleSimulated(req.params.orderId);
      return { order, paymentStatus: order.paymentStatus };
    });
  });

  // --------------------------------------------------------------- staff auth
  /**
   * One shared password for everyone behind the counter — see `src/staff/auth.ts`
   * for why it is shared rather than per-user, and what the session is made of.
   *
   * The gate is mounted at the `/api/staff` prefix, above every staff route, so
   * a route added below is protected without anyone having to remember to
   * protect it. Login and logout are exempted inside the middleware rather than
   * by sitting above it, so reordering this file cannot open a hole.
   */
  server.use("/api/staff", requireStaffApi);

  /** What the login page asks before deciding whether to show itself. */
  server.get("/api/staff/session", (req, res) => {
    res.json({ authenticated: hasStaffSession(req), authRequired: staffAuthEnabled() });
  });

  server.post("/api/staff/login", (req, res) => {
    run(res, () => {
      if (!staffAuthEnabled()) {
        // Nothing to sign in to. Saying so beats a 401 the page cannot act on:
        // the caller is already through the door.
        res.json({ ok: true, authRequired: false });
        return undefined;
      }

      const key = throttleKey(req);
      const retryAfter = loginRetryAfter(key);
      if (retryAfter > 0) {
        res.setHeader("retry-after", String(retryAfter));
        res.status(429).json({
          error: "too_many_attempts",
          message: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          retryAfter,
        });
        return undefined;
      }

      const { password } = staffLoginInput.parse(req.body ?? {});
      if (!passwordMatches(password)) {
        recordLoginFailure(key);
        // No detail, deliberately: "wrong password" and "no password set" must
        // look identical from outside.
        res.status(401).json({ error: "invalid_password", message: "That password is not right." });
        return undefined;
      }

      clearLoginFailures(key);
      res.cookie(STAFF_SESSION_COOKIE, issueSession(), sessionCookieOptions());
      return { ok: true, authRequired: true };
    });
  });

  server.post("/api/staff/logout", (_req, res) => {
    // Cleared with the same options it was set with; a mismatched path would
    // leave the old cookie in place and log nobody out.
    res.clearCookie(STAFF_SESSION_COOKIE, sessionCookieOptions());
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- staff view
  /**
   * The kitchen/counter board.
   *
   * Behind the shared password above. The path is still worth overriding with
   * `STAFF_DASHBOARD_PATH` on a public deployment — it keeps the sign-in screen
   * off a passing customer's radar — but it is no longer the only thing
   * standing in the way, which it was when these routes were as open as the
   * customer API.
   */
  server.get("/api/staff/overview", (_req, res) => {
    void runAsync(res, async () => {
      const [orders, sales] = await Promise.all([app.orders.feed(), app.orders.dailySales()]);
      return { orders, sales };
    });
  });

  /**
   * Move an order along the pass.
   *
   * PATCH is the honest verb — this edits one field of an existing order — and
   * is what the staff pages call. POST is kept alongside it because it is what
   * shipped first, and a kitchen tablet holding a cached page must not break on
   * a deploy.
   */
  const setStatus = (req: Request<{ orderId: string }>, res: Response): void => {
    void runAsync(res, async () => {
      const { status } = staffStatusInput.parse(req.body ?? {});
      const result = await app.orders.setKitchenStatus(req.params.orderId, status);
      return { order: result.order, changed: result.changed };
    });
  };

  server.patch("/api/staff/orders/:orderId/status", setStatus);
  server.post("/api/staff/orders/:orderId/status", setStatus);

  /**
   * Takings per day over a range, for the sales report page.
   *
   * Dates are snake_case here because they are a report's parameters rather than
   * a domain object's fields, and `start_date`/`end_date` is what a person
   * hand-writing this URL will reach for. Both default to today.
   */
  server.get("/api/staff/sales-report", (req, res) => {
    void runAsync(res, () => {
      const query = salesReportQuery.parse({
        start_date: single(req.query.start_date),
        end_date: single(req.query.end_date),
      });
      return app.orders.salesReport({ startDate: query.start_date, endDate: query.end_date });
    });
  });

  // ------------------------------------------------------- staff takeaway
  /**
   * An order rung up at the counter.
   *
   * Builds on exactly the cart the customer app uses — the staff page creates a
   * cart through `/api/carts` and adds lines through `/api/carts/:id/lines`,
   * so pricing, options and validation are the same code and cannot drift.
   * Only the last step is different, and it is this: a takeaway number instead
   * of a table, and a choice of how it was paid.
   */
  server.post("/api/staff/orders/takeaway", (req, res) => {
    void runAsync(res, async () => {
      const input = takeawayInput.parse(req.body ?? {});

      const order = await app.orders.confirm({
        cartId: input.cartId,
        ...(input.customerName === undefined ? {} : { customerName: input.customerName }),
        // Card means the customer is at the counter with a terminal in front of
        // them, so the ticket waits for the money. Cash is already in the till.
        takeaway: { holdForPayment: input.payment === "card" },
      });

      if (input.payment === "cash") {
        const paid = await app.orders.takeCash(order.id);
        return { order: paid, payment: null };
      }

      // The same Stripe path a QR customer takes, settling on the same webhook.
      const started = await app.payments.initiate(order.id, "card");
      return { order: started, payment: started.payment ?? null };
    });
  });

  // --------------------------------------------------------- staff approvals
  /**
   * The queue. Polled by the Approvals view, like every other staff feed.
   *
   * Defaults to `pending` because that is the only status anyone works from;
   * the others are there for looking back at a decision.
   */
  server.get("/api/staff/proofs", (req, res) => {
    void runAsync(res, async () => {
      const { status } = proofQuery.parse({ status: single(req.query.status) });
      const proofs = await app.proofs.byStatus(status);
      return { status, proofs };
    });
  });

  server.patch("/api/staff/proofs/:id/approve", (req, res) => {
    void runAsync(res, () => decideProof(app, req.params.id, "approved"));
  });

  server.patch("/api/staff/proofs/:id/reject", (req, res) => {
    void runAsync(res, () => decideProof(app, req.params.id, "rejected"));
  });

  // ---------------------------------------------------------- staff QR codes
  /**
   * The table codes, as images the staff page can show, print or save.
   *
   * Generated per request rather than stored: a code is a pure function of the
   * public URL and the table number, so there is nothing worth keeping — and
   * nothing to go stale the day `PUBLIC_BASE_URL` changes.
   *
   * Behind the staff password like everything else under `/api/staff`, which is
   * what makes this page possible at all: minting table codes on an open route
   * would hand anyone a link that opens an order against someone else's table.
   */
  server.get("/api/staff/qr-codes", (req, res) => {
    void runAsync(res, async () => {
      const { tables: spec, base_url: baseUrl } = qrQuery.parse({
        tables: single(req.query.tables),
        base_url: single(req.query.base_url),
      });

      let tables: string[];
      try {
        tables = expandTables(spec);
      } catch (error) {
        // "9-2 counts backwards" is the useful half; the form shows it as typed.
        throw new OrderValidationError(
          error instanceof Error ? error.message : "That is not a list of tables.",
          "invalid_table_list",
          { tables: spec },
        );
      }

      if (tables.length > MAX_TABLES) {
        throw new OrderValidationError(
          `${tables.length} tables at once is more than this will do; ${MAX_TABLES} is the limit.`,
          "too_many_tables",
          { count: tables.length, max: MAX_TABLES },
        );
      }

      const base = baseUrl ?? config.publicBaseUrl;
      return { baseUrl: base, codes: await tableCodes(base, tables) };
    });
  });

  // -------------------------------------------------------- staff menu admin
  /**
   * Menu management. Behind the same gate as the rest of `/api/staff` — which
   * matters most here: these are the routes that write the menu and accept
   * uploads, and the guard runs before multer, so an unauthenticated request
   * never puts a file on the volume.
   *
   * Prices are in sen throughout, like every other money field in this API. The
   * form converts, so nothing on the wire is a float.
   */
  server.get("/api/staff/menu-items", (_req, res) => {
    run(res, () => ({
      // Every item, sold-out ones included: this is the page that turns them
      // back on, so it cannot be filtered by the thing it edits.
      items: app.menuStore.items().map(toItemView),
      categories: app.menuStore.categories().map((category) => ({
        id: category.id,
        name: category.name,
        itemCount: app.menuStore.items().filter((item) => item.categoryId === category.id).length,
      })),
      version: app.menuStore.load().version,
    }));
  });

  server.post("/api/staff/menu-items", withMenuImage, (req, res) => {
    void runAsync(res, async () => {
      const input = menuItemInput(req);
      try {
        const item = await app.menuStore.create(input);
        res.status(201).json({ item: toItemView(item) });
      } catch (error) {
        // The file landed before the fields were validated, so a rejected
        // create must not leave an orphan on the volume.
        await deleteImage(input.imageUrl);
        throw error;
      }
      return undefined;
    });
  });

  /**
   * Patches whatever fields were sent — "update any field", so an edit form that
   * only changes the price does not have to resend the description.
   */
  server.put("/api/staff/menu-items/:id", withMenuImage, (req: Request<{ id: string }>, res) => {
    void runAsync(res, async () => {
      const input = menuItemInput(req);
      const previousImage = app.menuStore.item(req.params.id).imageUrl;

      try {
        const item = await app.menuStore.update(req.params.id, input);
        // Only once the new image is safely recorded; the reverse order loses
        // the old photo when the write fails.
        if (previousImage !== undefined && previousImage !== item.imageUrl) await deleteImage(previousImage);
        return { item: toItemView(item) };
      } catch (error) {
        await deleteImage(input.imageUrl);
        throw error;
      }
    });
  });

  /**
   * The 86 toggle. Availability only, on purpose: this fires on a single tap
   * during service, so it must not be able to carry a stale price with it.
   */
  server.patch("/api/staff/menu-items/:id/availability", (req, res) => {
    void runAsync(res, async () => {
      const { available } = availabilityInput.parse(req.body ?? {});
      const item = await app.menuStore.setAvailability(req.params.id, available);
      return { item: toItemView(item) };
    });
  });

  server.delete("/api/staff/menu-items/:id", (req, res) => {
    void runAsync(res, async () => {
      // A cart still holding this item now fails to price with `unknown_item`,
      // which is the same 400 an unavailable item already produced.
      const removed = await app.menuStore.remove(req.params.id);
      await deleteImage(removed.imageUrl);
      return { deleted: true, id: removed.id };
    });
  });

  // Uploaded images, read-only. Served from the uploads volume rather than the
  // customer web root, so a redeploy cannot quietly replace them with nothing.
  server.use(
    "/uploads",
    express.static(config.uploadsDir, {
      dotfiles: "deny",
      index: false,
      // These are content-addressed by a uuid filename: a given URL never
      // changes what it points at, so it can be cached hard.
      maxAge: "7d",
      setHeaders: (response) => {
        // Belt and braces for a store of user-supplied files served same-origin.
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("content-security-policy", "default-src 'none'; img-src 'self'");
      },
    }),
  );

  // ------------------------------------------------------------- agent tools
  const toolRegistry = { ...menuTools, ...tools };

  server.post("/api/tools/:name", (req, res) => {
    const name = req.params.name;
    if (!isToolName(name, toolRegistry)) {
      res.status(404).json({ error: "unknown_tool", name });
      return;
    }
    void runAsync(res, () => toolRegistry[name](req.body ?? {}));
  });

  // --------------------------------------------------------------- web pages
  const webDir = resolveWebDir();
  if (webDir) {
    server.use(express.static(webDir));
    // The order page is client-rendered from the same document.
    server.get(["/", "/checkout", "/order", "/order/:orderId", "/simulated-checkout"], (_req, res) => {
      res.sendFile(join(webDir, "index.html"));
    });
  }

  // The staff area is served from its own directory, never through the
  // customer's `express.static`: a file under that web root stays reachable at
  // its own filename whatever path the dashboard is mounted at.
  const staffDir = resolveStaffDir();
  if (staffDir) {
    const staffPage = (file: string) => (_req: Request, res: Response) => {
      // Belt and braces on top of the meta tag — a crawler that reaches this
      // page should not put the kitchen board in a search index.
      res.setHeader("x-robots-tag", "noindex, nofollow");
      res.type("html").send(renderStaffPage(join(staffDir, file)));
    };

    // The one page that must not be behind the gate, or there is no way through
    // it. It carries no data — just a password field.
    server.get(`${config.staffDashboardPath}/login`, staffPage("login.html"));

    // Four views over one area. Each is its own document rather than a client
    // router, so a tablet on the pass reloads into the view it was showing —
    // and each is guarded server-side, so an unauthenticated reload lands on
    // the login screen instead of a page that renders and then thinks better
    // of it.
    server.get(config.staffDashboardPath, requireStaffPage, staffPage("staff.html"));
    server.get(`${config.staffDashboardPath}/kitchen`, requireStaffPage, staffPage("kitchen.html"));
    server.get(`${config.staffDashboardPath}/sales`, requireStaffPage, staffPage("sales.html"));
    server.get(`${config.staffDashboardPath}/menu`, requireStaffPage, staffPage("menu.html"));
    server.get(`${config.staffDashboardPath}/qr`, requireStaffPage, staffPage("qr.html"));
    server.get(`${config.staffDashboardPath}/approvals`, requireStaffPage, staffPage("approvals.html"));

    // The shared nav, styles and helpers the three pages import. Mounted under
    // the dashboard's own path so nothing about the staff area leaks a route at
    // the site root.
    server.use(
      `${config.staffDashboardPath}/assets`,
      express.static(join(staffDir, "assets"), { setHeaders: (response) => response.setHeader("x-robots-tag", "noindex, nofollow") }),
    );
  }

  return server;
}

/** Works from `src/` under tsx, from `dist/` after a build, and under a test runner. */
function resolveWebDir(): string | undefined {
  const candidates: string[] = [];

  try {
    candidates.push(fileURLToPath(new URL("../web/", import.meta.url)));
    candidates.push(fileURLToPath(new URL("../../src/web/", import.meta.url)));
  } catch {
    // import.meta.url is not a file: URL (jsdom serves it over http, and some
    // bundlers rewrite it). Fall through to the cwd-relative candidate.
  }
  candidates.push(resolve(process.cwd(), "src/web"));

  return candidates.find((candidate) => existsSync(join(candidate, "index.html")));
}

/** Same resolution dance as `resolveWebDir`, for the staff area's own directory. */
function resolveStaffDir(): string | undefined {
  const candidates: string[] = [];

  try {
    candidates.push(fileURLToPath(new URL("../staff-web/", import.meta.url)));
    candidates.push(fileURLToPath(new URL("../../src/staff-web/", import.meta.url)));
  } catch {
    // As in resolveWebDir: import.meta.url is not always a file: URL.
  }
  candidates.push(resolve(process.cwd(), "src/staff-web"));

  return candidates.find((candidate) => existsSync(join(candidate, "staff.html")));
}

const staffPageCache = new Map<string, string>();

/**
 * Reads a staff page, substituting the path the area is mounted at.
 *
 * The pages are static files with no build step, but the mount path is
 * configurable — so nav links and asset URLs cannot be written into the HTML
 * ahead of time. One placeholder, filled once and cached, keeps them absolute:
 * relative URLs would resolve differently on `/staff` and `/staff/kitchen`.
 */
function renderStaffPage(file: string): string {
  const cached = staffPageCache.get(file);
  if (cached !== undefined) return cached;

  const html = readFileSync(file, "utf8").replaceAll("{{STAFF_BASE}}", config.staffDashboardPath);
  staffPageCache.set(file, html);
  return html;
}

const staffStatusInput = z.object({ status: z.enum(KITCHEN_STATUSES) });

/**
 * Length-capped so a megabyte of "password" cannot be hashed on demand, and
 * non-empty so a blank field is a 400 the form can explain rather than a 401
 * that reads as a wrong password.
 */
const staffLoginInput = z.object({ password: z.string().min(1).max(200) });

const availabilityInput = z.object({ available: z.boolean() });

/**
 * The table spec is validated by `expandTables`, which knows what a table
 * number is; this only checks something was typed. `base_url` is an override
 * for printing codes that point somewhere this deployment is not serving from
 * yet — a staging box printing the live stickers.
 */
/**
 * Cash or card, and nothing else. Cash is not a `PaymentMethod` — it has no
 * provider and no session — so it is spelled out here rather than reusing the
 * customer's method enum, which would put it in the customer's picker.
 */
const takeawayInput = z.object({
  cartId: z.string().min(1),
  payment: z.enum(["cash", "card"]),
  customerName: z.string().trim().min(1).max(60).optional(),
});

const registerInput = z.object({
  cartId: z.string().min(1),
  // Phone or email, and not validated beyond "they typed something": a shop
  // rejecting a customer's own phone number over a format guess is worse than
  // storing a string nobody ends up using.
  contact: z.string().trim().min(3).max(120),
});

const proofInput = z.object({ cartId: z.string().min(1), type: z.enum(PROOF_TYPES) });
const playInput = z.object({ cartId: z.string().min(1) });
const proofQuery = z.object({ status: z.enum(PROOF_STATUSES).default("pending") });

/** One optional image on the field named `image`, into the proofs directory. */
function withProofImage(req: Request, res: Response, next: NextFunction): void {
  imageUpload(PROOF_IMAGES).single("image")(req, res, (error: unknown) => {
    if (error) {
      respondToError(res, error);
      return;
    }
    next();
  });
}

/** What the customer's page needs to draw the indicator, and nothing else. */
async function chancesView(app: Services, cartId: string) {
  const cart = await app.carts.get(cartId);
  const proofs = await app.proofs.forCart(cartId);

  return {
    cartId,
    chances: cart.chances,
    chancesPending: cart.chancesPending,
    chancesUsed: cart.chancesUsed,
    claimed: cart.claimed,
    rewards: cart.rewards,
    proofs: proofs.map((proof) => ({ id: proof.id, type: proof.type, status: proof.status })),
  };
}

/**
 * Approve or reject, and move the session's ledger with it.
 *
 * The chance lands on `proof.cartId` — the session that submitted it — which is
 * what keeps one customer's approval off everybody else's counter.
 */
async function decideProof(app: Services, id: string, status: "approved" | "rejected") {
  const proof = await app.proofs.get(id);
  if (!proof) {
    throw new OrderValidationError(`No proof "${id}".`, "unknown_proof", { id });
  }
  if (proof.status !== "pending") {
    // Two staff tablets, one queue: the second tap is a no-op rather than a
    // second chance granted.
    return { proof, changed: false };
  }

  proof.status = status;
  proof.decidedAt = new Date().toISOString();
  await app.proofs.save(proof);

  if (status === "approved") await app.carts.approveChance(proof.cartId);
  else await app.carts.rejectChance(proof.cartId, triggerFor(proof.type));

  return { proof, changed: true };
}

const qrQuery = z.object({
  tables: z.string().min(1),
  base_url: z.string().url().optional(),
});

/**
 * One optional image, on the field named `image`.
 *
 * Wrapped rather than passed straight in so multer's own failures — a file over
 * the size limit, a PDF renamed to .jpg — come back as the same JSON errors as
 * everything else instead of express's default HTML 500.
 */
function withMenuImage(req: Request, res: Response, next: NextFunction): void {
  imageUpload(MENU_IMAGES).single("image")(req, res, (error: unknown) => {
    if (error) {
      respondToError(res, error);
      return;
    }
    next();
  });
}

/**
 * Reads the staff form into store input.
 *
 * Multipart carries strings only, so numbers and booleans are parsed here — and
 * a field that was not sent stays `undefined`, which is what makes PUT a patch
 * rather than a wipe.
 */
function menuItemInput(req: Request): MenuItemInput {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const file = (req as Request & { file?: { filename: string } }).file;

  const input: MenuItemInput = {};
  for (const field of ["name", "description", "category", "flavourNotes", "unavailableReason"] as const) {
    if (body[field] !== undefined) input[field] = String(body[field]);
  }
  if (body.priceSen !== undefined) input.priceSen = menuPriceSen(body.priceSen);
  if (body.available !== undefined) input.available = formBoolean(body.available, "available");
  if (body.removeImage !== undefined) input.removeImage = formBoolean(body.removeImage, "removeImage");
  if (file) input.imageUrl = servedImageUrl(file);

  return input;
}

/** Rejects a non-integer rather than truncating it — a silently halved price is worse. */
function menuPriceSen(raw: unknown): number {
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed)) {
    throw new MenuValidationError(`"${String(raw)}" is not a whole number of sen.`, "invalid_price", { priceSen: raw });
  }
  return parsed;
}

/** Accepts what a checkbox and a JSON client each send for the same thing. */
function formBoolean(raw: unknown, field: string): boolean {
  const value = String(raw).trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(value)) return true;
  if (["false", "0", "off", "no", ""].includes(value)) return false;
  throw new MenuValidationError(`"${String(raw)}" is not true or false.`, "invalid_boolean", { field, value: raw });
}

/**
 * Shape only. Whether the dates name real days, sit the right way round and
 * cover a sane span is the service's call, so one rule serves every caller.
 */
const salesReportQuery = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

function isProvider(value: string): value is (typeof PAYMENT_PROVIDERS)[number] {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

function isToolName<T extends object>(name: string, registry: T): name is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(registry, name);
}

function run(res: Response, handler: () => unknown): void {
  try {
    const body = handler();
    if (body === undefined) return; // handler already responded
    res.json(body);
  } catch (error) {
    respondToError(res, error);
  }
}

async function runAsync(res: Response, handler: () => unknown): Promise<void> {
  try {
    const body = await handler();
    if (body === undefined) return;
    res.json(body);
  } catch (error) {
    respondToError(res, error);
  }
}

function respondToError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "invalid_request", issues: error.issues });
    return;
  }
  if (error instanceof OrderValidationError) {
    // Everything this covers is something the customer can fix by choosing
    // differently, so it is a 400 with the code the UI can branch on.
    const status = error.code === "unknown_cart" || error.code === "unknown_order" ? 404 : 400;
    res.status(status).json({ error: error.code, message: error.message, details: error.details });
    return;
  }
  if (error instanceof MenuValidationError) {
    // Same split as OrderValidationError: a missing item is a 404, everything
    // else is something the staff member can fix in the form.
    const status = error.code === "unknown_menu_item" ? 404 : 400;
    res.status(status).json({ error: error.code, message: error.message, details: error.details });
    return;
  }
  if (error instanceof MulterError) {
    // LIMIT_FILE_SIZE, LIMIT_UNEXPECTED_FILE and friends: all of them are the
    // request's fault, and the code is the one thing the form can branch on.
    res.status(400).json({ error: "invalid_upload", code: error.code, message: error.message, field: error.field });
    return;
  }
  if (error instanceof PaymentProviderError) {
    // The provider failed, not the customer.
    res.status(502).json({ error: "payment_provider_error", provider: error.provider, message: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "internal_error" });
}

/** `?exclude=a,b` and `?exclude=a&exclude=b` both work. */
function list(value: Request["query"][string]): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parts = raw
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function single(value: Request["query"][string]): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : String(first);
}

function int(value: Request["query"][string]): number | undefined {
  const raw = single(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? Number.NaN : Math.trunc(parsed);
}

function bool(value: Request["query"][string]): boolean | undefined {
  const raw = single(value);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}

export { PAYMENT_METHODS };
