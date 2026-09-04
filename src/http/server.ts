import { services } from "../app/container.js";
import { config } from "../config/env.js";
import { createServer } from "./app.js";

const RETRY_DELAY_MS = 5_000;

/**
 * Keeps trying, in the background, for as long as it takes.
 *
 * Connecting before listening would be tidier, but it means an unreachable
 * database takes the whole site down with it — no menu, no order lookup, and on
 * a platform that restarts the process, a crash loop with nothing to read. So
 * the server listens first and says it is not ready until the database answers.
 * Nothing falls back to memory: an order that cannot be recorded must fail, not
 * be quietly written somewhere that forgets it.
 */
async function connectStorage(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await services.storage.connect();
      console.log(`[storage] connected to MongoDB on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(
        `[storage] cannot reach MongoDB (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        "[storage] orders cannot be recorded until this succeeds. Usual causes: the database's IP " +
          "allowlist does not include this host, the credentials in MONGODB_URI are wrong, or the " +
          `variable points elsewhere. Retrying in ${RETRY_DELAY_MS / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

createServer(services).listen(config.port, () => {
  console.log(`fish-chips-order listening on ${config.publicBaseUrl} (storage: ${services.storage.kind})`);
});

if (config.staffPassword === undefined) {
  console.warn(
    `[staff] STAFF_PASSWORD is not set — the staff area at ${config.staffDashboardPath} is open to ` +
      "anyone who finds the path, including the routes that edit the menu and accept uploads. Set it " +
      "in the Railway dashboard. /health reports \"staffAuth\": \"disabled\" until you do.",
  );
}

if (services.storage.kind === "memory") {
  console.warn(
    "[storage] MONGODB_URI is not set — carts and orders are held in memory and " +
      "every one of them, paid included, is lost on restart. Do not run like this in production.",
  );
} else {
  void connectStorage();
}
