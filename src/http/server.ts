import { services } from "../app/container.js";
import { config } from "../config/env.js";
import { staffGateMode } from "../staff/auth.js";
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
      // Only now is there a database to read the menu out of. Until this lands
      // the store is serving the seed, which is why it belongs here rather than
      // being left to the first staff edit: an edit made against the seed and
      // then written through would overwrite the stored menu.
      await services.menuStore.hydrate();
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

if (staffGateMode() === "open") {
  console.warn(
    `[staff] STAFF_PASSWORD is not set — the staff area at ${config.staffDashboardPath} is open to ` +
      "anyone who reaches it, including the routes that edit the menu and accept uploads. This is " +
      "allowed here because nothing about this deployment looks public; set the password before it " +
      "is. /health reports \"staffAuth\": \"disabled\" until you do.",
  );
} else if (staffGateMode() === "locked") {
  // Loud, and worth being loud about: the shop is up, the staff area is not,
  // and one variable is the whole difference.
  console.error(
    `[staff] STAFF_PASSWORD is not set and this deployment is public — the staff area at ${config.staffDashboardPath} ` +
      "is CLOSED to everyone, staff included, rather than open to everyone. Set STAFF_PASSWORD in the " +
      "Railway dashboard to open it. The customer ordering flow is unaffected. /health reports " +
      "\"staffAuth\": \"unconfigured\" until you do.",
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
