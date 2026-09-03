import { CURRENCY } from "./types.js";

/** "RM16.90". Ringgit has 2 decimals; sen is the integer unit we store. */
export function formatSen(sen: number): string {
  if (!Number.isInteger(sen)) {
    throw new TypeError(`money must be whole sen, got ${sen}`);
  }
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  return `${sign}RM${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "+RM2.00" / "-RM1.00" / "free" — for option choices, where 0 is common. */
export function formatDelta(sen: number): string {
  if (sen === 0) return "free";
  return sen > 0 ? `+${formatSen(sen)}` : formatSen(sen);
}

export { CURRENCY };
