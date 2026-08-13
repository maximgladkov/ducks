export type DuckKind = "black" | "brown" | "blue";
export type GameMode = "A" | "B";

export const HIT_SLOTS = 10;
export const WAVE_SHOTS = 3;
export const STAGE_W = 256;
export const STAGE_H = 240;
export const PLAY_H = 184;
export const HUD_H = STAGE_H - PLAY_H;

export function passLine(round: number): number {
  const r = Math.max(1, round);
  if (r <= 10) return 6;
  if (r <= 12) return 7;
  if (r <= 14) return 8;
  if (r <= 19) return 9;
  return 10;
}

export function duckPoints(round: number, kind: DuckKind): number {
  const r = Math.max(1, round);
  if (r <= 5) {
    if (kind === "black") return 500;
    if (kind === "blue") return 1000;
    return 1500;
  }
  if (r <= 10) {
    if (kind === "black") return 800;
    if (kind === "blue") return 1600;
    return 2400;
  }
  if (kind === "black") return 1000;
  if (kind === "blue") return 2000;
  return 3000;
}

export function perfectBonus(round: number): number {
  const r = Math.max(1, round);
  if (r <= 10) return 10000;
  if (r <= 15) return 15000;
  if (r <= 20) return 20000;
  return 30000;
}

export function flightDuration(round: number): number {
  const r = Math.max(1, round);
  const t = Math.min(1, (r - 1) / 19);
  return 11.5 - t * 6.4;
}

export function duckSpeed(
  round: number,
  kind: DuckKind,
  mode: GameMode = "A",
): number {
  const r = Math.max(1, round);
  const t = Math.min(1, (r - 1) / 26);
  const base = 55 + t * 110;
  const mul = kind === "black" ? 1 : kind === "blue" ? 1.28 : 1.55;
  const modeMul = mode === "B" ? 0.7 : 1;
  return base * mul * modeMul;
}

export function ducksPerWave(mode: GameMode): number {
  return mode === "A" ? 1 : 2;
}

export function kindFromRoll(roll: number): DuckKind {
  if (roll < 0.6) return "black";
  if (roll < 0.9) return "blue";
  return "brown";
}

export function pickDuckKind(): DuckKind {
  return kindFromRoll(Math.random());
}
