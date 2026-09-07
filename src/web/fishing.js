/**
 * The fishing game, as the customer plays it.
 *
 * Cast, wait for the bite, reel, land it. Every one of those is a touch
 * gesture, because this page is opened by scanning a QR at a table and the only
 * input is a thumb.
 *
 * **Nothing here decides what is caught.** The tier comes back from
 * `/api/order/fish/play` and this animates it. What the reel *does* produce is
 * a performance score, 0–100, which is sent along with the play and tilts the
 * server's weighted roll — it cannot name a tier, and it cannot reach the
 * money. A player who tampers with this file gets the odds of somebody good at
 * the game, on a chance they had already earned, and nothing else. See
 * `src/game/rewards.ts` for why that trade is the right one.
 *
 * The physics live in `createReel` — pure, frame-rate independent, no DOM — so
 * the scoring can be tested against a script of inputs rather than by driving
 * an animation and hoping.
 */

/** How far a thumb must travel to count as a cast, in px. */
const CAST_DISTANCE = 60;

// ------------------------------------------------------------------ the reel
/**
 * Half the width of the safe zone, as a fraction of the tension bar.
 *
 * Reel too gently and the fish does not come in; reel too hard and the line
 * screams. Neither *loses* the fish — see `step` — because the reward is
 * guaranteed and a fail state here would be a chance somebody earned and then
 * had taken away.
 *
 * **The zone moves**, dragged up and down the bar by the fish, and that is the
 * whole of the difficulty. A fixed band this wide is beaten by flapping at the
 * screen at random — measured, that scored 98 out of 100 — because the tension
 * rises and falls at similar rates and simply oscillates inside it. Against a
 * band that wanders, holding the right pressure means watching where it went.
 */
export const SAFE_HALF_WIDTH = 0.11;
/** A golden bite is kinder: the same band, opened out at both ends. */
export const GOLDEN_SLACK = 0.06;
/** How far up and down the bar the band travels, and how fast. */
const ZONE_LOW = 0.22;
const ZONE_HIGH = 0.78;

/** Tension per second, holding and not holding. */
const RISE_PER_S = 0.95;
const FALL_PER_S = 0.75;
/** Progress per second while the tension is where it should be. */
const GAIN_PER_S = 0.42;
/** And what it slips back at while it is not. Less than it gains: this is pressure, not punishment. */
const SLIP_PER_S = 0.12;

/**
 * The longest a reel can run, in ms.
 *
 * The backstop on "always rewards something": somebody who never once finds the
 * safe zone would otherwise hold a fish that never lands. At the cap it lands
 * anyway, with whatever score they earned — which is allowed to be zero.
 */
export const REEL_TIMEOUT_MS = 12_000;

/**
 * One reel, as a state machine you push time into.
 *
 * `step(dtMs, holding)` advances by a real elapsed interval rather than by a
 * frame, so a slow phone and a fast one play the same game and the test can
 * step in tidy 16ms slices.
 */
export function createReel({ golden = false, random = Math.random } = {}) {
  const halfWidth = golden ? SAFE_HALF_WIDTH + GOLDEN_SLACK : SAFE_HALF_WIDTH;

  let progress = 0;
  let elapsed = 0;
  let inSafeMs = 0;

  // The fish's run, as two sines of different periods. Two rather than one
  // because a single sine is a metronome: learnable in a second and then
  // ignorable. Their sum wanders without ever repeating over a reel this short.
  const phase = random() * Math.PI * 2;
  const phase2 = random() * Math.PI * 2;
  const speed = 0.9 + random() * 0.5;

  /** Where the band sits at a given moment, as a fraction of the bar. */
  function zoneAt(ms) {
    const t = ms / 1000;
    const wander = (Math.sin(phase + t * speed) * 0.7 + Math.sin(phase2 + t * speed * 1.7) * 0.3);
    const centre = (ZONE_LOW + ZONE_HIGH) / 2 + wander * ((ZONE_HIGH - ZONE_LOW) / 2);
    return { low: centre - halfWidth, high: centre + halfWidth };
  }

  // Starting inside the band, so the first instant is not already a mistake.
  let tension = (zoneAt(0).low + zoneAt(0).high) / 2;

  function step(dtMs, holding) {
    const dt = Math.max(0, dtMs) / 1000;
    elapsed += Math.max(0, dtMs);

    tension += (holding ? RISE_PER_S : -FALL_PER_S) * dt;
    tension = Math.min(1, Math.max(0, tension));

    const zone = zoneAt(elapsed);
    const inSafe = tension >= zone.low && tension <= zone.high;
    if (inSafe) {
      inSafeMs += Math.max(0, dtMs);
      progress = Math.min(1, progress + GAIN_PER_S * dt);
    } else {
      progress = Math.max(0, progress - SLIP_PER_S * dt);
    }

    return {
      tension,
      progress,
      inSafe,
      // Where the band is *now*, so the meter can draw the thing being aimed at
      // rather than a rule the player has to infer.
      zone,
      // Landed, or out of patience. Either way the fish comes in.
      done: progress >= 1 || elapsed >= REEL_TIMEOUT_MS,
      timedOut: progress < 1 && elapsed >= REEL_TIMEOUT_MS,
    };
  }

  /**
   * The score that goes to the server: the share of the reel spent in the safe
   * zone, 0–100. Nothing else feeds it — not how fast it was landed, not what
   * was caught, because the catch has not happened yet.
   */
  function score() {
    if (elapsed <= 0) return 0;
    return Math.round(Math.min(100, Math.max(0, (inSafeMs / elapsed) * 100)));
  }

  return { step, score, zoneAt, halfWidth, zone: zoneAt(0) };
}

