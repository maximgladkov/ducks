export type HudState = {
  round: number;
  shots: number;
  hits: boolean[];
  score: number;
};

export type HudPlayerView = {
  id: string;
  index: number;
  color: string;
  shots: number;
  score: number;
};

export const HUD_HIT_SLOTS = 10;
export const HUD_MAX_SHOTS = 3;
export const HUD_POINTS_PER_HIT = 1000;

export function createHudState(): HudState {
  return {
    round: 1,
    shots: HUD_MAX_SHOTS,
    hits: Array.from({ length: HUD_HIT_SLOTS }, () => false),
    score: 0,
  };
}

export function hudShotsRemaining(hud: HudState): number {
  return Math.max(0, Math.min(HUD_MAX_SHOTS, hud.shots));
}

export function hudHitCount(hud: HudState): number {
  return hud.hits.filter(Boolean).length;
}

export function setHudShots(hud: HudState, shots: number): void {
  hud.shots = Math.max(0, Math.min(HUD_MAX_SHOTS, shots));
}

export function registerHudHit(hud: HudState): void {
  const idx = hud.hits.findIndex((h) => !h);
  if (idx >= 0) hud.hits[idx] = true;
  hud.score += HUD_POINTS_PER_HIT;
  if (hudHitCount(hud) >= HUD_HIT_SLOTS) {
    hud.round += 1;
    hud.hits = Array.from({ length: HUD_HIT_SLOTS }, () => false);
  }
}
