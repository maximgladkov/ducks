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

/**
 * Converts DeviceOrientationEvent angles to a quaternion using the intrinsic
 * Z-X'-Y'' sequence mandated by the spec: R = Rz(alpha) * Rx(beta) * Ry(gamma).
 *
 * `screenAngleDeg` compensates for the OS having rotated the UI
 * (`screen.orientation.angle`), which Safari cannot lock.
 */
export function deviceOrientationToQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg = 0,
): Quat {
  const halfZ = degToRad(alphaDeg) / 2;
  const halfX = degToRad(betaDeg) / 2;
  const halfY = degToRad(gammaDeg) / 2;

  const cZ = Math.cos(halfZ);
  const sZ = Math.sin(halfZ);
  const cX = Math.cos(halfX);
  const sX = Math.sin(halfX);
  const cY = Math.cos(halfY);
  const sY = Math.sin(halfY);

  const q = quatNormalize([
    cZ * sX * cY - sZ * cX * sY,
    cZ * cX * sY + sZ * sX * cY,
    sZ * cX * cY + cZ * sX * sY,
    cZ * cX * cY - sZ * sX * sY,
  ]);

  return screenAngleDeg === 0 ? q : applyScreenAngle(q, screenAngleDeg);
}

/**
 * Rotates the device frame about the screen normal so that a given pose yields
 * the same aim regardless of how the OS has rotated the UI.
 */
export function applyScreenAngle(q: Quat, screenAngleDeg: number): Quat {
  const spin = quatFromAxisAngle([0, 0, 1], -degToRad(screenAngleDeg));
  return quatNormalize(quatMultiply(q, spin));
}

/**
 * Re-expresses an orientation and its body-frame angular velocity in the screen
 * frame. The rate has to be rotated alongside the orientation: leaving it in
 * device axes would make prediction lead in the wrong direction whenever the OS
 * has rotated the UI.
 */
