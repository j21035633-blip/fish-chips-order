import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { config } from "../config/env.js";
import { expandTables, orderUrl, writeTableCode } from "../qr/tables.js";

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
 * The staff area has the same thing as a page now — Table QR Codes, behind the
 * staff password. This stays for a bulk run from a laptop: writing forty PNGs
 * into a folder is a job for a script, not for a browser.
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
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
    await writeTableCode(join(outDir, file), url);
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
