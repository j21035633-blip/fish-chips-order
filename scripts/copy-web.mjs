// tsc only emits JS, so the customer page's html/css/js never reach dist.
// Copy them so dist/ is self-contained and `npm start` works from a pruned
// deploy that has no src/ directory.
import { cpSync, existsSync } from "node:fs";

const from = "src/web";
const to = "dist/web";

if (!existsSync(from)) {
  console.error(`copy-web: ${from} not found`);
  process.exit(1);
}

cpSync(from, to, { recursive: true });
console.log(`copy-web: ${from} -> ${to}`);
