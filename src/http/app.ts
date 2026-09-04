import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type NextFunction, type Request, type Response } from "express";
import { MulterError } from "multer";
import { z, ZodError } from "zod";

import { services, type Services } from "../app/container.js";
import { config } from "../config/env.js";
import { deleteImage, menuImageUpload, servedImageUrl } from "../menu/images.js";
import { toItemView } from "../menu/service.js";
import type { MenuItemInput } from "../menu/store.js";
import { MenuValidationError } from "../menu/types.js";
import { KITCHEN_STATUSES, OrderValidationError, PAYMENT_METHODS, PAYMENT_PROVIDERS } from "../orders/types.js";
import { PaymentProviderError } from "../payments/types.js";
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

  // --------------------------------------------------------------- staff view
  /**
   * The kitchen/counter board.
   *
   * No login yet, so the only thing keeping customers off it is the path, which
   * `STAFF_DASHBOARD_PATH` should override on any public deployment. Be honest
   * about the limit of that: the data routes below are as open as every other
   * route here, and obscurity only hides the page, not the API. Real staff auth
   * is a later phase.
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

  // -------------------------------------------------------- staff menu admin
  /**
   * Menu management. As open as every other route here — see the note above on
   * what the unguessable dashboard path does and does not buy you.
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

    // Three views over one area. Each is its own document rather than a client
    // router, so a tablet on the pass reloads into the view it was showing.
    server.get(config.staffDashboardPath, staffPage("staff.html"));
    server.get(`${config.staffDashboardPath}/kitchen`, staffPage("kitchen.html"));
    server.get(`${config.staffDashboardPath}/sales`, staffPage("sales.html"));
    server.get(`${config.staffDashboardPath}/menu`, staffPage("menu.html"));

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

const availabilityInput = z.object({ available: z.boolean() });

/**
 * One optional image, on the field named `image`.
 *
 * Wrapped rather than passed straight in so multer's own failures — a file over
 * the size limit, a PDF renamed to .jpg — come back as the same JSON errors as
 * everything else instead of express's default HTML 500.
 */
function withMenuImage(req: Request, res: Response, next: NextFunction): void {
  menuImageUpload().single("image")(req, res, (error: unknown) => {
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