export function toScreenFrame(
  q: Quat,
  w: Vec3,
  screenAngleDeg: number,
): { q: Quat; w: Vec3 } {
  if (screenAngleDeg === 0) return { q: quatNormalize(q), w };
  const spin = quatFromAxisAngle([0, 0, 1], -degToRad(screenAngleDeg));
  return {
    q: quatNormalize(quatMultiply(q, spin)),
    w: quatRotateVec(quatConjugate(spin), w),
  };
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

/** The fused world frame keeps z opposite gravity. */
export const WORLD_UP: Vec3 = [0, 0, 1];

/**
 * Which device axis the player treats as the barrel. Axis flips and swaps are
 * deliberately absent: they are linear, so the calibration homography absorbs
 * them exactly and including them would make grip detection ambiguous.
 */
export type AimBasis = {
  muzzle: Vec3;
  label: string;
};

export const DEFAULT_AIM_BASIS: AimBasis = {
  muzzle: [0, 1, 0],
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

  // Anchored to world up so the axes come out as screen right and screen down.
  // Deriving them from whichever helper vector happens to be least parallel
  // instead leaves them rotated by an arbitrary amount: calibration absorbs that,
  // but every uncalibrated path and every log reads as though the axes are swapped.
  let right = normalize3(cross3(forward, WORLD_UP));
  if (!right) right = normalize3(cross3(forward, [0, 1, 0]));
  if (!right) return null;
  const down = normalize3(cross3(forward, right));
  if (!down) return null;

  return [dot3(ray, right) / depth, dot3(ray, down) / depth];
}

export function orientationToPlane(
  q: Quat,
  basis: AimBasis,
): [number, number] | null {
  const ray = phoneForwardRay(q, basis.muzzle);
  return rayToPlaneWithMuzzle(ray, basis.muzzle);
}

/**
 * Plane coordinates are gnomonic, so each axis is the tangent of a true angle.
 * Working in degrees makes smoothing isotropic and gives the filter parameters
 * physical units, unlike pixels which the homography distorts across the screen.
 */
export function planeToAnglesDeg(plane: [number, number]): [number, number] {
  return [
    (Math.atan(plane[0]) * 180) / Math.PI,
    (Math.atan(plane[1]) * 180) / Math.PI,
  ];
}

export function anglesDegToPlane(angles: [number, number]): [number, number] {
  const limit = 89;
  const ax = Math.max(-limit, Math.min(limit, angles[0]));
  const ay = Math.max(-limit, Math.min(limit, angles[1]));
  return [Math.tan((ax * Math.PI) / 180), Math.tan((ay * Math.PI) / 180)];
}

export function rayToNormalizedPlane(ray: Vec3): [number, number] | null {
  return rayToPlaneWithMuzzle(ray, [0, 1, 0]);
}

/**
 * Body-frame angular velocity between two orientations, matching the frame that
 * `DeviceMotionEvent.rotationRate` and `Gyroscope` report in. The delta is
 * therefore left-multiplied by the inverse of q0, not right-multiplied.
 */
export function angularVelocityFromQuats(
  q0: Quat,
  q1: Quat,
  dt: number,
): Vec3 {
  if (dt <= 1e-6) return [0, 0, 0];
  const dq = quatNormalize(quatMultiply(quatConjugate(q0), q1));
  // A quaternion and its negation are the same rotation, and orientation sources
  // flip between them freely. Taken at face value a flip reads as very nearly a
  // full turn, so a motionless phone reports a huge rate for one sample.
  const flip = dq[3] < 0 ? -1 : 1;
  const x = dq[0] * flip;
  const y = dq[1] * flip;
  const z = dq[2] * flip;
  const w = dq[3] * flip;
  const sinHalf = Math.hypot(x, y, z);
  if (sinHalf < 1e-8) return [0, 0, 0];
  const angle = 2 * Math.atan2(sinHalf, w);
  const scale = angle / (sinHalf * dt);
  return [x * scale, y * scale, z * scale];
}

/**
 * Advances an orientation by a body-frame angular velocity. Gyroscope rates are
 * expressed in the device's own axes, so the delta composes on the right;
 * composing on the left would rotate about world axes and skew the result by
 * several degrees whenever the device is pitched.
 */
export function predictOrientation(q: Quat, w: Vec3, dtSec: number): Quat {
  const speed = Math.hypot(w[0], w[1], w[2]);
  if (speed < 1e-8 || Math.abs(dtSec) < 1e-8) return quatNormalize(q);
  const axis: Vec3 = [w[0] / speed, w[1] / speed, w[2] / speed];
  const dq = quatFromAxisAngle(axis, speed * dtSec);
  return quatNormalize(quatMultiply(q, dq));
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
  opts: { maxDtSec?: number; minSpeed?: number; maxSpeed?: number } = {},
): Quat {
  const maxDt = opts.maxDtSec ?? 0.06;
  const minSpeed = opts.minSpeed ?? 0.35;
  // Roughly the fastest a wrist can flick. Anything beyond it is a glitch in the
  // rate rather than a movement, and extrapolating it throws the crosshair clear
  // across the screen.
  const maxSpeed = opts.maxSpeed ?? 20;
  const dt = Math.min(Math.max(dtSec, 0), maxDt);
  const speed = Math.hypot(w[0], w[1], w[2]);
  if (speed < minSpeed || dt < 1e-4) return quatNormalize(q);
  if (speed > maxSpeed) {
    const k = maxSpeed / speed;
    return predictOrientation(q, [w[0] * k, w[1] * k, w[2] * k], dt);
  }
  return predictOrientation(q, w, dt);
}

/**
 * World "up" expressed in device axes. A device at rest should report
 * `accelerationIncludingGravity` pointing this way; iOS negates it, so comparing
 * the two lets us detect the platform's sign convention without sniffing the UA.
 */
export function expectedAccelDirection(q: Quat): Vec3 {
  return quatRotateVec(quatConjugate(q), [0, 0, 1]);
}

export function applyReferenceFrame(q: Quat, refInverse: Quat): Quat {
  return quatNormalize(quatMultiply(refInverse, q));
}

export function referenceFrameForRecentre(q: Quat): Quat {
  return quatConjugate(quatNormalize(q));
}
