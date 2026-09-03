// tsc only emits JS, so the customer page's html/css/js never reach dist.
// Copy them so dist/ is self-contained and `npm start` works from a pruned
// deploy that has no src/ directory.
import { cpSync, existsSync } from "node:fs";

for (const [from, to] of [
  ["src/web", "dist/web"],
  // The staff page is kept out of the customer web root so it is only ever
  // reachable at the path the dashboard is mounted at.
  ["src/staff-web", "dist/staff-web"],
]) {
  if (!existsSync(from)) {
    console.error(`copy-web: ${from} not found`);
    process.exit(1);
  }

  cpSync(from, to, { recursive: true });
  console.log(`copy-web: ${from} -> ${to}`);
}
