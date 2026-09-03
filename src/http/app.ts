import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response } from "express";
import { z, ZodError } from "zod";

import { services, type Services } from "../app/container.js";
import { config } from "../config/env.js";
import { KITCHEN_STATUSES, OrderValidationError, PAYMENT_METHODS, PAYMENT_PROVIDERS } from "../orders/types.js";
import { PaymentProviderError } from "../payments/types.js";
import { menuTools } from "../tools/menuTools.js";
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
        includeUnavailable: bool(req.query.includeUnavailable),
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

  server.post("/api/staff/orders/:orderId/status", (req, res) => {
    void runAsync(res, async () => {
      const { status } = staffStatusInput.parse(req.body ?? {});
      const result = await app.orders.setKitchenStatus(req.params.orderId, status);
      return { order: result.order, changed: result.changed };
    });
  });

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

  // The dashboard is served from its own directory, never through
  // `express.static`: a file under the customer's web root stays reachable at
  // its own filename whatever path the dashboard is mounted at.
  const staffFile = resolveStaffPage();
  if (staffFile) {
    server.get(config.staffDashboardPath, (_req, res) => {
      // Belt and braces on top of the meta tag — a crawler that reaches this
      // page should not put the kitchen board in a search index.
      res.setHeader("x-robots-tag", "noindex, nofollow");
      res.sendFile(staffFile);
    });
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

/** Same resolution dance as `resolveWebDir`, for the staff page's own directory. */
function resolveStaffPage(): string | undefined {
  const candidates: string[] = [];

  try {
    candidates.push(fileURLToPath(new URL("../staff-web/staff.html", import.meta.url)));
    candidates.push(fileURLToPath(new URL("../../src/staff-web/staff.html", import.meta.url)));
  } catch {
    // As in resolveWebDir: import.meta.url is not always a file: URL.
  }
  candidates.push(resolve(process.cwd(), "src/staff-web/staff.html"));

  return candidates.find((candidate) => existsSync(candidate));
}

const staffStatusInput = z.object({ status: z.enum(KITCHEN_STATUSES) });

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
