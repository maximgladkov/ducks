export type HudState = {
  round: number;
  shots: number;
  hits: boolean[];
  resolved: number;
  score: number;
  pass: number;
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

export function createHudState(): HudState {
  return {
    round: 1,
    shots: HUD_MAX_SHOTS,
    hits: Array.from({ length: HUD_HIT_SLOTS }, () => false),
    resolved: 0,
    score: 0,
    pass: 6,
  };
}

export function hudShotsRemaining(hud: HudState): number {
  return Math.max(0, Math.min(HUD_MAX_SHOTS, hud.shots));
}

export function hudHitCount(hud: HudState): number {
  return hud.hits.filter((h, i) => i < hud.resolved && h).length;
}
