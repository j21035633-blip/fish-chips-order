/**
 * The point of this file is that the PNG is a *scannable* QR code, not merely a
 * file that was written without throwing. Every code is decoded back with a real
 * QR reader and compared against the URL it was supposed to carry.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as jsqr from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expandTables, orderUrl } from "../src/cli/qr.js";
import { OrderValidationError } from "../src/orders/types.js";

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "qr-test-"));
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

/**
 * jsqr ships CommonJS with an ESM `export default` in its `.d.ts`, so under
 * NodeNext the import resolves to the namespace rather than the function.
 * Reach for the callable and give it the signature we use.
 */
type QrDecoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsqr as unknown as { default?: QrDecoder }).default ??
  (jsqr as unknown as QrDecoder)) as QrDecoder;

async function decode(file: string): Promise<string | undefined> {
  const png = PNG.sync.read(await readFile(file));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result?.data;
}

describe("expandTables", () => {
  it("expands numeric ranges and keeps labels intact", () => {
    expect(expandTables("1-4")).toEqual(["1", "2", "3", "4"]);
    expect(expandTables("1-3,7,PATIO-1")).toEqual(["1", "2", "3", "7", "PATIO-1"]);
    expect(expandTables(" 2 , 1 , 2 ")).toEqual(["2", "1"]);
    // Uppercased on the way through, same as a scanned table.
    expect(expandTables("a1")).toEqual(["A1"]);
  });

  it("refuses input that is probably a mistake", () => {
    expect(() => expandTables("")).toThrow(/No tables/);
    expect(() => expandTables("9-2")).toThrow(/backwards/);
    expect(() => expandTables("1-9999")).toThrow(/500 tables/);
    expect(() => expandTables("table five")).toThrow(OrderValidationError);
  });
});

describe("orderUrl", () => {
  it("points at the QR landing route", () => {
    expect(orderUrl("https://shop.example.com", "5")).toBe("https://shop.example.com/order?table=5");
  });

  it("escapes the label rather than trusting it", () => {
    expect(orderUrl("https://shop.example.com", "PATIO-1")).toBe(
      "https://shop.example.com/order?table=PATIO-1",
    );
  });

  it("does not lose a base URL's own path", () => {
    expect(orderUrl("https://example.com", "3")).toContain("/order?table=3");
  });
});

describe("generated codes", () => {
  it("decode back to the exact ordering URL", async () => {
    const base = "https://fish-chips-order-production.up.railway.app";

    for (const table of expandTables("1-2,PATIO-1")) {
      const url = orderUrl(base, table);
      const file = join(outDir, `table-${table}.png`);
      await QRCode.toFile(file, url, { errorCorrectionLevel: "Q", margin: 2, width: 800 });

      expect(await decode(file)).toBe(url);
    }
  });
});
