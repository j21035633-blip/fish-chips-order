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
  /** Relative weight at zero performance. These are the base odds; they sum to 100 here. */
  weight: number;
  /**
   * What this tier's weight is multiplied by at a *perfect* reel, interpolated
   * linearly from 1 at zero performance. Above 1 the tier gets likelier as the
   * player gets better; below 1, rarer.
   *
   * Every one of them stays **positive**, which is the load-bearing part: no
   * amount of skill, and no amount of failure, can take a tier off the table.
   * A terrible reel still lands on a real reward and a perfect one can still
   * land on a small fry.
   */
  skillBias: number;
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
  { tier: "small_fry", weight: 55, skillBias: 0.4, kind: "discount_fixed", label: "RM2 off", amountSen: 200 },
  { tier: "uncommon", weight: 25, skillBias: 1.2, kind: "discount_percent", label: "10% off", percent: 10 },
  { tier: "rare", weight: 15, skillBias: 2.4, kind: "free_item", label: "A free Teh Ais", itemId: "drink-teh-ais" },
  { tier: "jackpot", weight: 5, skillBias: 3, kind: "discount_fixed", label: "RM10 off", amountSen: 1000 },
];

/** The base odds' total, at zero performance. */
export const TOTAL_WEIGHT = REWARD_TABLE.reduce((sum, spec) => sum + spec.weight, 0);

/**
 * How well the player reeled, 0–100.
 *
 * This is **reported by the client**, and that is worth being plain about: a
 * browser can send 100 every time. It is allowed to, because of what the score
 * is permitted to do — it *tilts* a weighted roll and nothing else. It cannot
 * name a tier, cannot reach a discount, and cannot empty the table of the low
 * tiers or fill it with jackpots. The worst a liar gets is the odds of somebody
 * who is good at the game, on a chance they had already earned.
 *
 * The alternative — simulating the reel server-side, frame by frame, over a
 * connection that drops in a chip shop — buys accuracy nobody can see in a game
 * whose every outcome is a prize.
 */
export const MAX_PERFORMANCE = 100;

/** Anything a client can put in the field, folded into 0–100. NaN and nonsense become 0. */
export function clampPerformance(score: unknown): number {
  const value = typeof score === "number" && Number.isFinite(score) ? score : 0;
  return Math.min(MAX_PERFORMANCE, Math.max(0, value));
}

/**
 * The weights this roll is actually against, after performance is folded in.
 *
 * At a score of 0 these are exactly `REWARD_TABLE`'s own numbers, so a client
 * that sends no score at all — an old cached page, a request made by hand —
 * plays the odds the game has always had. Nothing regresses by staying silent.
 */
export function weightsFor(score: number): number[] {
  const skill = clampPerformance(score) / MAX_PERFORMANCE;
  return REWARD_TABLE.map((spec) => spec.weight * (1 + (spec.skillBias - 1) * skill));
}

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
 * Rolls one tier against the weights, tilted by how well the player reeled.
 *
 * `random` is injectable so the distribution can be tested against a known
 * sequence rather than by hoping — see `tests/fishing.test.ts`.
 *
 * The loop is the same weighted walk it always was; only the numbers it walks
 * over change. Because every adjusted weight is positive and the target is
 * drawn from their sum, **this always returns a spec** — there is no arithmetic
 * here that can produce a miss, at any score.
 */
export function rollTier(random: () => number = Math.random, performance = 0): TierSpec {
  const weights = weightsFor(performance);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const target = random() * total;
  let running = 0;

  for (const [index, spec] of REWARD_TABLE.entries()) {
    running += weights[index]!;
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
