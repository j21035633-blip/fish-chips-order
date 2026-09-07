/**
 * The fishing game, as the customer plays it.
 *
 * Cast, wait for the bite, reel, land it. Every one of those is a touch
 * gesture, because this page is opened by scanning a QR at a table and the only
 * input is a thumb — often a small one. This is played in a restaurant, by
 * children sitting next to their parents, so the whole thing is pitched to be
 * cheerful and easy rather than tense: bright water, cartoon fish, a forgiving
 * reel, and nothing anywhere that grades one catch against another.
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

/** How far a thumb must travel to count as a cast, in px. Short, so a small flick counts. */
const CAST_DISTANCE = 40;

// ------------------------------------------------------------------ the reel
/**
 * Half the width of the safe zone, as a fraction of the tension bar.
 *
 * Reel too gently and the fish does not come in; reel too hard and the line
 * goes tight. Neither *loses* the fish — see `step` — because the reward is
 * guaranteed and a fail state here would be a chance somebody earned and then
 * had taken away.
 *
 * **The zone moves**, dragged up and down the bar by the fish, and that is the
 * whole of the difficulty. A fixed band is beaten by flapping at the screen at
 * random — measured, that scored 98 out of 100 — because the tension rises and
 * falls at similar rates and simply oscillates inside it. Against a band that
 * wanders, holding the right pressure means watching where it went.
 *
 * The band is wide and travels slowly, which is what makes this a game a small
 * child can win: anybody who tracks it at all scores full marks, even with a
 * 400ms reaction time. Nobody has to be quick.
 */
export const SAFE_HALF_WIDTH = 0.19;
/** A golden bite is kinder still: the same band, opened out at both ends. */
export const GOLDEN_SLACK = 0.08;
/** How far up and down the bar the band travels. Kept off the ends so it is always reachable. */
const ZONE_LOW = 0.3;
const ZONE_HIGH = 0.7;
/** How fast it wanders. Slow enough to follow with a thumb rather than a reflex. */
const WANDER_MIN = 0.45;
const WANDER_VARY = 0.3;

/** Tension per second, holding and not holding. Gentle, so the bar drifts rather than snaps. */
const RISE_PER_S = 0.55;
const FALL_PER_S = 0.45;
/** Progress per second while the tension is where it should be. */
const GAIN_PER_S = 0.5;
/**
 * And what it makes while the tension is *not*.
 *
 * Forward, not backward. It used to slip back, which meant a child who could
 * not yet track the band watched the fish they had hooked swim away again for
 * twelve seconds — a negative feedback loop on the one screen in this app that
 * is supposed to be a treat. Now the fish always comes closer; how well you
 * reel decides how *quickly*. The score still counts only time spent in the
 * band, so nothing about the skill signal is softened by this.
 */
const TRICKLE_PER_S = 0.13;

/**
 * The longest a reel can run, in ms.
 *
 * With the trickle above, even a reel nobody touches lands in about eight
 * seconds, so this is a backstop rather than a timer anybody waits out. It is
 * deliberately never shown or counted down: a clock ticking towards a reveal is
 * exactly the tension this game does not want.
 */
