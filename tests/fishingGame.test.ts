/**
 * @vitest-environment jsdom
 *
 * The fishing game as it runs in the page: the reel's physics, the flavour, the
 * sound switch, and the wiring between them and the real markup.
 *
 * The reel is the interesting half. Its physics are pure and frame-rate
 * independent, so this drives them with a script of inputs and a tidy 16ms
 * clock rather than by running an animation and hoping — a skilled player and a
 * hopeless one are two different strategies here, not two different afternoons.
 *
 * What none of it can do is decide a reward. That is asserted next door in
 * `tests/http.test.ts`; here the only claim is that the number this file sends
 * is an honest measure of how the reel went.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webDir = resolve(process.cwd(), "src/web");
const game: any = await import(pathToFileURL(resolve(webDir, "fishing.js")).href);

/** A deterministic uniform source, so a reel is the same reel every run. */
function seeded(start: number): () => number {
  let state = start;
  return () => {
    state = ((state * 9301 + 49297) % 233280) / 233280;
    return state;
  };
}

/**
 * Plays one whole reel with a strategy, 16ms at a time.
 *
 * `decide(state)` returns whether the thumb is down for the next frame — which
 * is the only input the game has.
 */
function playReel(decide: (state: any) => boolean, options: Record<string, unknown> = {}) {
  const reel = game.createReel({ random: seeded(0.37), ...options });
  let holding = true;
  let frames = 0;
  let state: any = null;

  for (;;) {
    state = reel.step(16, holding);
    frames += 1;
    holding = decide(state);
    // The guard is a runaway-loop stop, not the game's own end: 2000 frames is
    // 32 seconds, well past the reel's own 12-second cap.
    if (state.done || frames > 2000) break;
  }
  return { score: reel.score(), ms: frames * 16, timedOut: !!state.timedOut, state };
}

/** Chases the middle of the band, which is what playing well looks like. */
const tracksTheBand = (state: any) => state.tension < (state.zone.low + state.zone.high) / 2;
/** Aims at the middle of the *bar* and ignores where the band went. */
const fixedAim = (state: any) => state.tension < 0.5;

