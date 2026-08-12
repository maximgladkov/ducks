import type { Vec2 } from "./types.js";

export function aimAssistPull(
  aim: Vec2,
  targets: Array<{ x: number; y: number; radius: number }>,
  assistRadius: number,
): Vec2 {
  if (assistRadius <= 0 || targets.length === 0) return aim;
  let best: { x: number; y: number; d: number } | null = null;
  for (const t of targets) {
    const d = Math.hypot(aim[0] - t.x, aim[1] - t.y) - t.radius;
    if (d <= assistRadius && (best === null || d < best.d)) {
      best = { x: t.x, y: t.y, d };
    }
  }
  if (!best) return aim;
  const strength = 1 - Math.max(0, best.d) / assistRadius;
  const pull = 0.35 * strength;
  return [
    aim[0] + (best.x - aim[0]) * pull,
    aim[1] + (best.y - aim[1]) * pull,
  ];
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
