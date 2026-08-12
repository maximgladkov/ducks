import { describe, expect, it } from "vitest";
import {
  OrientationFusion,
  applyHomography,
  applyReferenceFrame,
  calibrationPoints,
  cross3,
  detectAimBasis,
  dot3,
  expectedAccelDirection,
  normalize3,
  orientationToPlane,
  predictOrientation,
  predictOrientationSafe,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  referenceFrameForRecentre,
  type Quat,
  type Vec2,
  type Vec3,
} from "../src/index.js";

const SCREEN: Vec2 = [1920, 1080];
const CENTRE: Vec2 = [SCREEN[0] / 2, SCREEN[1] / 2];
const DISTANCE_PX = 3600;
const DIAGONAL = Math.hypot(SCREEN[0], SCREEN[1]);
const GRAVITY = 9.80665;
const HZ = 60;
const d2r = (d: number) => (d * Math.PI) / 180;

/** Deterministic noise so a failure always reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Minimal rotation taking `from` onto `to`. */
function quatFromTo(from: Vec3, to: Vec3): Quat {
  const a = normalize3(from)!;
  const b = normalize3(to)!;
  const d = dot3(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    const perp =
      normalize3(cross3(a, [1, 0, 0])) ?? normalize3(cross3(a, [0, 1, 0]))!;
    return quatFromAxisAngle(perp, Math.PI);
  }
  return quatFromAxisAngle(normalize3(cross3(a, b))!, Math.acos(d));
}

/** Barrel along the phone's top edge, screen up: the classic light-gun hold. */
const GRIP_GUN: Vec3 = [0, 1, 0];
/** Barrel out the back of the phone, held upright like a normal phone. */
const GRIP_UPRIGHT: Vec3 = [0, 0, -1];

function poseAiming(point: Vec2, muzzle: Vec3 = GRIP_GUN): Quat {
  const dx = point[0] - CENTRE[0];
  const dz = -(point[1] - CENTRE[1]);
  const yaw = Math.atan(dx / DISTANCE_PX);
  const pitch = Math.atan((dz * Math.cos(yaw)) / DISTANCE_PX);
  const aim = quatMultiply(
    quatFromAxisAngle([0, 0, 1], -yaw),
    quatFromAxisAngle([1, 0, 0], pitch),
  );
  return quatNormalize(quatMultiply(aim, quatFromTo(muzzle, [0, 1, 0])));
}

function accelFor(q: Quat, noise: number, rand: () => number): Vec3 {
  const dir = expectedAccelDirection(q);
  return [
    dir[0] * GRAVITY + (rand() - 0.5) * noise,
    dir[1] * GRAVITY + (rand() - 0.5) * noise,
    dir[2] * GRAVITY + (rand() - 0.5) * noise,
  ];
}

/**
 * A phone whose gyroscope has a constant bias and white noise, and whose owner
 * cannot hold perfectly still. Mirrors what the controller actually feeds the
 * fusion filter: body-frame rates plus gravity-dominated acceleration.
 */
class SimulatedPhone {
  readonly fusion = new OrientationFusion();
  private truth: Quat;
  private rand: () => number;

  constructor(
    start: Quat,
    private bias: Vec3,
    seed = 7,
    private gyroNoise = d2r(0.35),
    private accelNoise = 0.12,
  ) {
    this.truth = start;
    this.rand = rng(seed);
    for (let i = 0; i < 12; i++) {
      this.fusion.observeAccelSign(start, accelFor(start, 0, this.rand));
    }
    this.fusion.seed(start);
  }

  trueOrientation(): Quat {
    return this.truth;
  }

