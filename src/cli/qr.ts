import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import QRCode from "qrcode";

import { config } from "../config/env.js";
import { parseTableNumber } from "../orders/types.js";

/**
 * Generates the scannable QR code for each table.
 *
 *   npm run qr -- --tables 1-12
 *   npm run qr -- --tables 1-8,PATIO-1,PATIO-2
 *   npm run qr -- --tables 1-12 --base-url https://order.example.com --out qr
 *
 * Each code points at `<base>/order?table=<n>`, which always opens a fresh
 * session — see `renderTableLanding` in the web app.
 *
 * A script rather than an admin page on purpose: there is no staff auth yet
 * (JWT for staff/admin is a later phase), and an unauthenticated route that
 * mints table codes is not something to leave on a public deployment.
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

/**
 * Expands "1-4,7,A1" into ["1", "2", "3", "4", "7", "A1"].
 *
 * Ranges apply to plain numbers only; "A1-A4" is a label, not a range, because
 * there is no sensible way to count between arbitrary labels.
 */
export function expandTables(spec: string): string[] {
  const seen = new Set<string>();

  for (const part of spec.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) throw new Error(`"${part}" counts backwards.`);
      if (to - from > 500) throw new Error(`"${part}" is more than 500 tables; that is probably a typo.`);
      for (let table = from; table <= to; table += 1) seen.add(parseTableNumber(String(table)));
      continue;
    }
    seen.add(parseTableNumber(part));
  }

  if (seen.size === 0) throw new Error("No tables given. Try --tables 1-12");
  return [...seen];
}

export function orderUrl(baseUrl: string, table: string): string {
  const url = new URL("/order", baseUrl);
  url.searchParams.set("table", table);
  return url.toString();
}

/** A print sheet, because twelve loose PNGs are not what anyone actually wants. */
function printSheet(entries: { table: string; file: string; url: string }[]): string {
  const cards = entries
    .map(
      ({ table, file, url }) => `      <figure class="card">
        <img src="${file}" alt="QR code for table ${table}" />
        <figcaption><strong>Table ${table}</strong><span>${url}</span></figcaption>
      </figure>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Table QR codes — Anchor &amp; Batter</title>
    <style>
      body { font: 14px system-ui, sans-serif; margin: 24px; }
      h1 { font-size: 18px; }
      .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 20px; }
      .card { margin: 0; padding: 14px; border: 1px solid #ddd; border-radius: 10px; text-align: center; break-inside: avoid; }
      .card img { width: 100%; height: auto; }
      figcaption { display: grid; gap: 4px; margin-top: 8px; }
      figcaption span { font-size: 10px; color: #666; word-break: break-all; }
      @media print { body { margin: 0; } .card { border-color: #999; } }
    </style>
  </head>
  <body>
    <h1>Table QR codes</h1>
    <div class="sheet">
${cards}
    </div>
  </body>
</html>
`;
}

async function main(): Promise<void> {
  const tables = expandTables(flag("tables") ?? "");
  const baseUrl = flag("base-url") ?? config.publicBaseUrl;
  const outDir = resolve(flag("out") ?? "qr");

  await mkdir(outDir, { recursive: true });

  const entries: { table: string; file: string; url: string }[] = [];

  for (const table of tables) {
    const url = orderUrl(baseUrl, table);
    const file = `table-${table}.png`;
    await QRCode.toFile(join(outDir, file), url, {
      // A sticker on a table in a chip shop gets smudged; "Q" survives ~25% damage.
      errorCorrectionLevel: "Q",
      margin: 2,
      width: 800,
    });
    entries.push({ table, file, url });
    console.log(`table ${table.padEnd(8)} ${file}  ${url}`);
  }

  await writeFile(join(outDir, "index.html"), printSheet(entries), "utf8");
  console.log(`\n${entries.length} code(s) in ${outDir}`);
  console.log(`Open ${join(outDir, "index.html")} to print them.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