/** Where on the green→red ramp a tension sits. Pure, so the colour can be asserted. */
export function tensionTone(tension, zone) {
  if (tension >= zone.low && tension <= zone.high) return "safe";
  return tension > zone.high ? "high" : "low";
}

// ---------------------------------------------------------------- the fish
/**
 * Two or three species a tier, purely for flavour.
 *
 * Cosmetic and client-side on purpose: the server decides the *tier*, and
 * which of its fish is on screen changes nothing about the reward. Keeping it
 * here is what stops a display name being frozen onto the cart and carried all
 * the way onto an order.
 */
export const SPECIES = {
  small_fry: [
    { name: "Anchovy", fish: "🐟" },
    { name: "Sardine", fish: "🐟" },
    { name: "Pufferfish", fish: "🐡" },
  ],
  uncommon: [
    { name: "Sea Bass", fish: "🐠" },
    { name: "Red Snapper", fish: "🐠" },
  ],
  rare: [
    { name: "Tiger Squid", fish: "🦑" },
    { name: "Mantis Prawn", fish: "🦐" },
  ],
  jackpot: [
    // There is no marlin in the emoji set, and the first attempt paired the
    // name with a pufferfish — which read, on screen, as a jackpot that had
    // caught something small and round. A shark is the closest thing to a big
    // billfish available and reads as the biggest catch on the board.
    { name: "Golden Marlin", fish: "🦈" },
    { name: "Giant Octopus", fish: "🐙" },
  ],
};

export const TIER_SAY = {
  small_fry: "A little one!",
  uncommon: "Nice catch!",
  rare: "Now that is rare!",
  jackpot: "JACKPOT!",
};

/** One species for a tier. Falls back rather than throwing on a tier it has never heard of. */
export function speciesFor(tier, pick = Math.random) {
  const list = SPECIES[tier] ?? SPECIES.small_fry;
  return list[Math.min(list.length - 1, Math.floor(pick() * list.length))];
}

/** How likely a bite is a golden one. Rare enough to be a surprise, common enough to be seen. */
export const GOLDEN_CHANCE = 0.12;

// --------------------------------------------------------------------- sound
/**
 * Three noises, synthesised rather than fetched — no asset to load on a QR
 * scan over a bad connection, and nothing to 404 after a redeploy.
 *
 * **Muted by default, and that is not a detail.** This runs on a customer's own
 * phone at a table in a restaurant; audio nobody asked for is the kind of thing
 * that goes off during somebody else's dinner. The toggle remembers an opt-*in*
 * only — a stored "off", or no answer at all, both stay silent.
 */
const SOUND_KEY = "fishchips.sound";

export function createSound() {
  let context = null;
  let on = false;
  try {
    on = localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    // Private mode, or storage blocked. Silence is the safe default anyway.
  }

  function ready() {
    if (!on) return null;
    try {
      // Built on first use, not on load: an AudioContext created before a
      // gesture is born suspended, and some browsers log about it.
      context ??= new (window.AudioContext ?? window.webkitAudioContext)();
      if (context.state === "suspended") void context.resume();
      return context;
    } catch {
      return null;
    }
  }

  /** One shaped blip. Everything below is a couple of these. */
  function tone({ freq, to = freq, ms = 120, type = "sine", gain = 0.06, delay = 0 }) {
    const ctx = ready();
    if (!ctx) return;

    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + ms / 1000);
    // A ramp rather than a stop, or every note ends in a click.
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + ms / 1000 + 0.02);
  }

  return {
    get enabled() {
      return on;
    },
    toggle() {
      on = !on;
      try {
        localStorage.setItem(SOUND_KEY, on ? "on" : "off");
      } catch {
        // Not being able to remember the choice is not a reason to refuse it.
      }
      return on;
    },
    splash() {
      tone({ freq: 620, to: 180, ms: 260, type: "triangle", gain: 0.05 });
    },
    /** The reel's click, pitched by where the tension is. Cheap, because it fires often. */
    tick(high) {
      tone({ freq: high ? 880 : 440, ms: 45, type: "square", gain: 0.025 });
    },
    bite() {
      tone({ freq: 300, to: 700, ms: 160, type: "sine", gain: 0.06 });
    },
    fanfare(big) {
      const notes = big ? [523, 659, 784, 1047] : [523, 784];
      notes.forEach((freq, index) => tone({ freq, ms: 220, type: "triangle", gain: 0.05, delay: index * 0.1 }));
    },
  };
}

