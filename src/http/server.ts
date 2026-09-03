import { config } from "../config/env.js";
import { createServer } from "./app.js";

createServer().listen(config.port, () => {
  console.log(`fish-chips-order listening on ${config.publicBaseUrl}`);
});
