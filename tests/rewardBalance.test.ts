/**
 * What the shop actually gives away per play.
 *
 * This is the test that would have caught the thing nobody caught: making the
 * reel kind enough for a six-year-old moved the bill from RM3.49 a play to
 * RM3.92 **without a single odd changing**, because scores went up and the
 * score tilts the roll. Neither file was wrong on its own. The pair was.
 *
 * So this one deliberately spans both. It drives the **real reel** from
 * `src/web/fishing.js` over a mix of ways people actually play, and prices the
 * result against the **real table** in `src/game/rewards.ts`. A change to
 * either — a wider band, a gentler tension, a bumped `skillBias`, a retuned
 * weight — moves the number this asserts.
 *
 * The payout is computed over the whole distribution rather than at its mean,
 * because it is not linear in the score: averaging first and pricing after
 * gives a different, wrong answer.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { REWARD_TABLE, weightsFor } from "../src/game/rewards.js";

const game: any = await import(pathToFileURL(resolve(process.cwd(), "src/web/fishing.js")).href);

/**
 * The order the baseline was measured on: one Classic Battered Dory, RM16.90.
 *
 * Fixed here rather than read from the menu on purpose — this is a yardstick,
 * and a yardstick that changes when somebody edits a price measures nothing.
 */
const SUBTOTAL_SEN = 1690;

/** What each tier costs the shop on that order, in sen. */
const COST_SEN: Record<string, number> = {
  small_fry: 200,
  uncommon: Math.round(SUBTOTAL_SEN * 0.1),
  rare: 490,
  jackpot: 1000,
};

/** The baseline this is tuned to hold: measured before the reel was made easy. */
const TARGET_SEN = 349;
const TARGET_JACKPOT = 10;

const seeded = (start: number): (() => number) => {
  let state = start;
  return () => (state = ((state * 9301 + 49297) % 233280) / 233280);
};

const middleOfBand = (state: any): boolean => state.tension < (state.zone.low + state.zone.high) / 2;

/**
 * How a dining room plays, and how common each way is.
 *
 * A judgement, not a measurement — but an explicit one, which is the point: it
 * is written down where it can be argued with, rather than hidden in a single
 * "typical score" someone picked once. Most people who open the game engage
 * with it, a fair number do the obvious thing and aim at the middle of the bar,
 * and a few never really play.
 */
const DINING_ROOM = [
  { name: "follows the band", share: 0.45, lagMs: 0, decide: middleOfBand },
  { name: "follows it slowly", share: 0.25, lagMs: 400, decide: middleOfBand },
  { name: "aims at the middle of the bar", share: 0.2, lagMs: 300, decide: (s: any) => s.tension < 0.5 },
  { name: "taps at random", share: 0.07, lagMs: 300, decide: (_s: any, r: () => number) => r() < 0.5 },
  { name: "never touches it", share: 0.03, lagMs: 0, decide: () => false },
];

/** One reel, played by one strategy, returning the score the server would be sent. */
function playOnce(strategy: (typeof DINING_ROOM)[number], random: () => number): number {
  const reel = game.createReel({ golden: random() < game.GOLDEN_CHANCE, random });
  let holding = true;
  let since = Number.MAX_SAFE_INTEGER;
  let state: any = null;

  for (let frame = 0; frame < 2000; frame += 1) {
    state = reel.step(16, holding);
    since += 16;
    if (since >= strategy.lagMs) {
      holding = strategy.decide(state, random);
      since = 0;
    }
    if (state.done) break;
  }
  return reel.score();
}

/** Every score the room produces, each carrying its share of one play. */
function scoreSample(runsPer = 250): { score: number; weight: number }[] {
  const sample: { score: number; weight: number }[] = [];
  for (const [index, strategy] of DINING_ROOM.entries()) {
    // Seeded per strategy, so this measures the reel rather than the afternoon.
    const random = seeded((index + 1) / (DINING_ROOM.length + 1));
    for (let run = 0; run < runsPer; run += 1) {
      sample.push({ score: playOnce(strategy, random), weight: strategy.share / runsPer });
    }
  }
  return sample;
}