  /** Advances toward `target`, returning what the host would receive. */
  step(target: Quat, followGain = 0.25): { q: Quat; w: Vec3 } {
    const delta = quatNormalize(
      quatMultiply(
        [-this.truth[0], -this.truth[1], -this.truth[2], this.truth[3]],
        target,
      ),
    );
    const sinHalf = Math.hypot(delta[0], delta[1], delta[2]);
    const angle = 2 * Math.atan2(sinHalf, delta[3]);
    let trueRate: Vec3 = [0, 0, 0];
    if (sinHalf > 1e-9 && Math.abs(angle) > 1e-9) {
      const scale = (angle * followGain * HZ) / sinHalf;
      trueRate = [delta[0] * scale, delta[1] * scale, delta[2] * scale];
    }
    // Hand tremor keeps the device from ever being perfectly still.
    trueRate = [
      trueRate[0] + (this.rand() - 0.5) * d2r(1.5),
      trueRate[1] + (this.rand() - 0.5) * d2r(1.5),
      trueRate[2] + (this.rand() - 0.5) * d2r(1.5),
    ];
    this.truth = predictOrientation(this.truth, trueRate, 1 / HZ);

    const measured: Vec3 = [
      trueRate[0] + this.bias[0] + (this.rand() - 0.5) * this.gyroNoise,
      trueRate[1] + this.bias[1] + (this.rand() - 0.5) * this.gyroNoise,
      trueRate[2] + this.bias[2] + (this.rand() - 0.5) * this.gyroNoise,
    ];
    const accel = accelFor(this.truth, this.accelNoise, this.rand);
    const q = this.fusion.update(measured, accel, 1 / HZ);
    return { q, w: this.fusion.rate(measured) };
  }

  settle(target: Quat, frames: number): { q: Quat; w: Vec3 } {
    let last = { q: this.fusion.orientation(), w: [0, 0, 0] as Vec3 };
    for (let i = 0; i < frames; i++) last = this.step(target);
    return last;
  }
}

function averageQuats(quats: Quat[]): Quat {
  const ref = quats[0]!;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (const q of quats) {
    const sign = dot3([q[0], q[1], q[2]], [ref[0], ref[1], ref[2]]) + q[3] * ref[3] < 0 ? -1 : 1;
    x += sign * q[0];
    y += sign * q[1];
    z += sign * q[2];
    w += sign * q[3];
  }
  return quatNormalize([x, y, z, w]);
}

