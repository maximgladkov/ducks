import { Matrix, SingularValueDecomposition, inverse } from "ml-matrix";
import type { Mat3, Vec2 } from "./types.js";

/**
 * Least-squares homography from N >= 4 correspondences via the normalized DLT.
 *
 * Hartley normalization matters here because the source points are gnomonic
 * plane coordinates clustered near the origin while the destinations span
 * thousands of pixels; solving the raw system is badly conditioned.
 */
export function solveHomography(src: Vec2[], dst: Vec2[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;

  const nSrc = normalizePoints(src);
  const nDst = normalizePoints(dst);
  if (!nSrc || !nDst) return null;

  const rows: number[][] = [];
  for (let i = 0; i < nSrc.points.length; i++) {
    const [x, y] = nSrc.points[i]!;
    const [u, v] = nDst.points[i]!;
    rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    rows.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  // Four correspondences give only 8 rows; pad so the decomposition always
  // yields a full 9-column basis and the null vector is addressable.
  while (rows.length < 9) rows.push([0, 0, 0, 0, 0, 0, 0, 0, 0]);

  let h: number[];
  try {
    const svd = new SingularValueDecomposition(new Matrix(rows), {
      autoTranspose: true,
    });
    h = svd.rightSingularVectors.getColumn(8);
  } catch {
    return null;
  }
  if (h.some((v) => !Number.isFinite(v))) return null;

  const hNorm = new Matrix([
    [h[0]!, h[1]!, h[2]!],
    [h[3]!, h[4]!, h[5]!],
    [h[6]!, h[7]!, h[8]!],
  ]);

  let denormalized: Matrix;
  try {
    denormalized = inverse(nDst.transform).mmul(hNorm).mmul(nSrc.transform);
  } catch {
    return null;
  }

  const flat = denormalized.to1DArray();
  const scale = Math.abs(flat[8]!) > 1e-12 ? flat[8]! : 1;
  const H = flat.map((v) => v / scale) as unknown as Mat3;
  return H.some((v) => !Number.isFinite(v)) ? null : H;
}

function normalizePoints(
  points: Vec2[],
): { points: Vec2[]; transform: Matrix } | null {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;

  let meanDist = 0;
  for (const p of points) meanDist += Math.hypot(p[0] - cx, p[1] - cy);
  meanDist /= n;
  if (meanDist < 1e-12) return null;

  const s = Math.SQRT2 / meanDist;
  return {
    points: points.map((p) => [(p[0] - cx) * s, (p[1] - cy) * s] as Vec2),
    transform: new Matrix([
      [s, 0, -s * cx],
      [0, s, -s * cy],
      [0, 0, 1],
    ]),
  };
}

export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const x = H[0] * p[0] + H[1] * p[1] + H[2];
  const y = H[3] * p[0] + H[4] * p[1] + H[5];
  const w = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(w) < 1e-12) return [x, y];
  return [x / w, y / w];
}

/**
 * How pixel position changes per unit of plane coordinate at `p`, as
 * [dU/dx, dU/dy, dV/dx, dV/dy]. Used to convert plane deltas into screen deltas
 * in relative aiming mode so it inherits the calibrated orientation and scale.
 */
export function homographyJacobian(
  H: Mat3,
  p: Vec2,
): [number, number, number, number] {
  const nu = H[0] * p[0] + H[1] * p[1] + H[2];
  const nv = H[3] * p[0] + H[4] * p[1] + H[5];
  const d = H[6] * p[0] + H[7] * p[1] + H[8];
  if (Math.abs(d) < 1e-12) return [0, 0, 0, 0];
  const inv = 1 / d;
  const inv2 = inv * inv;
  return [
    H[0] * inv - nu * H[6] * inv2,
    H[1] * inv - nu * H[7] * inv2,
    H[3] * inv - nv * H[6] * inv2,
    H[4] * inv - nv * H[7] * inv2,
  ];
}

export function homographyResiduals(
  H: Mat3,
  src: Vec2[],
  dst: Vec2[],
): number[] {
  return src.map((s, i) => {
    const p = applyHomography(H, s);
    return Math.hypot(p[0] - dst[i]![0], p[1] - dst[i]![1]);
  });
}

/**
 * Leave-one-out reprojection error in pixels.
 *
 * A 4-point fit has zero degrees of freedom left over, so its residuals are
 * always ~0 and say nothing about quality. Holding each point out in turn gives
 * an error that actually reflects whether the player aimed consistently.
 */
export function crossValidateHomography(
  src: Vec2[],
  dst: Vec2[],
): { maxError: number; meanError: number } | null {
  if (src.length < 5) return null;
  const errors: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const trainSrc = src.filter((_, j) => j !== i);
    const trainDst = dst.filter((_, j) => j !== i);
    const H = solveHomography(trainSrc, trainDst);
    if (!H) return null;
    const p = applyHomography(H, src[i]!);
    errors.push(Math.hypot(p[0] - dst[i]![0], p[1] - dst[i]![1]));
  }
  return {
    maxError: Math.max(...errors),
    meanError: errors.reduce((a, b) => a + b, 0) / errors.length,
  };
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

  const hull = [dst[0]!, dst[1]!, dst[2]!, dst[3]!];
  const area =
    triangleArea(hull[0], hull[1], hull[2]) +
    triangleArea(hull[0], hull[2], hull[3]);
  const minArea = screenSize[0] * screenSize[1] * 0.15;
  if (area < minArea) return { ok: false, maxError };

  return { ok: maxError <= maxRelError, maxError };
}

function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return Math.abs(
    (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) / 2,
  );
}

/**
 * Nine calibration targets: the four corners first so the convex hull is pinned
 * early, then edge midpoints and the centre. The extra points turn the fit into
 * an over-determined one, which is what makes error reporting possible and
 * keeps interior accuracy from depending on four noisy corner captures.
 */
export function calibrationPoints(
  width: number,
  height: number,
  inset = 40,
): Vec2[] {
  const left = inset;
  const right = width - inset;
  const top = inset;
  const bottom = height - inset;
  const midX = width / 2;
  const midY = height / 2;
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [midX, top],
    [right, midY],
    [midX, bottom],
    [left, midY],
    [midX, midY],
  ];
}
