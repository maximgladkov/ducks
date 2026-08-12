import type { HudState } from "./hud";
import { HUD_HIT_SLOTS, HUD_MAX_SHOTS, hudShotsRemaining } from "./hud";

const digitSrc = (n: number) => `/sprites/hud/digits/${n}.png`;

export function renderHudDom(hud: HudState): void {
  const roundEl = document.getElementById("hud-round");
  if (roundEl) {
    // Text rather than digit sprites, so a run that passes round 9 keeps counting.
    roundEl.textContent = `ROUND ${Math.max(1, Math.floor(hud.round))}`;
  }

  const scoreRoot = document.getElementById("hud-score");
  if (scoreRoot) {
    const text = String(Math.min(999999, Math.max(0, hud.score))).padStart(6, "0");
    const imgs = scoreRoot.querySelectorAll("img");
    imgs.forEach((img, i) => {
      const d = Number(text[i] ?? "0");
      img.src = digitSrc(d);
      img.alt = String(d);
    });
  }

  const shots = hudShotsRemaining(hud);
  document.querySelectorAll<HTMLElement>("#hud-bullets .hud-bullet").forEach((el, i) => {
    el.classList.toggle("on", i < shots && i < HUD_MAX_SHOTS);
  });

  document.querySelectorAll<HTMLImageElement>("#hud-ducks .hud-duck").forEach((el, i) => {
    const hit = i < HUD_HIT_SLOTS && !!hud.hits[i];
    const white = el.dataset.white ?? "/sprites/hud/duck_white.png";
    const red = el.dataset.red ?? "/sprites/hud/duck_red.png";
    el.src = hit ? red : white;
    el.classList.toggle("hit", hit);
  });
}
