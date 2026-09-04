/**
 * The fishing game's reward table, and the roll that picks from it.
 *
 * The whole point of this module is that **the server decides**. The client
 * animates a tier it was told about; it never picks one, and it never applies a
 * discount. Everything that touches money here is an integer count of sen, as
 * everywhere else in this codebase.
 *
 * Every tier is a real reward — there is no miss. A customer who has earned a
 * cast has already left a review, handed over a contact, or spent RM50; sending
 * them away with nothing would be a worse trade than the discount costs.
 */

export const REWARD_TIERS = ["small_fry", "uncommon", "rare", "jackpot"] as const;
export type RewardTier = (typeof REWARD_TIERS)[number];

/** What a tier actually does to the bill. */
export type RewardKind = "discount_fixed" | "discount_percent" | "free_item";

export interface TierSpec {
  tier: RewardTier;
  /** Relative weight. These are the configured odds; they sum to 100 here. */
  weight: number;
  kind: RewardKind;
  /** What the customer is told they caught. */
  label: string;
  /** `discount_fixed` and `jackpot`: money off, in sen. */
  amountSen?: number;
  /** `discount_percent`: percent off the subtotal, applied before tax. */
  percent?: number;
  /** `free_item`: the menu item id that comes free. */
  itemId?: string;
}

/**
 * The table, in one place so tuning it is a single edit.
 *
 * `itemId` points at a real menu item; if the shop deletes it, `applyReward`
 * falls back to a discount of the same value rather than failing the play —
 * losing a customer's earned reward because someone edited the menu would be
 * the wrong way round.
 */
export const REWARD_TABLE: readonly TierSpec[] = [
  { tier: "small_fry", weight: 55, kind: "discount_fixed", label: "RM2 off", amountSen: 200 },
  { tier: "uncommon", weight: 25, kind: "discount_percent", label: "10% off", percent: 10 },
  { tier: "rare", weight: 15, kind: "free_item", label: "A free Teh Ais", itemId: "drink-teh-ais" },
  { tier: "jackpot", weight: 5, kind: "discount_fixed", label: "RM10 off", amountSen: 1000 },
];

export const TOTAL_WEIGHT = REWARD_TABLE.reduce((sum, spec) => sum + spec.weight, 0);

/**
 * A reward as it sits on a session, once won.
 *
 * The tier and the terms are frozen here rather than looked up later: a table
 * retuned next week must not silently change what an unpaid customer was
 * already promised.
 */
export interface Reward {
  id: string;
  tier: RewardTier;
  kind: RewardKind;
  label: string;
  amountSen?: number;
  percent?: number;
  itemId?: string;
  wonAt: string;
}

/**
 * Rolls one tier against the weights.
 *
 * `random` is injectable so the distribution can be tested against a known
 * sequence rather than by hoping — see `tests/fishing.test.ts`.
 */
export function rollTier(random: () => number = Math.random): TierSpec {
  const target = random() * TOTAL_WEIGHT;
  let running = 0;

  for (const spec of REWARD_TABLE) {
    running += spec.weight;
    if (target < running) return spec;
  }
  // Only reachable if `random` returns exactly 1, which Math.random never does.
  return REWARD_TABLE[REWARD_TABLE.length - 1]!;
}

/** Freezes a rolled tier into the reward that goes on the session. */
export function toReward(spec: TierSpec, id: string, wonAt: string): Reward {
  const reward: Reward = { id, tier: spec.tier, kind: spec.kind, label: spec.label, wonAt };
  if (spec.amountSen !== undefined) reward.amountSen = spec.amountSen;
  if (spec.percent !== undefined) reward.percent = spec.percent;
  if (spec.itemId !== undefined) reward.itemId = spec.itemId;
  return reward;
}

/**
 * What the rewards on a session take off a subtotal.
 *
 * Free items are not counted here — they arrive as a zero-priced line, so they
 * are already absent from the subtotal. Percentages are taken off the subtotal
 * *before* other discounts, so two rewards cannot compound into more than the
 * order is worth, and the total is clamped at zero: nobody is ever owed money
 * for eating.
 */
export function discountFor(rewards: readonly Reward[], subtotalSen: number): number {
  const raw = rewards.reduce((total, reward) => {
    if (reward.kind === "discount_fixed") return total + (reward.amountSen ?? 0);
    if (reward.kind === "discount_percent") return total + Math.round((subtotalSen * (reward.percent ?? 0)) / 100);
    return total;
  }, 0);

  return Math.min(raw, subtotalSen);
}