describe("the reel scores skill", () => {
  it("separates playing well from not playing at all", () => {
    const skilled = playReel(tracksTheBand);
    const asleep = playReel(() => false);
    const clenched = playReel(() => true);

    expect(skilled.score).toBeGreaterThan(90);
    // Doing nothing, or doing everything, is worth almost nothing.
    expect(asleep.score).toBeLessThan(10);
    expect(clenched.score).toBeLessThan(10);
  });

  it("is not beaten by flapping at the screen", () => {
    // The reason the band moves. A fixed band this wide scored 98 out of 100
    // against random input, because tension just oscillates inside it — which
    // would have made the score noise rather than a measure of anything.
    const random = seeded(0.11);
    const flapping = playReel(() => random() < 0.5);

    expect(flapping.score).toBeLessThan(35);
  });

  it("rewards watching the band over aiming at one spot", () => {
    // The middle of the bar is a reasonable guess and gets a middling score;
    // following the fish beats it comfortably.
    const lazy = playReel(fixedAim);
    const skilled = playReel(tracksTheBand);

    expect(lazy.score).toBeGreaterThan(25);
    expect(lazy.score).toBeLessThan(80);
    expect(skilled.score).toBeGreaterThan(lazy.score + 20);
  });

  it("stays winnable with a human's reaction time", () => {
    // The same strategy, deciding only every 100ms instead of every frame. A
    // game that needs 16ms reflexes on a phone is not a game.
    const reel = game.createReel({ random: seeded(0.37) });
    let holding = true;
    let since = 0;
    let state: any = null;

    for (let frame = 0; frame < 2000; frame += 1) {
      state = reel.step(16, holding);
      since += 16;
      if (since >= 100) {
        holding = state.tension < (state.zone.low + state.zone.high) / 2;
        since = 0;
      }
      if (state.done) break;
    }
    expect(reel.score()).toBeGreaterThan(85);
  });

  it("reports a score inside 0–100 whatever happens", () => {
    for (const decide of [tracksTheBand, fixedAim, () => true, () => false]) {
      const { score } = playReel(decide);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
    // A reel nobody ever stepped is zero, not a division by zero.
    expect(game.createReel({ random: seeded(0.5) }).score()).toBe(0);
  });
});

/**
 * The guarantee, on the client's side of it: there is no way to be so bad at
 * this that the fish never lands. A reel that never ends would be a chance
 * somebody earned and then never got to spend.
 */
describe("every reel ends in a catch", () => {
  it("lands on the timeout when the player never finds the band", () => {
    const asleep = playReel(() => false);

    expect(asleep.timedOut).toBe(true);
    expect(asleep.ms).toBeLessThanOrEqual(game.REEL_TIMEOUT_MS + 16);
    expect(asleep.state.done).toBe(true);
  });

  it("lands early, and not on the timeout, when the player is good", () => {
    const skilled = playReel(tracksTheBand);

    expect(skilled.timedOut).toBe(false);
    expect(skilled.ms).toBeLessThan(game.REEL_TIMEOUT_MS);
    expect(skilled.state.progress).toBeGreaterThanOrEqual(1);
  });

  it("never lets progress or tension leave their bounds", () => {
    const random = seeded(0.73);
    const reel = game.createReel({ random: seeded(0.21) });

    for (let frame = 0; frame < 800; frame += 1) {
      const state = reel.step(16, random() < 0.5);
      expect(state.tension).toBeGreaterThanOrEqual(0);
      expect(state.tension).toBeLessThanOrEqual(1);
      expect(state.progress).toBeGreaterThanOrEqual(0);
      expect(state.progress).toBeLessThanOrEqual(1);
      if (state.done) break;
    }
  });
});

describe("the golden bite", () => {
  it("opens the band out at both ends", () => {
    const plain = game.createReel({ random: seeded(0.37) });
    const golden = game.createReel({ golden: true, random: seeded(0.37) });

    expect(golden.halfWidth).toBeGreaterThan(plain.halfWidth);
    expect(golden.halfWidth).toBe(game.SAFE_HALF_WIDTH + game.GOLDEN_SLACK);
  });

  it("helps a middling player and is not needed by a good one", () => {
    const average = (golden: boolean, decide: (state: any) => boolean) => {
      let total = 0;
      const runs = 40;
      for (let index = 0; index < runs; index += 1) {
        const reel = game.createReel({ golden, random: seeded((index + 1) / 41) });
        let holding = true;
        let state: any = null;
        for (let frame = 0; frame < 2000; frame += 1) {
          state = reel.step(16, holding);
          holding = decide(state);
          if (state.done) break;
        }
        total += reel.score();
      }
      return total / runs;
    };

    // "Slightly improves the odds for that one catch" — a real lift for someone
    // having a hard time, and nothing at all for someone who was already
    // tracking the band. It is a kindness, not a second mechanic.
    expect(average(true, fixedAim)).toBeGreaterThan(average(false, fixedAim) + 5);
    expect(average(true, tracksTheBand)).toBeCloseTo(average(false, tracksTheBand), 0);
  });

  it("is rare enough to be a surprise and common enough to be seen", () => {
    expect(game.GOLDEN_CHANCE).toBeGreaterThan(0.05);
    expect(game.GOLDEN_CHANCE).toBeLessThan(0.25);
  });
});

describe("the tension colour", () => {
  it("reads safe inside the band and names which side it left on", () => {
    const zone = { low: 0.3, high: 0.6 };

    expect(game.tensionTone(0.45, zone)).toBe("safe");
    // Inclusive at both edges, or the band is narrower than it is drawn.
    expect(game.tensionTone(0.3, zone)).toBe("safe");
    expect(game.tensionTone(0.6, zone)).toBe("safe");
    expect(game.tensionTone(0.61, zone)).toBe("high");
    expect(game.tensionTone(0.29, zone)).toBe("low");
  });
});

describe("the fish are flavour and nothing more", () => {
  it("offers two or three species for every tier", () => {
    for (const tier of ["small_fry", "uncommon", "rare", "jackpot"]) {
      const list = game.SPECIES[tier];
      expect(list.length, tier).toBeGreaterThanOrEqual(2);
      expect(list.length, tier).toBeLessThanOrEqual(3);
      for (const species of list) {
        expect(typeof species.name, tier).toBe("string");
        expect(species.name.length, tier).toBeGreaterThan(0);
        expect(species.fish.length, tier).toBeGreaterThan(0);
      }
    }
    expect(game.SPECIES.jackpot.map((s: any) => s.name)).toContain("Golden Marlin");
  });

  it("picks one within the tier, at both ends of the roll", () => {
    expect(game.speciesFor("jackpot", () => 0)).toBe(game.SPECIES.jackpot[0]);
    // Not off the end of the array when the roll comes back just under 1.
    expect(game.speciesFor("jackpot", () => 0.999999)).toBe(game.SPECIES.jackpot.at(-1));
    expect(game.SPECIES.small_fry).toContain(game.speciesFor("small_fry", () => 0.5));
  });

  it("falls back rather than throwing on a tier it has never heard of", () => {
    // A tier added to the server table before this file catches up must not
    // break the animation of a reward the customer has already won.
    const species = game.speciesFor("leviathan", () => 0.5);
    expect(species).toBeDefined();
    expect(typeof species.name).toBe("string");
  });

  it("carries no money, no tier and nothing the bill could read", () => {
    // Purely cosmetic is the requirement, so this asserts the shape rather than
    // trusting the intent: a species is a name and a picture.
    for (const list of Object.values(game.SPECIES) as any[]) {
      for (const species of list) {
        expect(Object.keys(species).sort()).toEqual(["fish", "name"]);
      }
    }
  });
});

describe("sound is off until somebody asks for it", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts muted on a phone that has never been asked", () => {
    // The one that matters: this plays at a table in a restaurant, and audio
    // nobody chose is audio during somebody else's dinner.
    expect(game.createSound().enabled).toBe(false);
  });

  it("stays muted when the stored answer is anything but an explicit yes", () => {
    for (const stored of ["off", "", "true", "1", "ON"]) {
      localStorage.setItem("fishchips.sound", stored);
      expect(game.createSound().enabled, stored).toBe(false);
    }
  });

  it("remembers an opt-in, and lets it be taken back", () => {
    const sound = game.createSound();

    expect(sound.toggle()).toBe(true);
    expect(localStorage.getItem("fishchips.sound")).toBe("on");
    // A fresh page load honours it.
    expect(game.createSound().enabled).toBe(true);

    expect(sound.toggle()).toBe(false);
    expect(game.createSound().enabled).toBe(false);
  });

  it("makes no noise, and throws nothing, while muted", () => {
    // There is no AudioContext in jsdom. Muted, nothing should ever reach for
    // one — which is also what keeps a phone from being asked for audio
    // permission by a game the customer has not turned the sound on for.
    const sound = game.createSound();
    const AudioContext = vi.fn();
    (window as any).AudioContext = AudioContext;

    expect(() => {
      sound.splash();
      sound.bite();
      sound.tick(true);
      sound.fanfare(true);
    }).not.toThrow();
    expect(AudioContext).not.toHaveBeenCalled();
  });
});

