import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The one thing the test runner cannot work out for itself.
 *
 * `nav.js` imports the theme module as `/theme.js`, which is the path the
 * *server* publishes it at: the customer web root is mounted at `/` by
 * `express.static(webDir)`, while the staff assets live under a configurable
 * `{{STAFF_BASE}}/assets`. An absolute path is the only one that is stable from
 * both sides, so it is deliberate rather than an oversight — but a bare `/`
 * means the filesystem root to Vite, which is why this alias exists.
 *
 * It mirrors the express mount and nothing else. If the web root ever moves,
 * this moves with it.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\/theme\.js$/,
        replacement: fileURLToPath(new URL("./src/web/theme.js", import.meta.url)),
      },
    ],
  },
});
