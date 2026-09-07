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

  it("rewards watching the band, without punishing a rough guess", () => {
    // Aiming at the middle of the bar and ignoring where the band went is what
    // a child who has not worked it out yet does. It is meant to do *well* —
    // this is a game at a dinner table, not a test — while still leaving room
    // above it for somebody who follows the fish.
    const lazy = playReel(fixedAim);
    const skilled = playReel(tracksTheBand);

    expect(lazy.score).toBeGreaterThan(60);
    expect(skilled.score).toBeGreaterThanOrEqual(lazy.score);
    expect(skilled.score).toBeGreaterThan(90);
  });

  it("is winnable by a child who is slow on the button", () => {
    // 400ms between decisions: a young child watching the bar and reacting
    // when they notice. The band is wide and slow precisely so this works.
    const reel = game.createReel({ random: seeded(0.37) });
    let holding = true;
    let since = 0;
    let state: any = null;

    for (let frame = 0; frame < 2000; frame += 1) {
      state = reel.step(16, holding);
      since += 16;
      if (since >= 400) {
        holding = state.tension < (state.zone.low + state.zone.high) / 2;
        since = 0;
      }
      if (state.done) break;
    }
    expect(reel.score()).toBeGreaterThan(85);
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
  it("brings the fish in even for a player who never touches the button", () => {
    // The fish creeps closer the whole time, so a child who is not playing yet
    // still lands one — and does not sit watching a stalled bar for nine
    // seconds first. It finishes on its own, before the backstop.
    const asleep = playReel(() => false);

    expect(asleep.state.done).toBe(true);
    expect(asleep.ms).toBeLessThan(game.REEL_TIMEOUT_MS);
    expect(asleep.timedOut).toBe(false);
  });

  it("never lets progress go backwards, whatever the player does", () => {
    // The old reel took progress *away* outside the band, which meant a child
    // who could not track it watched the fish they had hooked swim off again.
    const random = seeded(0.53);
    const reel = game.createReel({ random: seeded(0.29) });
    let previous = 0;

    for (let frame = 0; frame < 900; frame += 1) {
      const state = reel.step(16, random() < 0.5);
      expect(state.progress).toBeGreaterThanOrEqual(previous);
      previous = state.progress;
      if (state.done) break;
    }
  });

  it("keeps the backstop below it, so nothing can run forever", () => {
    for (const decide of [() => true, () => false, tracksTheBand, fixedAim]) {
      const { ms } = playReel(decide);
      expect(ms).toBeLessThanOrEqual(game.REEL_TIMEOUT_MS + 16);
    }
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
        expect(species.sprite, tier).toMatch(/^sp-[a-z]+$/);
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
        expect(Object.keys(species).sort()).toEqual(["name", "sprite"]);
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
      sound.chime(true);
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
    expect(say.textContent).toContain("Tap");

    // Cast — a tap is a cast, the same as a swipe.
    stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(stage.className).toContain("waiting");
    expect(document.getElementById("fish-line-path")!.classList.contains("out")).toBe(true);

    // The bite is on an unpredictable timer; 0.5 puts it at 1800ms.
    await vi.advanceTimersByTimeAsync(2000);
    expect(stage.className).toContain("biting");
    expect(say.textContent).toContain("Hold");

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

    // The fish has to actually be on screen, in the water, showing the species
    // that was caught. This is asserted through the `hidden` **attribute**
    // rather than the property, because these are <svg> elements: `el.hidden =
    // true` is an HTMLElement property that does nothing at all on an SVG, and
    // the caught fish silently never appeared for exactly that reason.
    const shown = document.getElementById("fish-catch")!;
    expect(shown.hasAttribute("hidden")).toBe(false);
    expect(document.getElementById("fish-float")!.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById("fish-catch-use")!.getAttribute("href")).toMatch(/^#sp-/);
    // And the shadow under the water is put away once the fish is out of it.
    expect(document.getElementById("fish-shadow")!.hasAttribute("hidden")).toBe(true);

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

/**
 * The tone of the thing.
 *
 * This is played in a restaurant, by children sitting next to their parents,
 * and often by two siblings on two phones at one table. That puts real
 * constraints on the words and the noises, and they are the kind that quietly
 * rot — somebody adds a "better luck next time" to the smallest tier, or makes
 * the jackpot chime a little louder, and nobody notices until it is live.
 */
describe("every catch is a good catch", () => {
  const TIERS = ["small_fry", "uncommon", "rare", "jackpot"];

  it("says something plainly happy for every tier", () => {
    for (const tier of TIERS) {
      const said = game.TIER_SAY[tier];
      expect(typeof said, tier).toBe("string");
      expect(said.length, tier).toBeGreaterThan(0);
      expect(said.endsWith("!"), `${tier}: "${said}"`).toBe(true);
    }
  });

  it("never tells anybody they did badly, or did less well than somebody else", () => {
    // The smallest tier is the one at risk: it used to say "A little one!",
    // which is a fine thing to say to an adult and the wrong thing to say to a
    // child whose sibling has just landed a marlin.
    const grading =
      /\b(little|small|tiny|only|just|poor|bad|unlucky|sorry|lose|lost|fail|better luck|next time|at least|nearly|almost)\b/i;

    for (const tier of TIERS) {
      expect(game.TIER_SAY[tier], tier).not.toMatch(grading);
    }
  });

  it("gives the smallest catch the same warmth as the biggest", () => {
    // Not identical words — that would be dull — but the same shape: short,
    // exclaimed and positive, with nothing that reads as a consolation.
    const lengths = TIERS.map((tier) => game.TIER_SAY[tier].length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(12);
    expect(new Set(TIERS.map((tier) => game.TIER_SAY[tier])).size).toBe(4);
  });
});

/**
 * A recording AudioContext, so the noises can be inspected rather than trusted.
 *
 * `tone()` builds an oscillator and then a gain for every note, so the two
 * arrays line up by index.
 */
function captureAudio() {
  const oscillators: any[] = [];
  const gains: any[] = [];

  class FakeContext {
    currentTime = 0;
    state = "running";
    destination = { kind: "destination" };
    createOscillator() {
      const note: any = { type: "sine", freq: 0, start: 0, stop: 0 };
      oscillators.push(note);
      return {
        get type() {
          return note.type;
        },
        set type(value: string) {
          note.type = value;
        },
        frequency: {
          setValueAtTime: (value: number) => {
            note.freq = value;
          },
          exponentialRampToValueAtTime: (value: number) => {
            note.freqTo = value;
          },
        },
        connect: (next: any) => next,
        start: (at: number) => {
          note.start = at;
        },
        stop: (at: number) => {
          note.stop = at;
        },
      };
    }
    createGain() {
      const record: any = { peak: 0 };
      gains.push(record);
      return {
        gain: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: (value: number) => {
            record.peak = Math.max(record.peak, value);
          },
        },
        connect: (next: any) => next,
      };
    }
  }

  (window as any).AudioContext = FakeContext;
  return {
    notes: () => oscillators.map((note, index) => ({ ...note, peak: gains[index]?.peak ?? 0 })),
  };
}

describe("the noises are soft, and none of them build", () => {
  let audio: ReturnType<typeof captureAudio>;
  let sound: any;

  /**
   * A sound that is definitely on.
   *
   * Not merely `toggle()`: the opt-in is remembered, so a second instance in
   * the same test starts enabled and toggling would mute it — which is how this
   * suite first "passed" while recording nothing at all.
   */
  function opted(): any {
    const made = game.createSound();
    if (!made.enabled) made.toggle();
    return made;
  }

  beforeEach(() => {
    localStorage.clear();
    audio = captureAudio();
    // Everything below is about what an opted-in customer actually hears.
    sound = opted();
  });

  it("uses only round waveforms — nothing that buzzes like an alarm", () => {
    sound.splash();
    sound.bite();
    sound.tick(true);
    sound.tick(false);
    sound.chime(true);

    const types = new Set(audio.notes().map((note) => note.type));
    expect([...types].sort()).toEqual(["sine", "triangle"]);
    // A square or a sawtooth is the difference between a chime and a buzzer.
    expect(types.has("square")).toBe(false);
    expect(types.has("sawtooth")).toBe(false);
  });

  it("keeps every note under the ceiling, so nothing carries across a dining room", () => {
    sound.splash();
    sound.bite();
    sound.chime(true);

    for (const note of audio.notes()) {
      expect(note.peak).toBeLessThanOrEqual(game.MAX_GAIN);
    }
    expect(game.MAX_GAIN).toBeLessThan(0.06);
  });

  it("does not make the big catch louder than the small one", () => {
    sound.chime(false);
    const quiet = Math.max(...audio.notes().map((note) => note.peak));

    audio = captureAudio();
    sound = opted();
    sound.chime(true);
    const loud = Math.max(...audio.notes().map((note) => note.peak));

    // A jackpot gets one more note, not more volume. Loudness that escalates
    // with the prize is the sound of a slot machine.
    expect(loud).toBe(quiet);
  });

  it("keeps the catch short, so it cannot become a drumroll", () => {
    sound.chime(true);
    const notes = audio.notes();

    expect(notes.length).toBeLessThanOrEqual(3);
    const span = Math.max(...notes.map((note) => note.stop)) - Math.min(...notes.map((note) => note.start));
    // Well under a second, start to finish. Suspense needs time it is not given.
    expect(span).toBeLessThan(0.8);
  });

  it("has no note that slides upward, which is what tension sounds like", () => {
    sound.splash();
    sound.bite();
    sound.chime(true);

    for (const note of audio.notes()) {
      // The one pitch slide in the game is the splash, and it goes down.
      if (note.freqTo !== undefined) expect(note.freqTo).toBeLessThan(note.freq);
    }
  });
});

/**
 * The parts of "family-friendly" that live in the stylesheet.
 *
 * Read out of the real file, because a touch target and a font size are not
 * things the JS can be asked about — and they are exactly the values that
 * drift a pixel at a time until the game is unusable for a small thumb.
 */
describe("the game is sized for small hands", () => {
  const css = readFileSync(resolve(webDir, "styles.css"), "utf8");
  const html = readFileSync(resolve(webDir, "index.html"), "utf8");

  /** The declarations of the first rule with exactly this selector. */
  function rule(selector: string): string {
    const index = css.indexOf(selector + " {");
    if (index === -1) throw new Error("no rule for " + selector);
    return css.slice(index, css.indexOf("}", index));
  }

  function px(body: string, property: string): number {
    const match = new RegExp(property + "\\s*:\\s*(\\d+(?:\\.\\d+)?)px").exec(body);
    return match ? Number.parseFloat(match[1]!) : Number.NaN;
  }

  it("gives the main control a target far bigger than a fingertip", () => {
    const action = rule(".fish-action");
    expect(px(action, "min-height")).toBeGreaterThanOrEqual(60);
    expect(action).toContain("width: 100%");
    // A real button, so it announces itself and can be reached by keyboard.
    expect(html).toContain('id="fish-action"');
    expect(html).toContain('class="fish-action" type="button"');
  });

  it("keeps the header buttons at 44px, the smallest anybody recommends", () => {
    expect(px(rule(".fish-sound"), "min-width")).toBeGreaterThanOrEqual(44);
    expect(px(rule(".fish-sound"), "min-height")).toBeGreaterThanOrEqual(44);
  });

  it("writes nothing in the game small", () => {
    // Fine print in a game a child is reading is fine print nobody reads.
    for (const selector of [".fish-say", ".prize-species", ".prize-label", ".fish-action"]) {
      expect(px(rule(selector), "font-size"), selector).toBeGreaterThanOrEqual(17);
    }
  });

  it("makes the meter and the water big enough to aim at and to watch", () => {
    expect(px(rule(".tension"), "height")).toBeGreaterThanOrEqual(18);
    expect(px(rule(".sea"), "height")).toBeGreaterThanOrEqual(180);
  });
});

/**
 * No flashing. The rule is simple: nothing in the scene may repeat quickly.
 *
 * Three flashes a second is the accessibility threshold for photosensitivity,
 * and well below that is still the visual grammar of a fruit machine — which is
 * the thing this pass exists to get away from.
 */
describe("nothing flashes", () => {
  const css = readFileSync(resolve(webDir, "styles.css"), "utf8");

  it("has no fast repeating animation anywhere in the scene", () => {
    const repeating = [...css.matchAll(/animation:\s*([a-z-]+)\s+([\d.]+)s[^;]*infinite[^;]*;/g)];
    expect(repeating.length).toBeGreaterThan(0);

    for (const [, name, seconds] of repeating) {
      // Half a second per cycle at the very fastest, which is a sway or a bob
      // rather than a blink.
      expect(Number.parseFloat(seconds!), "@keyframes " + name).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("lets the golden shimmer breathe rather than blink", () => {
    const shimmer = /\.sea\.golden \.shimmer\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const seconds = Number.parseFloat(/animation:\s*shimmer\s+([\d.]+)s/.exec(shimmer)?.[1] ?? "0");
    expect(seconds).toBeGreaterThanOrEqual(2);

    // And it never goes dark between pulses: a glow that swells, not a light
    // being switched on and off.
    const start = css.indexOf("@keyframes shimmer");
    const frames = css.slice(start, css.indexOf("\n}", start));
    for (const [, value] of frames.matchAll(/opacity:\s*([\d.]+)/g)) {
      expect(Number.parseFloat(value!)).toBeGreaterThan(0.4);
    }
  });

  it("throws the celebration once and lets it fade", () => {
    const start = css.indexOf(".bit {");
    const bit = css.slice(start, css.indexOf("}", start));
    expect(bit).toContain("forwards");
    expect(bit).not.toContain("infinite");
  });
});

/** Every species names a sprite, and every sprite is actually drawn. */
describe("the fish are all drawn", () => {
  const html = readFileSync(resolve(webDir, "index.html"), "utf8");

  it("defines a symbol for every species, plus the float and the shadow", () => {
    for (const list of Object.values(game.SPECIES) as any[]) {
      for (const species of list) {
        expect(html, species.name).toContain('<symbol id="' + species.sprite + '"');
      }
    }
    expect(html).toContain('<symbol id="sp-bobber"');
    expect(html).toContain('<symbol id="sp-shadow"');
  });

  it("gives every fish a face, which is the whole point of redrawing them", () => {
    for (const list of Object.values(game.SPECIES) as any[]) {
      for (const species of list) {
        const start = html.indexOf('<symbol id="' + species.sprite + '"');
        const symbol = html.slice(start, html.indexOf("</symbol>", start));
        // A white eye and a rounded smile stroke, on every one of them.
        expect(symbol, species.name).toContain('fill="#fff"');
        expect(symbol, species.name).toContain('stroke-linecap="round"');
      }
    }
  });

  it("uses no emoji for the fish any more", () => {
    // Emoji are whatever the phone decides they are, and one of them decided
    // the shark was a grey photograph.
    const fishing = readFileSync(resolve(webDir, "fishing.js"), "utf8");
    const block = fishing.slice(fishing.indexOf("export const SPECIES"), fishing.indexOf("export const TIER_SAY"));
    expect(block).not.toMatch(/[\u{1F400}-\u{1FAFF}]/u);
  });
});
