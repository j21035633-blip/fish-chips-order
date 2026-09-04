/**
 * The fishing game, as the customer plays it.
 *
 * Cast, wait for the bite, reel. Every one of those is a touch gesture, because
 * this page is opened by scanning a QR at a table and the only input is a thumb.
 *
 * **Nothing here decides anything.** The tier comes back from `/api/order/fish/play`
 * and this animates it; the discount is already on the cart by the time the
 * animation starts. A player who tampers with this file changes the animation
 * and nothing else.
 */

/** How far a thumb must travel to count as a cast, in px. */
const CAST_DISTANCE = 60;
/** How long the reel has to be held, in ms, and how fast tension climbs. */
const REEL_MS = 1400;

const TIER_FACE = {
  small_fry: { fish: "🐟", say: "A little one!" },
  uncommon: { fish: "🐠", say: "Nice catch!" },
  rare: { fish: "🦑", say: "Now that is rare!" },
  jackpot: { fish: "🐡", say: "JACKPOT!" },
};

/**
 * Wires the sheet up once. `play` is called when the reel completes and must
 * resolve with the server's `{ reward }`; everything visual keys off that.
 */
export function mountFishing({ dialog, onPlay, onFinished }) {
  const stage = dialog.querySelector("#fish-stage");
  const float = dialog.querySelector("#fish-float");
  const line = dialog.querySelector("#fish-line");
  const say = dialog.querySelector("#fish-say");
  const tension = dialog.querySelector("#fish-tension");
  const tensionFill = dialog.querySelector("#fish-tension-fill");
  const prize = dialog.querySelector("#fish-prize");
  const prizeTier = dialog.querySelector("#fish-prize-tier");
  const prizeLabel = dialog.querySelector("#fish-prize-label");

  // idle → casting → waiting → biting → reeling → caught
  let phase = "idle";
  let startY = 0;
  let biteTimer = null;
  let reelStart = 0;
  let reelFrame = null;

  function reset() {
    phase = "idle";
    clearTimeout(biteTimer);
    cancelAnimationFrame(reelFrame);
    stage.className = "fish-stage";
    tension.hidden = true;
    tensionFill.style.width = "0%";
    prize.hidden = true;
    float.textContent = "●";
    say.textContent = "Swipe up to cast.";
    line.style.height = "0px";
  }

  function cast() {
    if (phase !== "idle") return;
    phase = "waiting";
    stage.className = "fish-stage waiting";
    say.textContent = "Waiting for a bite…";
    line.style.height = "70px";

    // A wait the player cannot predict, so the bite is something to watch for
    // rather than a beat to count out.
    biteTimer = setTimeout(() => {
      phase = "biting";
      stage.className = "fish-stage biting";
      float.textContent = "◉";
      say.textContent = "Bite! Hold to reel it in.";
      // A bite nobody answers is not a loss — the fish waits.
    }, 900 + Math.random() * 1800);
  }

  function startReel() {
    if (phase !== "biting") return;
    phase = "reeling";
    reelStart = performance.now();
    tension.hidden = false;
    say.textContent = "Reeling…";

    const step = (now) => {
      const held = Math.min(1, (now - reelStart) / REEL_MS);
      tensionFill.style.width = `${Math.round(held * 100)}%`;
      line.style.height = `${Math.round(70 * (1 - held))}px`;

      if (held >= 1) {
        void land();
        return;
      }
      reelFrame = requestAnimationFrame(step);
    };
    reelFrame = requestAnimationFrame(step);
  }

  /** Let go early and the line goes slack — no chance is spent. */
  function slack() {
    if (phase !== "reeling") return;
    cancelAnimationFrame(reelFrame);
    phase = "biting";
    tension.hidden = true;
    tensionFill.style.width = "0%";
    say.textContent = "It slipped! Hold to reel it in.";
  }

  async function land() {
    phase = "caught";
    cancelAnimationFrame(reelFrame);
    say.textContent = "…";

    try {
      // The only moment a chance is spent, and the first moment anybody knows
      // what was caught — including this file.
      const { reward } = await onPlay();
      const face = TIER_FACE[reward.tier] ?? TIER_FACE.small_fry;

      stage.className = "fish-stage caught";
      float.textContent = face.fish;
      say.textContent = face.say;
      tension.hidden = true;

      prizeTier.textContent = face.fish;
      prizeLabel.textContent = reward.label;
      prize.hidden = false;
    } catch (error) {
      stage.className = "fish-stage";
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
  });

  stage.addEventListener("pointermove", (event) => {
    if (phase !== "idle") return;
    // Up is negative, and a cast is a flick up.
    if (startY - event.clientY > CAST_DISTANCE) cast();
  });

  const release = () => {
    if (phase === "reeling") slack();
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  // A tap is a cast too. The swipe is the nicer gesture, but a game that only
  // answers to a flick is a game some people simply cannot start.
  stage.addEventListener("click", () => {
    if (phase === "idle") cast();
  });

  dialog.querySelector("#fish-done").addEventListener("click", () => {
    dialog.close();
    onFinished?.();
  });

  return { reset, open: () => { reset(); dialog.showModal(); } };
}
