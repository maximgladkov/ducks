import type { Mat3, Vec2 } from "./types.js";

export function solveHomography(src: Vec2[], dst: Vec2[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;

  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    a.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    a.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }

  const h = nullVector(a);
  if (!h) return null;

  const scale = Math.abs(h[8]!) > 1e-12 ? h[8]! : 1;
  const H: Mat3 = [
    h[0]! / scale,
    h[1]! / scale,
    h[2]! / scale,
    h[3]! / scale,
    h[4]! / scale,
    h[5]! / scale,
    h[6]! / scale,
    h[7]! / scale,
    h[8]! / scale,
  ];
  return H;
}

function nullVector(rowsIn: number[][]): number[] | null {
  const rows = rowsIn.map((r) => r.slice());
  const m = rows.length;
  const n = rows[0]?.length ?? 0;
  if (n === 0) return null;

  const pivots: Array<number | null> = Array(m).fill(null);
  let row = 0;
  for (let col = 0; col < n && row < m; col++) {
    let best = row;
    for (let i = row + 1; i < m; i++) {
      if (Math.abs(rows[i]![col]!) > Math.abs(rows[best]![col]!)) best = i;
    }
    if (Math.abs(rows[best]![col]!) < 1e-12) continue;
    [rows[row], rows[best]] = [rows[best]!, rows[row]!];
    const pivot = rows[row]![col]!;
    for (let j = col; j < n; j++) rows[row]![j]! /= pivot;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = rows[i]![col]!;
      if (Math.abs(f) < 1e-15) continue;
      for (let j = col; j < n; j++) rows[i]![j]! -= f * rows[row]![j]!;
    }
    pivots[row] = col;
    row++;
  }

  const pivotCols = new Set(pivots.filter((p): p is number => p !== null));
  const freeCols: number[] = [];
  for (let j = 0; j < n; j++) if (!pivotCols.has(j)) freeCols.push(j);

  const x = Array(n).fill(0);
  if (freeCols.length === 0) {
    x[n - 1] = 1;
  } else {
    x[freeCols[0]!] = 1;
  }

  for (let i = 0; i < m; i++) {
    const pc = pivots[i];
    if (pc === null) continue;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === pc) continue;
      sum += rows[i]![j]! * x[j]!;
    }
    x[pc] = -sum;
  }

  const norm = Math.hypot(...x);
  if (norm < 1e-12) return null;
  return x.map((v) => v / norm);
}

export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const x = H[0] * p[0] + H[1] * p[1] + H[2];
  const y = H[3] * p[0] + H[4] * p[1] + H[5];
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(w) < 1e-12) return [x, y];
  return [x / w, y / w];
}

export function validateHomography(
  H: Mat3,
  src: Vec2[],
  dst: Vec2[],
  maxRelError = 0.05,
  screenSize: Vec2 = [1, 1],
): { ok: boolean; maxError: number } {
  let maxError = 0;
  for (let i = 0; i < src.length; i++) {
    const p = applyHomography(H, src[i]!);
    const dx = (p[0] - dst[i]![0]) / Math.max(1, screenSize[0]);
    const dy = (p[1] - dst[i]![1]) / Math.max(1, screenSize[1]);
    maxError = Math.max(maxError, Math.hypot(dx, dy));
  }

  const area =
    triangleArea(dst[0]!, dst[1]!, dst[2]!) +
    triangleArea(dst[0]!, dst[2]!, dst[3]!);
  const minArea = screenSize[0] * screenSize[1] * 0.15;
  if (area < minArea) return { ok: false, maxError };

  return { ok: maxError <= maxRelError, maxError };
}

function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return Math.abs(
    (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) /
      2,
  );
}

export function calibrationCorners(
  width: number,
  height: number,
  inset = 40,
): Vec2[] {
  return [
    [inset, inset],
    [width - inset, inset],
    [width - inset, height - inset],
    [inset, height - inset],
  ];
}
