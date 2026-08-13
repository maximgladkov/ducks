import type { Vec2 } from "./types.js";

/**
 * Eases the crosshair towards nearby targets.
 *
 * Stateless on purpose: the pull depends only on where the crosshair and the
 * targets are, so it behaves the same at any frame rate and cannot accumulate.
 *
 * Every target within reach contributes, weighted by how close it is, rather than
 * the closest one winning outright. Picking a single winner makes the pull jump
 * the moment two ducks swap places for nearest, which reads as the crosshair
 * flicking between them. The weighting also eases in smoothly at the edge of the
 * radius instead of switching on, so there is no line on screen where the aim
 * visibly starts being helped.
 */
export function aimAssistPull(
  aim: Vec2,
  targets: Array<{ x: number; y: number; radius: number }>,
  assistRadius: number,
  pullGain = 0.5,
): Vec2 {
  if (assistRadius <= 0 || targets.length === 0) return aim;

  let dx = 0;
  let dy = 0;
  let total = 0;
  let strongest = 0;
  for (const t of targets) {
    const gap = Math.hypot(aim[0] - t.x, aim[1] - t.y) - t.radius;
    if (gap >= assistRadius) continue;
    const near = 1 - Math.max(0, gap) / assistRadius;
    const w = near * near * (3 - 2 * near);
    dx += (t.x - aim[0]) * w;
    dy += (t.y - aim[1]) * w;
    total += w;
    strongest = Math.max(strongest, w);
  }
  if (total <= 0) return aim;

  // Direction from the weighted blend, but strength from the best target, so one
  // distant duck cannot drag the aim as hard as one under the crosshair.
  const gain = pullGain * strongest;
  let offsetX = (dx / total) * gain;
  let offsetY = (dy / total) * gain;

  // Large sprites sit far from their own centre, and the player should never feel
  // the crosshair leave their hand.
  const cap = assistRadius * 0.5;
  const moved = Math.hypot(offsetX, offsetY);
  if (moved > cap) {
    offsetX *= cap / moved;
    offsetY *= cap / moved;
  }
  return [aim[0] + offsetX, aim[1] + offsetY];
}

export type DriftLearnOptions = {
  /** Only a target this close to the crosshair counts as the one aimed at. */
  radiusPx?: number;
  /** The runner-up must be this much further for the intent to be obvious. */
  ambiguityRatio?: number;
  /** Fraction of each shot's evidence taken. */
  gain?: number;
  /** Ceiling on the correction, in plane units. */
  cap?: number;
};

/**
 * Updates a standing aim correction from one shot, or returns null if the shot
 * says nothing trustworthy.
 *
 * `aim` must be the crosshair before any assist pull, since the pull moves it
 * towards the target and would hide the very error being measured. `jacobian` is
 * the mapping's local pixels-per-plane-unit, used to turn the pixel gap back into
 * the aim units the correction lives in.
 *
 * The gain is deliberately small. Each reading is dominated by the player's own
 * aim rather than the drift, so the point is to accumulate what successive shots
 * agree on and let the disagreement cancel.
 */
export function learnAimOffset(
  bias: Vec2,
  aim: Vec2,
  targets: Array<{ x: number; y: number; radius: number }>,
  jacobian: [number, number, number, number],
  options: DriftLearnOptions = {},
): Vec2 | null {
  const radiusPx = options.radiusPx ?? 150;
  const ambiguityRatio = options.ambiguityRatio ?? 1.8;
  const gain = options.gain ?? 0.16;
  const cap = options.cap ?? Math.tan((5 * Math.PI) / 180);

  let nearest: { x: number; y: number } | null = null;
  let nearestD = Infinity;
  let runnerUpD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(aim[0] - t.x, aim[1] - t.y);
    if (d < nearestD) {
      runnerUpD = nearestD;
      nearestD = d;
      nearest = t;
    } else if (d < runnerUpD) {
      runnerUpD = d;
    }
  }
  if (!nearest || nearestD > radiusPx) return null;
  if (runnerUpD < nearestD * ambiguityRatio) return null;

  const [a, b, c, d] = jacobian;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;

  const offsetX = nearest.x - aim[0];
  const offsetY = nearest.y - aim[1];
  const stepX = (d * offsetX - b * offsetY) / det;
  const stepY = (-c * offsetX + a * offsetY) / det;
  if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) return null;

  const next: Vec2 = [bias[0] + stepX * gain, bias[1] + stepY * gain];
  const size = Math.hypot(next[0], next[1]);
  if (size > cap) {
    next[0] *= cap / size;
    next[1] *= cap / size;
  }
  return next;
}

export function hitscan(
  aim: Vec2,
  targets: Array<{ id: string; x: number; y: number; radius: number }>,
  hitboxBonus = 8,
): string | null {
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(aim[0] - t.x, aim[1] - t.y);
    if (d <= t.radius + hitboxBonus && d < bestD) {
      bestD = d;
      bestId = t.id;
    }
  }
  return bestId;
}

export function clampAim(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; clamped: boolean; nx: number; ny: number } {
  const cx = Math.min(width, Math.max(0, x));
  const cy = Math.min(height, Math.max(0, y));
  const clamped = cx !== x || cy !== y;
  let nx = 0;
  let ny = 0;
  if (clamped) {
    nx = x < 0 ? -1 : x > width ? 1 : 0;
    ny = y < 0 ? -1 : y > height ? 1 : 0;
    if (nx === 0 && ny === 0) {
      nx = Math.sign(x - width / 2);
      ny = Math.sign(y - height / 2);
    }
  }
  return { x: cx, y: cy, clamped, nx, ny };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

export function averageVec2(points: Vec2[]): Vec2 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

export function spreadVec2(points: Vec2[]): number {
  const mean = averageVec2(points);
  if (!mean || points.length < 2) return 0;
  let acc = 0;
  for (const p of points) {
    acc += Math.hypot(p[0] - mean[0], p[1] - mean[1]);
  }
  return acc / points.length;
}