/**
 * The mount, against the real markup.
 *
 * The dialog is lifted out of `index.html` rather than written here, so an id
 * renamed in one and not the other fails as a test rather than as a dead game
 * on a customer's phone.
 */
describe("the game, wired to the page", () => {
  const html = readFileSync(resolve(webDir, "index.html"), "utf8");
  const dialogHtml = html.slice(html.indexOf('<dialog id="fish"'), html.indexOf("</dialog>") + 9);

  let dialog: HTMLElement;
  let frames: FrameRequestCallback[];
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    document.body.innerHTML = dialogHtml;
    dialog = document.getElementById("fish")!;
    (dialog as any).showModal = vi.fn();
    (dialog as any).close = vi.fn();

    // Frames are pumped by hand, so a reel takes exactly as long as this test
    // says it does.
    frames = [];
    clock = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs frames until the reel finishes or the budget runs out. */
  function pump(decide: (dialogEl: HTMLElement) => boolean, limit = 1200): void {
    for (let index = 0; index < limit && frames.length > 0; index += 1) {
      const frame = frames.shift()!;
      clock += 16;
      // The thumb goes down or comes up between frames, as a real one does.
      const stage = document.getElementById("fish-stage")!;
      stage.dispatchEvent(new MouseEvent(decide(dialog) ? "pointerdown" : "pointerup", { bubbles: true }));
      frame(clock);
    }
  }

  function mount(onPlay: (score: number) => Promise<unknown>, random = () => 0.5) {
    return game.mountFishing({ dialog, onPlay, onFinished: vi.fn(), random });
  }

  /** Where the band is right now, read back off the meter the player sees. */
  function bandFromMeter(): { low: number; high: number } {
    const band = document.getElementById("fish-tension-band")!;
    const low = Number.parseFloat(band.style.left) / 100;
    const width = Number.parseFloat(band.style.width) / 100;
    return { low, high: low + width };
  }

  function fillFraction(): number {
    return Number.parseFloat(document.getElementById("fish-tension-fill")!.style.width) / 100;
  }

  it("goes cast → bite → reel → catch, and sends a real score with the play", async () => {
    // Typed with the score it receives, so the assertion below reads a real
    // argument rather than an inferred empty tuple.
    const onPlay = vi.fn(async (_score: number) => ({ reward: { tier: "rare", label: "A free Teh Ais" } }));
    mount(onPlay).open();

    const stage = document.getElementById("fish-stage")!;
    const say = document.getElementById("fish-say")!;
    expect(say.textContent).toContain("cast");

    // Cast — a tap is a cast, the same as a swipe.
    stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(stage.className).toContain("waiting");
    expect(document.getElementById("fish-line-path")!.classList.contains("out")).toBe(true);

    // The bite is on an unpredictable timer; 0.5 puts it at 1800ms.
    await vi.advanceTimersByTimeAsync(2000);
    expect(stage.className).toContain("biting");
    expect(say.textContent).toContain("reel");

    // Reel, tracking the band the meter is showing.
    stage.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.getElementById("fish-tension")!.hidden).toBe(false);

    pump(() => {
      const band = bandFromMeter();
      return fillFraction() < (band.low + band.high) / 2;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onPlay).toHaveBeenCalledTimes(1);
    const score = onPlay.mock.calls[0]![0];
    expect(typeof score).toBe("number");
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    // Playing well, through the real DOM, has to actually score well — this is
    // the end-to-end version of the physics tests above.
    expect(score).toBeGreaterThan(60);
  });

  it("shows the species and the server's own label on the catch", async () => {
    const onPlay = vi.fn(async () => ({ reward: { tier: "jackpot", label: "RM10 off" } }));
    mount(onPlay).open();

    document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000);
    document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    pump(() => {
      const band = bandFromMeter();
      return fillFraction() < (band.low + band.high) / 2;
    });
    await vi.advanceTimersByTimeAsync(0);

    // The label is the server's, verbatim — this file never writes a reward.
    expect(document.getElementById("fish-prize-label")!.textContent).toBe("RM10 off");
    expect(document.getElementById("fish-prize")!.hidden).toBe(false);
    const species = document.getElementById("fish-prize-species")!.textContent!;
    expect(game.SPECIES.jackpot.map((s: any) => s.name)).toContain(species);
    expect(document.getElementById("fish-stage")!.className).toContain("jackpot");
  });

  it("throws a bigger celebration for a bigger fish", async () => {
    async function burstFor(tier: string): Promise<number> {
      document.body.innerHTML = dialogHtml;
      dialog = document.getElementById("fish")!;
      (dialog as any).showModal = vi.fn();
      frames = [];
      clock = 0;

      mount(async () => ({ reward: { tier, label: "Something" } })).open();
      document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(2000);
      document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      pump(() => {
        const band = bandFromMeter();
        return fillFraction() < (band.low + band.high) / 2;
      });
      await vi.advanceTimersByTimeAsync(0);
      return document.getElementById("fish-burst")!.childElementCount;
    }

    const small = await burstFor("small_fry");
    const jackpot = await burstFor("jackpot");

    expect(small).toBeGreaterThan(0);
    expect(jackpot).toBeGreaterThan(small * 2);
  });

  it("keeps the sound button muted, and off the cast", async () => {
    mount(async () => ({ reward: { tier: "small_fry", label: "RM2 off" } })).open();

    const button = document.getElementById("fish-sound")!;
    const stage = document.getElementById("fish-stage")!;

    expect(button.textContent).toBe("🔇");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    // Tapping it must not also cast the line — it sits inside the stage's own
    // click target's sheet, and a mute that starts the game would be a trap.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("🔊");
    expect(stage.className).not.toContain("waiting");

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("surfaces a refused play instead of pretending something was caught", async () => {
    // The server is the one that says no — a spent chance, a dead connection.
    const onPlay = vi.fn(async () => {
      throw new Error("No chances left.");
    });
    mount(onPlay).open();

    document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000);
    document.getElementById("fish-stage")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    pump(() => {
      const band = bandFromMeter();
      return fillFraction() < (band.low + band.high) / 2;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById("fish-say")!.textContent).toBe("No chances left.");
    // No prize, and nothing pretending to be one.
    expect(document.getElementById("fish-prize")!.hidden).toBe(true);
    expect(document.getElementById("fish-tension")!.hidden).toBe(true);
  });
});