// --------------------------------------------------------------------- mount
/**
 * Wires the sheet up once. `onPlay(performance)` is called when the reel
 * completes and must resolve with the server's `{ reward }`; everything visual
 * keys off that.
 */
export function mountFishing({ dialog, onPlay, onFinished, random = Math.random }) {
  const stage = dialog.querySelector("#fish-stage");
  const scene = dialog.querySelector("#fish-scene");
  const float = dialog.querySelector("#fish-float");
  // The line is an SVG path so it can arc rather than hang straight down.
  const line = dialog.querySelector("#fish-line-path");
  const shadow = dialog.querySelector("#fish-shadow");
  const ripple = dialog.querySelector("#fish-ripple");
  const burst = dialog.querySelector("#fish-burst");
  const say = dialog.querySelector("#fish-say");
  const tension = dialog.querySelector("#fish-tension");
  const tensionFill = dialog.querySelector("#fish-tension-fill");
  const tensionBand = dialog.querySelector("#fish-tension-band");
  const prize = dialog.querySelector("#fish-prize");
  const prizeTier = dialog.querySelector("#fish-prize-tier");
  const prizeLabel = dialog.querySelector("#fish-prize-label");
  const prizeSpecies = dialog.querySelector("#fish-prize-species");
  const soundButton = dialog.querySelector("#fish-sound");

  const sound = createSound();

  // idle → casting → waiting → biting → reeling → caught
  let phase = "idle";
  let startY = 0;
  let biteTimer = null;
  let reelFrame = null;
  let reel = null;
  let holding = false;
  let lastFrame = 0;
  let lastTone = "safe";
  let golden = false;

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  function paintSound() {
    soundButton.textContent = sound.enabled ? "🔊" : "🔇";
    soundButton.setAttribute("aria-pressed", String(sound.enabled));
    soundButton.setAttribute("aria-label", sound.enabled ? "Mute sound" : "Unmute sound");
  }

  function reset() {
    phase = "idle";
    clearTimeout(biteTimer);
    cancelAnimationFrame(reelFrame);
    reel = null;
    holding = false;
    golden = false;
    stage.className = "fish-stage";
    scene.classList.remove("golden");
    tension.hidden = true;
    tension.className = "tension";
    tensionFill.style.width = "0%";
    prize.hidden = true;
    burst.replaceChildren();
    burst.hidden = true;
    float.textContent = "●";
    say.textContent = "Swipe up to cast.";
    line.classList.remove("out");
    scene.classList.remove("cast");
    shadow.hidden = true;
    shadow.style.setProperty("--near", "0");
    ripple.hidden = true;
    paintSound();
  }

  /** The band the safe zone occupies, drawn on the meter so it can be aimed at. */
  function paintBand(zone) {
    const low = Math.max(0, zone.low);
    const high = Math.min(1, zone.high);
    tensionBand.style.left = `${low * 100}%`;
    tensionBand.style.width = `${Math.max(0, high - low) * 100}%`;
  }

  function splash() {
    ripple.hidden = false;
    // Restarting a CSS animation means taking the element off the layout for a
    // frame; without the reflow read the second cast does not animate at all.
    ripple.classList.remove("go");
    void ripple.offsetWidth;
    ripple.classList.add("go");
    sound.splash();
  }

  function cast() {
    if (phase !== "idle") return;
    phase = "waiting";
    stage.className = "fish-stage waiting";
    say.textContent = "Waiting for a bite…";
    line.classList.add("out");
    scene.classList.add("cast");
    splash();

    // A wait the player cannot predict, so the bite is something to watch for
    // rather than a beat to count out.
    biteTimer = setTimeout(
      () => {
        phase = "biting";
        golden = random() < GOLDEN_CHANCE;
        stage.className = "fish-stage biting";
        scene.classList.toggle("golden", golden);
        float.textContent = "◉";
        say.textContent = golden ? "A golden one! Hold to reel it in." : "Bite! Hold to reel it in.";
        splash();
        sound.bite();
        // A bite nobody answers is not a loss — the fish waits.
      },
      900 + random() * 1800,
    );
  }

  function startReel() {
    if (phase !== "biting") return;
    phase = "reeling";
    reel = createReel({ golden, random });
    holding = true;
    lastFrame = performance.now();
    lastTone = "safe";
    stage.className = golden ? "fish-stage reeling golden" : "fish-stage reeling";
    tension.hidden = false;
    shadow.hidden = false;
    paintBand(reel.zone);
    say.textContent = "Keep the bar in the green!";

    const step = (now) => {
      const dt = Math.min(64, now - lastFrame);
      lastFrame = now;

      const state = reel.step(dt, holding);
      const tone = tensionTone(state.tension, state.zone);

      // The band moves, so it is repainted with the fill rather than once up
      // front — it is the target, and a target drawn where it used to be is
      // worse than none.
      paintBand(state.zone);
      tensionFill.style.width = `${Math.round(state.tension * 100)}%`;
      tension.className = `tension ${tone}`;
      // The fish, hauled closer as the reel goes well and drifting back when it
      // does not — the progress bar nobody had to be told to read.
      shadow.style.setProperty("--near", state.progress.toFixed(3));

      if (tone !== lastTone) {
        sound.tick(tone === "high");
        lastTone = tone;
      }

      if (state.done) {
        void land(reel.score(), state.timedOut);
        return;
      }
      reelFrame = requestAnimationFrame(step);
    };
    reelFrame = requestAnimationFrame(step);
  }

  /**
   * Letting go is no longer a way to lose it.
   *
   * It used to drop the whole reel back to the bite. Now the tension simply
   * falls while the thumb is up, which is half the skill: the safe zone is
   * held by letting go at the right moment, not by holding on hardest.
   */
  function release() {
    holding = false;
  }

  /** The tier-coloured flourish over the catch. Built from divs; no asset, no library. */
  function celebrate(tier) {
    burst.replaceChildren();
    burst.hidden = false;
    if (reduced) return;

    const count = tier === "jackpot" ? 26 : tier === "rare" ? 14 : 6;
    for (let index = 0; index < count; index += 1) {
      const bit = document.createElement("i");
      bit.className = "bit";
      // Spread around the fish rather than raining from the top: this is a
      // splash the fish makes, not confetti dropped on it.
      bit.style.setProperty("--angle", `${(360 / count) * index + random() * 12}deg`);
      bit.style.setProperty("--dist", `${40 + random() * (tier === "jackpot" ? 70 : 35)}px`);
      bit.style.setProperty("--delay", `${random() * 120}ms`);
      burst.append(bit);
    }
  }

  async function land(performanceScore, timedOut) {
    phase = "caught";
    cancelAnimationFrame(reelFrame);
    say.textContent = timedOut ? "It wriggled in anyway…" : "…";

    try {
      // The only moment a chance is spent, and the first moment anybody knows
      // what was caught — including this file. The score goes with it and tilts
      // the odds; it does not choose from them.
      const { reward } = await onPlay(performanceScore);
      const species = speciesFor(reward.tier, random);

      stage.className = `fish-stage caught ${reward.tier}`;
      float.textContent = species.fish;
      say.textContent = TIER_SAY[reward.tier] ?? TIER_SAY.small_fry;
      tension.hidden = true;
      shadow.hidden = true;
      splash();
      celebrate(reward.tier);
      sound.fanfare(reward.tier === "jackpot" || reward.tier === "rare");

      prizeTier.textContent = species.fish;
      prizeSpecies.textContent = species.name;
      prizeLabel.textContent = reward.label;
      prize.hidden = false;
    } catch (error) {
      stage.className = "fish-stage";
      tension.hidden = true;
      shadow.hidden = true;
      say.textContent = error.message ?? "That did not work. Try again.";
      phase = "idle";
    }
  }

  // ------------------------------------------------------------------ touch
  // Pointer events, so a mouse behaves the same as a thumb and there is one
  // code path. `touch-action: none` on the stage stops the browser claiming the
  // vertical swipe as a page scroll before any of this sees it.
  stage.addEventListener("pointerdown", (event) => {
    startY = event.clientY;
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
    if (phase === "biting") startReel();
    else if (phase === "reeling") holding = true;
  });

  stage.addEventListener("pointermove", (event) => {
    if (phase !== "idle") return;
    // Up is negative, and a cast is a flick up.
    if (startY - event.clientY > CAST_DISTANCE) cast();
  });

  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  // A tap is a cast too. The swipe is the nicer gesture, but a game that only
  // answers to a flick is a game some people simply cannot start.
  stage.addEventListener("click", () => {
    if (phase === "idle") cast();
  });

  soundButton.addEventListener("click", (event) => {
    // The stage's own click would read this as a cast.
    event.stopPropagation();
    sound.toggle();
    paintSound();
  });

  dialog.querySelector("#fish-done").addEventListener("click", () => {
    dialog.close();
    onFinished?.();
  });

  return {
    reset,
    open: () => {
      reset();
      dialog.showModal();
    },
  };
}
