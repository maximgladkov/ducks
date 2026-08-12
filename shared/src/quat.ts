import type { Quat, Vec3 } from "./types.js";

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

export function quatNormalize(q: Quat): Quat {
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatRotateVec(q: Quat, v: Vec3): Vec3 {
  const p: Quat = [v[0], v[1], v[2], 0];
  const r = quatMultiply(quatMultiply(q, p), quatConjugate(q));
  return [r[0], r[1], r[2]];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const [ax, ay, az] = axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const half = angle * 0.5;
  const s = Math.sin(half) / len;
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function deviceOrientationToQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): Quat {
  const alpha = degToRad(alphaDeg);
  const beta = degToRad(betaDeg);
  const gamma = degToRad(gammaDeg);

  const cA = Math.cos(alpha / 2);
  const sA = Math.sin(alpha / 2);
  const cB = Math.cos(beta / 2);
  const sB = Math.sin(beta / 2);
  const cG = Math.cos(gamma / 2);
  const sG = Math.sin(gamma / 2);

  const w = cA * cB * cG - sA * sB * sG;
  const x = sA * sB * cG + cA * cB * sG;
  const y = sA * cB * cG + cA * sB * sG;
  const z = cA * sB * cG - sA * cB * sG;

  return quatNormalize([x, y, z, w]);
}

export function phoneForwardRay(q: Quat, muzzle: Vec3 = [0, 1, 0]): Vec3 {
  return quatRotateVec(q, muzzle);
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalize3(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-8) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export type AimBasis = {
  muzzle: Vec3;
  swapXY: boolean;
  invertX: boolean;
  invertY: boolean;
  label: string;
};

export const DEFAULT_AIM_BASIS: AimBasis = {
  muzzle: [0, 1, 0],
  swapXY: false,
  invertX: false,
  invertY: false,
  label: "top-edge (gun, screen up)",
};

export const MUZZLE_CANDIDATES: Array<{ muzzle: Vec3; label: string }> = [
  { muzzle: [0, 1, 0], label: "top-edge (gun, screen up)" },
  { muzzle: [0, -1, 0], label: "bottom-edge" },
  { muzzle: [0, 0, -1], label: "back-of-phone (screen toward you)" },
  { muzzle: [0, 0, 1], label: "screen-outward" },
  { muzzle: [1, 0, 0], label: "right-edge" },
  { muzzle: [-1, 0, 0], label: "left-edge" },
];

export function rayToPlaneWithMuzzle(
  ray: Vec3,
  muzzleDir: Vec3,
): [number, number] | null {
  const forward = normalize3(muzzleDir);
  if (!forward) return null;
  const depth = dot3(ray, forward);
  if (Math.abs(depth) < 1e-3) return null;

  let helper: Vec3 = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let right = normalize3(cross3(helper, forward));
  if (!right) {
    helper = [0, 0, 1];
    right = normalize3(cross3(helper, forward));
  }
  if (!right) return null;
  const up = normalize3(cross3(forward, right));
  if (!up) return null;

  return [dot3(ray, right) / depth, dot3(ray, up) / depth];
}

export function applyBasisToPlane(
  plane: [number, number],
  basis: Pick<AimBasis, "swapXY" | "invertX" | "invertY">,
): [number, number] {
  let x = plane[0];
  let y = plane[1];
  if (basis.swapXY) [x, y] = [y, x];
  if (basis.invertX) x = -x;
  if (basis.invertY) y = -y;
  return [x, y];
}

export function orientationToPlane(
  q: Quat,
  basis: AimBasis,
): [number, number] | null {
  const ray = phoneForwardRay(q, basis.muzzle);
  const plane = rayToPlaneWithMuzzle(ray, basis.muzzle);
  if (!plane) return null;
  return applyBasisToPlane(plane, basis);
}

export function rayToNormalizedPlane(ray: Vec3): [number, number] | null {
  return rayToPlaneWithMuzzle(ray, [0, 1, 0]);
}

export function angularVelocityFromQuats(
  q0: Quat,
  q1: Quat,
  dt: number,
): Vec3 {
  if (dt <= 1e-6) return [0, 0, 0];
  const dq = quatMultiply(q1, quatConjugate(q0));
  const [x, y, z, w] = quatNormalize(dq);
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf < 1e-8) return [0, 0, 0];
  const angle = 2 * Math.atan2(sinHalf, w);
  const scale = angle / (sinHalf * dt);
  return [x * scale, y * scale, z * scale];
}

export function predictOrientation(q: Quat, w: Vec3, dtSec: number): Quat {
  const speed = Math.hypot(w[0], w[1], w[2]);
  if (speed < 1e-8 || Math.abs(dtSec) < 1e-8) return quatNormalize(q);
  const axis: Vec3 = [w[0] / speed, w[1] / speed, w[2] / speed];
  const dq = quatFromAxisAngle(axis, speed * dtSec);
  return quatNormalize(quatMultiply(dq, q));
}

export function relativeAimDelta(
  prevQ: Quat,
  nextQ: Quat,
  sensitivity: number,
  basis: AimBasis = DEFAULT_AIM_BASIS,
): { dx: number; dy: number } {
  const a = orientationToPlane(prevQ, basis);
  const b = orientationToPlane(nextQ, basis);
  if (!a || !b) return { dx: 0, dy: 0 };
  return {
    dx: (b[0] - a[0]) * sensitivity,
    dy: (b[1] - a[1]) * sensitivity,
  };
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let ax = a[0];
  let ay = a[1];
  let az = a[2];
  let aw = a[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let cosHalf = ax * bx + ay * by + az * bz + aw * bw;
  if (cosHalf < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalf = -cosHalf;
  }
  if (cosHalf > 0.9995) {
    return quatNormalize([
      ax + (bx - ax) * t,
      ay + (by - ay) * t,
      az + (bz - az) * t,
      aw + (bw - aw) * t,
    ]);
  }
  const half = Math.acos(Math.min(1, cosHalf));
  const sinHalf = Math.sin(half);
  const ra = Math.sin((1 - t) * half) / sinHalf;
  const rb = Math.sin(t * half) / sinHalf;
  return quatNormalize([
    ax * ra + bx * rb,
    ay * ra + by * rb,
    az * ra + bz * rb,
    aw * ra + bw * rb,
  ]);
}

export function lowPassVec3(prev: Vec3, next: Vec3, alpha: number): Vec3 {
  const a = Math.min(1, Math.max(0, alpha));
  return [
    prev[0] + (next[0] - prev[0]) * a,
    prev[1] + (next[1] - prev[1]) * a,
    prev[2] + (next[2] - prev[2]) * a,
  ];
}

export function deadzoneVec3(v: Vec3, threshold: number): Vec3 {
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (speed < threshold) return [0, 0, 0];
  const scale = (speed - threshold) / speed;
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

export function predictOrientationSafe(
  q: Quat,
  w: Vec3,
  dtSec: number,
  opts: { maxDtSec?: number; minSpeed?: number } = {},
): Quat {
  const maxDt = opts.maxDtSec ?? 0.06;
  const minSpeed = opts.minSpeed ?? 0.35;
  const dt = Math.min(Math.max(dtSec, 0), maxDt);
  const speed = Math.hypot(w[0], w[1], w[2]);
  if (speed < minSpeed || dt < 1e-4) return quatNormalize(q);
  return predictOrientation(q, w, dt);
}

export function applyReferenceFrame(q: Quat, refInverse: Quat): Quat {
  return quatNormalize(quatMultiply(refInverse, q));
}

export function referenceFrameForRecentre(q: Quat): Quat {
  return quatConjugate(quatNormalize(q));
}