describe("end-to-end aiming", () => {
  const TARGETS = calibrationPoints(SCREEN[0], SCREEN[1], 40);

  function runSession(bias: Vec3, seed: number, muzzle: Vec3 = GRIP_GUN) {
    const phone = new SimulatedPhone(poseAiming(CENTRE, muzzle), bias, seed);
    phone.settle(poseAiming(CENTRE, muzzle), 120);
    const refInverse = referenceFrameForRecentre(phone.fusion.orientation());

    const captured: Quat[] = [];
    for (const target of TARGETS) {
      const pose = poseAiming(target, muzzle);
      phone.settle(pose, 45);
      const window: Quat[] = [];
      for (let i = 0; i < 21; i++) {
        window.push(applyReferenceFrame(phone.step(pose).q, refInverse));
      }
      captured.push(averageQuats(window));
    }

    const fit = detectAimBasis(captured, TARGETS);
    expect(fit).not.toBeNull();
    return { phone, refInverse, fit: fit! };
  }

  it("calibrates and then aims accurately despite bias, noise and tremor", () => {
    const { phone, refInverse, fit } = runSession([d2r(1.8), d2r(-2.4), d2r(0.3)], 11);
    expect(fit.validated).toBe(true);
    expect(fit.maxError).toBeLessThan(DIAGONAL * 0.03);

    const probes: Vec2[] = [
      [400, 260],
      [1500, 800],
      [960, 300],
      [700, 900],
    ];
    for (const probe of probes) {
      const pose = poseAiming(probe);
      const sample = phone.settle(pose, 60);
      const q = applyReferenceFrame(sample.q, refInverse);
      const aimed = applyHomography(fit.H, orientationToPlane(q, fit.basis)!);
      const err = Math.hypot(aimed[0] - probe[0], aimed[1] - probe[1]);
      expect(err).toBeLessThan(45);
    }
  });

  it("is repeatable across different noise seeds", () => {
    for (const seed of [3, 29, 101]) {
      const { phone, refInverse, fit } = runSession([d2r(-1.2), d2r(2.0), d2r(-0.4)], seed);
      const pose = poseAiming([1200, 620]);
      const sample = phone.settle(pose, 60);
      const q = applyReferenceFrame(sample.q, refInverse);
      const aimed = applyHomography(fit.H, orientationToPlane(q, fit.basis)!);
      expect(Math.hypot(aimed[0] - 1200, aimed[1] - 620)).toBeLessThan(60);
    }
  });

  // Prediction only helps if it leads along the true motion. How far the wrong
  // composition order strays depends on how far the phone is rotated from the
  // sensor's reference attitude, so this uses the upright grip, where the device
  // sits about 90 degrees away from flat.
  it("prediction leads toward where the aim is actually going", () => {
    const { refInverse, fit } = runSession([0, 0, 0], 5, GRIP_UPRIGHT);
    const from = poseAiming([500, 800], GRIP_UPRIGHT);
    const to = poseAiming([1400, 300], GRIP_UPRIGHT);

    const flickRate: Vec3 = (() => {
      const delta = quatNormalize(
        quatMultiply([-from[0], -from[1], -from[2], from[3]], to),
      );
      const sinHalf = Math.hypot(delta[0], delta[1], delta[2]);
      const angle = 2 * Math.atan2(sinHalf, delta[3]);
      const scale = angle / (sinHalf * 0.25);
      return [delta[0] * scale, delta[1] * scale, delta[2] * scale];
    })();

    const toScreen = (q: Quat) =>
      applyHomography(fit.H, orientationToPlane(applyReferenceFrame(q, refInverse), fit.basis)!);

    const now = toScreen(from);
    const horizon = 0.04;
    const predicted = toScreen(predictOrientationSafe(from, flickRate, horizon));
    const truth = toScreen(predictOrientation(from, flickRate, horizon));

    const travelled = Math.hypot(predicted[0] - now[0], predicted[1] - now[1]);
    const offBy = Math.hypot(predicted[0] - truth[0], predicted[1] - truth[1]);
    expect(travelled).toBeGreaterThan(80);
    expect(offBy).toBeLessThan(travelled * 0.02);

    // The old convention put the lead in a measurably wrong place.
    const wrongWay = (() => {
      const speed = Math.hypot(...flickRate);
      const dq = quatFromAxisAngle(
        [flickRate[0] / speed, flickRate[1] / speed, flickRate[2] / speed],
        speed * horizon,
      );
      return toScreen(quatNormalize(quatMultiply(dq, from)));
    })();
    expect(Math.hypot(wrongWay[0] - truth[0], wrongWay[1] - truth[1])).toBeGreaterThan(40);
  });

  it("keeps aim stable while the player merely holds still", () => {
    const { phone, refInverse, fit } = runSession([d2r(1.0), d2r(-1.5), d2r(0.2)], 17);
    const pose = poseAiming([960, 500]);
    phone.settle(pose, 90);

    const positions: Vec2[] = [];
    for (let i = 0; i < 180; i++) {
      const sample = phone.step(pose);
      const q = applyReferenceFrame(sample.q, refInverse);
      positions.push(applyHomography(fit.H, orientationToPlane(q, fit.basis)!));
    }
    const mean: Vec2 = [
      positions.reduce((a, p) => a + p[0], 0) / positions.length,
      positions.reduce((a, p) => a + p[1], 0) / positions.length,
    ];
    const spread = Math.max(
      ...positions.map((p) => Math.hypot(p[0] - mean[0], p[1] - mean[1])),
    );
    // Unfiltered jitter from tremor and sensor noise, before One Euro smoothing.
    expect(spread).toBeLessThan(30);
  });
});
