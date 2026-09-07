/**
 * The Play QR: a second way into the same session.
 *
 * The whole claim being tested is that it is *not* a second session. It is the
 * Order URL with one parameter on it, so it carries the same table, opens the
 * same kind of fresh cart and spends the same chances — and the parameter only
 * decides which screen is on top when the page has finished loading.
 *
 * The codes are decoded with a real QR reader rather than trusted, for the same
 * reason the existing suite does it: the failure worth catching is a code that
 * renders and does not scan.
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import * as jsqr from "jsqr";

import { orderUrl, playUrl, PLAY_VIEW, tableCodes } from "../src/qr/tables.js";

const BASE = "https://order.example.com";

/**
 * jsqr ships CommonJS with an ESM `export default` in its `.d.ts`, so under
 * NodeNext the import resolves to the namespace rather than the function.
 * Same reach-through as `tests/qr.test.ts`.
 */
type QrDecoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR = ((jsqr as unknown as { default?: QrDecoder }).default ??
  (jsqr as unknown as QrDecoder)) as QrDecoder;

/** Reads a data-URI QR back with a real decoder. */
function decode(dataUri: string): string | undefined {
  const png = PNG.sync.read(Buffer.from(dataUri.split(",")[1]!, "base64"));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
}

describe("the Play URL", () => {
  it("is the Order URL with one parameter added", () => {
    const order = new URL(orderUrl(BASE, "5"));
    const play = new URL(playUrl(BASE, "5"));

    // Same origin, same path, same table. Nothing about the session differs.
    expect(play.origin).toBe(order.origin);
    expect(play.pathname).toBe(order.pathname);
    expect(play.searchParams.get("table")).toBe("5");
    expect(play.searchParams.get("view")).toBe(PLAY_VIEW);

    // And it really is only the one parameter.
    play.searchParams.delete("view");
    expect(play.toString()).toBe(order.toString());
  });

  it("carries table labels through unchanged, as the Order URL does", () => {
    expect(playUrl(BASE, "PATIO-1")).toBe(`${BASE}/order?table=PATIO-1&view=${PLAY_VIEW}`);
  });

  it("leaves the Order URL exactly as it was", () => {
    // The existing sticker on every table must keep pointing where it did.
    expect(orderUrl(BASE, "5")).toBe(`${BASE}/order?table=5`);
    expect(orderUrl(BASE, "5")).not.toContain("view=");
  });
});

describe("both codes, per table", () => {
  it("mints an Order and a Play code for each table", async () => {
    const codes = await tableCodes(BASE, ["1", "PATIO-1"]);

    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(code.url).toBe(orderUrl(BASE, code.table));
      expect(code.playUrl).toBe(playUrl(BASE, code.table));
      expect(code.png.startsWith("data:image/png;base64,")).toBe(true);
      expect(code.playPng.startsWith("data:image/png;base64,")).toBe(true);
      // Two different destinations means two different images.
      expect(code.playPng).not.toBe(code.png);
    }
  });

  it("produces codes a phone can actually read, both of them", async () => {
    const [code] = await tableCodes(BASE, ["7"]);

    expect(decode(code!.png)).toBe(`${BASE}/order?table=7`);
    expect(decode(code!.playPng)).toBe(`${BASE}/order?table=7&view=${PLAY_VIEW}`);
  });

  it("points both codes at the same table", async () => {
    // The one that would be a real bug on a wall: a table tent whose Play code
    // opens somebody else's table.
    const [code] = await tableCodes(BASE, ["12"]);
    const scanned = new URL(decode(code!.playPng)!);
    const ordered = new URL(decode(code!.png)!);

    expect(scanned.searchParams.get("table")).toBe("12");
    expect(scanned.searchParams.get("table")).toBe(ordered.searchParams.get("table"));
  });
});
