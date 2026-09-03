import { services } from "../app/container.js";
import { config } from "../config/env.js";
import { createServer } from "./app.js";

// Connect before listening: a request that arrives first would otherwise race
// the driver's own lazy connect, and index creation would not have run.
await services.storage.connect();

if (services.storage.kind === "memory") {
  console.warn(
    "[storage] MONGODB_URI is not set — carts and orders are held in memory and " +
      "every one of them, paid included, is lost on restart. Do not run like this in production.",
  );
}

createServer(services).listen(config.port, () => {
  console.log(`fish-chips-order listening on ${config.publicBaseUrl} (storage: ${services.storage.kind})`);
});