/** The bill, and the jackpot rate, over a whole sample of plays. */
function payout(sample: { score: number; weight: number }[]) {
  let sen = 0;
  let jackpot = 0;
  let meanScore = 0;

  for (const { score, weight } of sample) {
    // The server's own arithmetic, not a copy of it.
    const weights = weightsFor(score);
    const total = weights.reduce((sum, value) => sum + value, 0);

    for (const [index, spec] of REWARD_TABLE.entries()) {
      const share = weights[index]! / total;
      sen += weight * share * COST_SEN[spec.tier]!;
      if (spec.tier === "jackpot") jackpot += weight * share;
    }
    meanScore += weight * score;
  }
  return { sen, jackpotPercent: jackpot * 100, meanScore };
}

const sample = scoreSample();
const measured = payout(sample);

describe("what a play costs the shop", () => {
  it(`gives away about RM${(TARGET_SEN / 100).toFixed(2)} a play on a RM16.90 order`, () => {
    // Twenty sen either side. Tight enough that the drift which started this —
    // RM3.49 to RM3.92, from a change that touched no odds at all — fails here,
    // and loose enough not to break on a rounding tweak.
    expect(
      Math.abs(measured.sen - TARGET_SEN),
      `giving away RM${(measured.sen / 100).toFixed(2)} a play (mean score ${measured.meanScore.toFixed(1)})`,
    ).toBeLessThan(20);
  });

  it("lands a jackpot about one play in ten", () => {
    expect(
      Math.abs(measured.jackpotPercent - TARGET_JACKPOT),
      `jackpot rate is ${measured.jackpotPercent.toFixed(1)}%`,
    ).toBeLessThan(1.5);
  });

  it("is measured over the spread of scores, not at their average", () => {
    // The payout is not linear in the score, so pricing the mean gives a
    // different answer from pricing the plays. If they ever agree exactly,
    // something has collapsed the distribution.
    const atMean = payout([{ score: measured.meanScore, weight: 1 }]);
    expect(atMean.sen).not.toBe(measured.sen);
    // And the room really is a spread: a single strategy would be a flat line.
    expect(new Set(sample.map((entry) => entry.score)).size).toBeGreaterThan(1);
  });

  it("is still a game where playing well pays better", () => {
    // The rebalance pulled the tilt back; it did not remove it. A flat table
    // would hit the cost target too, and would make the reel pointless.
    const lazy = payout([{ score: 0, weight: 1 }]);
    const perfect = payout([{ score: 100, weight: 1 }]);

    expect(perfect.sen).toBeGreaterThan(lazy.sen);
    expect(perfect.jackpotPercent).toBeGreaterThan(lazy.jackpotPercent * 1.8);
  });

  it("never gives away more than the worst case, whatever anyone scores", () => {
    // The ceiling: a table full of perfect reels. Worth knowing, and worth
    // failing on if a future tweak ever puts it somewhere alarming.
    const perfect = payout([{ score: 100, weight: 1 }]);
    expect(perfect.sen).toBeLessThan(450);
  });
});

/**
 * The two halves, named.
 *
 * If this file fails, one of these two changed — and the point of splitting
 * them out is that the failure message says which.
 */
describe("the pair this balance depends on", () => {
  it("prices the reel that is actually shipped", () => {
    // A sanity check on the harness rather than the balance: if the reel became
    // unwinnable or trivial, the mix above would stop describing anything real.
    const scores = sample.map((entry) => entry.score);
    expect(Math.max(...scores)).toBeGreaterThan(90);
    expect(Math.min(...scores)).toBeLessThan(30);

    // The mean is the guard on the *reel*, and it has to be a tight one,
    // because the rebalanced curve is deliberately shallow: measured, halving
    // the safe band only moves the bill by 13 sen and nearly doubling it by 4.
    // That is a good property — the shop's cost barely depends on reel tuning
    // any more — but it means the money assertions above cannot notice a reel
    // change on their own. This is what notices. Shipped value: 87.6.
    expect(measured.meanScore, "the reel got harder or easier").toBeGreaterThan(80);
    expect(measured.meanScore, "the reel got harder or easier").toBeLessThan(95);
  });

  it("prices the table that is actually shipped", () => {
    // Every tier still reachable at both ends — the guarantee the whole feature
    // rests on — and the biases still in tier order.
    for (const score of [0, 100]) {
      for (const weight of weightsFor(score)) expect(weight).toBeGreaterThan(0);
    }
    const biases = REWARD_TABLE.map((spec) => spec.skillBias);
    expect([...biases]).toEqual([...biases].sort((left, right) => left - right));
  });
});
