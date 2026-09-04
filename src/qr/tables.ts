import QRCode from "qrcode";

import { parseTableNumber } from "../orders/types.js";

/**
 * Table QR codes: the table list, the URL each code carries, and the image.
 *
 * Its own module rather than living in the CLI, because there are two callers
 * now — `npm run qr`, which writes PNGs to print, and the staff page, which
 * shows them on screen. Importing the CLI to reach these would have run its
 * `main()` as a side effect.
 */

/** More than this in one go is a typo, not a dining room. */
export const MAX_TABLES = 200;

/**
 * A sticker on a table in a chip shop gets smudged and splashed. Level "Q"
 * survives about 25% of the code being unreadable.
 */
const ERROR_CORRECTION = "Q" as const;

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

  if (seen.size === 0) throw new Error("No tables given. Try 1-12");
  return [...seen];
}

/**
 * Where a code points. `/order?table=N` always opens a fresh session — see
 * `renderTableLanding` in the web app — so the previous diner's cart can never
 * be inherited by whoever scans next.
 */
export function orderUrl(baseUrl: string, table: string): string {
  const url = new URL("/order", baseUrl);
  url.searchParams.set("table", table);
  return url.toString();
}

export interface TableCode {
  table: string;
  url: string;
  /** The QR image as a `data:image/png;base64,…` URI, ready for `<img src>`. */
  png: string;
}

/**
 * One code per table, as data URIs.
 *
 * Data URIs rather than files: the staff page shows them, prints them and lets
 * a browser save them without the server having to keep a directory of images
 * around and serve it. `width` is generous because these get printed — a code
 * scaled up from a small bitmap prints soft, and a soft code is one a phone
 * gives up on.
 */
export async function tableCodes(baseUrl: string, tables: string[], width = 600): Promise<TableCode[]> {
  return Promise.all(
    tables.map(async (table) => {
      const url = orderUrl(baseUrl, table);
      return {
        table,
        url,
        png: await QRCode.toDataURL(url, { errorCorrectionLevel: ERROR_CORRECTION, margin: 2, width }),
      };
    }),
  );
}

/** The same code, straight to a file. Used by `npm run qr`. */
export async function writeTableCode(file: string, url: string, width = 800): Promise<void> {
  await QRCode.toFile(file, url, { errorCorrectionLevel: ERROR_CORRECTION, margin: 2, width });
}