export const REEL_TIMEOUT_MS = 9000;

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
  const speed = WANDER_MIN + random() * WANDER_VARY;

  /** Where the band sits at a given moment, as a fraction of the bar. */
  function zoneAt(ms) {
    const t = ms / 1000;
    const wander = Math.sin(phase + t * speed) * 0.7 + Math.sin(phase2 + t * speed * 1.7) * 0.3;
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
    inSafeMs += inSafe ? Math.max(0, dtMs) : 0;
    progress = Math.min(1, progress + (inSafe ? GAIN_PER_S : TRICKLE_PER_S) * dt);

    return {
      tension,
      progress,
      inSafe,
      // Where the band is *now*, so the meter can draw the thing being aimed at
      // rather than a rule the player has to infer.
      zone,
      // Landed, one way or the other. The fish always comes in.
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

/** Which side of the band a tension is on. Pure, so the colour can be asserted. */
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
 *
 * `sprite` names a `<symbol>` in the sheet at the top of `index.html`. They are
 * drawn rather than set in emoji because emoji are whatever the phone decides
 * they are — the shark arrived grey and photographic on Windows, on a screen a
 * child is looking at. These are round, smiling and bright, and they look the
 * same on every device.
 */
export const SPECIES = {
  small_fry: [
    { name: "Anchovy", sprite: "sp-anchovy" },
    { name: "Sardine", sprite: "sp-sardine" },
    { name: "Pufferfish", sprite: "sp-puffer" },
  ],
  uncommon: [
    { name: "Sea Bass", sprite: "sp-seabass" },
    { name: "Red Snapper", sprite: "sp-snapper" },
  ],
  rare: [
    { name: "Tiger Squid", sprite: "sp-squid" },
    { name: "Mantis Prawn", sprite: "sp-prawn" },
  ],
  jackpot: [
    { name: "Golden Marlin", sprite: "sp-marlin" },
    { name: "Giant Octopus", sprite: "sp-octopus" },
  ],
};

/**
 * What the game says when something is landed.
 *
 * **Every one of these is a good day.** They are deliberately not graded: the
 * small fry no longer gets "a little one", because a child who catches an
 * anchovy sitting next to a sibling who catches a marlin should not be told
 * they did worse. Every tier is a real reward — the rule the whole feature is
 * built on — and the words have to match it.
 */
export const TIER_SAY = {
  small_fry: "Nice catch!",
  uncommon: "Great job!",
  rare: "Wonderful catch!",
  jackpot: "Amazing catch!",
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
 * A few soft noises, synthesised rather than fetched — no asset to load on a QR
 * scan over a bad connection, and nothing to 404 after a redeploy.
 *
 * **Muted by default, and that is not a detail.** This runs on a customer's own
 * phone at a table in a restaurant; audio nobody asked for is the kind of thing
 * that goes off during somebody else's dinner. The toggle remembers an opt-*in*
 * only — a stored "off", or no answer at all, both stay silent.
 *
 * Everything here is a sine or a triangle at a low gain: round, quiet sounds.
 * No square waves — they buzz, and a buzz beside a prize reads as an alarm —
 * no rising run of notes before a reveal, and nothing that builds. A catch gets
 * a short chime that is over before it could become a drumroll.
 */
const SOUND_KEY = "fishchips.sound";
/** Nothing is allowed to be louder than this. A game at a dinner table is background. */
export const MAX_GAIN = 0.035;

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

  /** One soft blip. Everything below is a couple of these. */
  function tone({ freq, to = freq, ms = 160, type = "sine", gain = 0.03, delay = 0 }) {
    const ctx = ready();
    if (!ctx) return;

    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + ms / 1000);
    // A gentle swell in and out. A ramp rather than a stop, or every note ends
    // in a click — and a click would be the sharpest sound in the game.
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(Math.min(MAX_GAIN, gain), at + 0.03);
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
    /** A soft plip, like something small landing in water. */
    splash() {
      tone({ freq: 520, to: 300, ms: 220, type: "sine", gain: 0.03 });
    },
    /** The reel's nudge as the bar crosses in or out of the band. Very quiet; it fires often. */
    tick(high) {
      tone({ freq: high ? 660 : 495, ms: 60, type: "sine", gain: 0.014 });
    },
    /** Two friendly notes. Short enough that it cannot read as suspense. */
    bite() {
      tone({ freq: 440, ms: 130, type: "sine", gain: 0.03 });
      tone({ freq: 587, ms: 150, type: "sine", gain: 0.03, delay: 0.11 });
    },
    /**
     * The catch: a short chime, the same shape for every tier.
     *
     * `big` adds one note rather than making it louder or longer. A flourish
     * that grows into a fanfare is how a reward starts to feel like a jackpot
     * machine, which is the thing this deliberately is not.
     */
    chime(big) {
      const notes = big ? [659, 784, 988] : [659, 880];
      notes.forEach((freq, index) =>
        tone({ freq, ms: 260, type: "triangle", gain: 0.03, delay: index * 0.12 }),
      );
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
  const catchWrap = dialog.querySelector("#fish-catch");
  const catchArt = dialog.querySelector("#fish-catch-use");
  const line = dialog.querySelector("#fish-line-path");
  const shadow = dialog.querySelector("#fish-shadow");
  const ripple = dialog.querySelector("#fish-ripple");
  const burst = dialog.querySelector("#fish-burst");
  const say = dialog.querySelector("#fish-say");
  const action = dialog.querySelector("#fish-action");
  const tension = dialog.querySelector("#fish-tension");
  const tensionFill = dialog.querySelector("#fish-tension-fill");
  const tensionBand = dialog.querySelector("#fish-tension-band");
  const prize = dialog.querySelector("#fish-prize");
  const prizeArt = dialog.querySelector("#fish-prize-use");
  const prizeLabel = dialog.querySelector("#fish-prize-label");
  const prizeSpecies = dialog.querySelector("#fish-prize-species");
  const soundButton = dialog.querySelector("#fish-sound");

  const sound = createSound();

  // idle → waiting → biting → reeling → caught
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

  /**
   * Show or hide an element by the `hidden` **attribute**.
   *
   * Not `el.hidden = …`, which is a property of HTMLElement and simply does not
   * exist on an SVGElement: setting it there assigns a stray JS property and
   * changes nothing on screen. Three of the things this file shows and hides —
   * the float, the caught fish and the shadow under the water — are `<svg>`,
   * and the caught fish silently never appeared because of it.
   */
  function setShown(element, shown) {
    if (shown) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  }

  function paintSound() {
    soundButton.textContent = sound.enabled ? "🔊" : "🔇";
    soundButton.setAttribute("aria-pressed", String(sound.enabled));
    soundButton.setAttribute("aria-label", sound.enabled ? "Turn sound off" : "Turn sound on");
  }

  /** The big button's job changes with the phase, so its words have to as well. */
  function setAction(text) {
    action.textContent = text;
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
    setShown(float, true);
    setShown(catchWrap, false);
    say.textContent = "Tap to throw your line in!";
    setAction("Cast!");
    setShown(action, true);
    line.classList.remove("out");
    setShown(shadow, false);
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
    say.textContent = "Line's in! Watch the float…";
    setAction("Waiting…");
    line.classList.add("out");
    splash();

    // A wait the player cannot predict, so the bite is something to watch for
    // rather than a beat to count out. Short, and never shown as a countdown.
    biteTimer = setTimeout(
      () => {
        phase = "biting";
        golden = random() < GOLDEN_CHANCE;
        stage.className = "fish-stage biting";
        scene.classList.toggle("golden", golden);
        say.textContent = golden ? "A golden fish! Hold the button!" : "A fish! Hold the button!";
        setAction("Hold to reel!");
        splash();
        sound.bite();
        // A bite nobody answers is not a loss — the fish waits.
      },
      700 + random() * 1200,
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
    setShown(shadow, true);
    paintBand(reel.zone);
    say.textContent = "Keep the bar on the green patch!";
    setAction("Hold to reel!");

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
      // The fish, hauled closer as the reel goes well — the progress bar nobody
      // had to be told how to read.
      shadow.style.setProperty("--near", state.progress.toFixed(3));

      if (tone !== lastTone) {
        sound.tick(tone === "high");
        lastTone = tone;
      }

      if (state.done) {
        void land(reel.score());
        return;
      }
      reelFrame = requestAnimationFrame(step);
    };
    reelFrame = requestAnimationFrame(step);
  }

  /**
   * Letting go is not a way to lose it.
   *
   * The tension simply falls while the thumb is up, which is half the skill:
   * the band is held by letting go at the right moment, not by holding on
   * hardest.
   */
  function release() {
    holding = false;
  }

  /**
   * The flourish over a catch: round confetti thrown outward from the fish.
   *
   * Scaled a little by tier so a jackpot feels like more, but never into
   * flashing — the pieces fly out once and fade, and nothing repeats, blinks or
   * strobes. Built from elements, so there is no library and no asset.
   */
  function celebrate(tier) {
    burst.replaceChildren();
    burst.hidden = false;
    if (reduced) return;

    const count = tier === "jackpot" ? 22 : tier === "rare" ? 16 : 10;
    for (let index = 0; index < count; index += 1) {
      const bit = document.createElement("i");
      bit.className = index % 3 === 0 ? "bit star" : "bit";
      // Spread around the fish rather than raining from the top: this is a
      // splash the fish makes, not confetti dropped on it.
      bit.style.setProperty("--angle", `${(360 / count) * index + random() * 12}deg`);
      bit.style.setProperty("--dist", `${44 + random() * (tier === "jackpot" ? 60 : 34)}px`);
      bit.style.setProperty("--delay", `${random() * 140}ms`);
      bit.style.setProperty("--hue", `${Math.floor(random() * 360)}`);
      burst.append(bit);
    }
  }

  async function land(performanceScore) {
    phase = "caught";
    cancelAnimationFrame(reelFrame);
    say.textContent = "Here it comes!";
    setAction("Reeling in…");

    try {
      // The only moment a chance is spent, and the first moment anybody knows
      // what was caught — including this file. The score goes with it and tilts
      // the odds; it does not choose from them.
      const { reward } = await onPlay(performanceScore);
      const species = speciesFor(reward.tier, random);

      stage.className = `fish-stage caught ${reward.tier}`;
      setShown(float, false);
      setShown(catchWrap, true);
      catchArt.setAttribute("href", `#${species.sprite}`);
      say.textContent = TIER_SAY[reward.tier] ?? TIER_SAY.small_fry;
      tension.hidden = true;
      setShown(shadow, false);
      splash();
      celebrate(reward.tier);
      sound.chime(reward.tier === "jackpot" || reward.tier === "rare");

      prizeArt.setAttribute("href", `#${species.sprite}`);
      prizeSpecies.textContent = species.name;
      prizeLabel.textContent = reward.label;
      prize.hidden = false;
      // The line comes back in with the fish, and the big button stands down:
      // once there is a prize on screen the only thing left to do is take it,
      // and a live "Cast!" under a catch invites a tap with no chance to spend.
      line.classList.remove("out");
      setShown(action, false);
    } catch (error) {
      stage.className = "fish-stage";
      tension.hidden = true;
      setShown(shadow, false);
      say.textContent = error.message ?? "Let's try that again.";
      setAction("Cast!");
      phase = "idle";
    }
  }

  // ------------------------------------------------------------------ touch
  // Pointer events, so a mouse behaves the same as a thumb and there is one
  // code path. `touch-action: none` on the stage stops the browser claiming the
  // vertical swipe as a page scroll before any of this sees it.
  //
  // The big button under the water sits inside the stage, so its presses arrive
  // here by bubbling and need no handlers of their own. It is a bigger target
  // for the same game, which is the whole point of it.
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
