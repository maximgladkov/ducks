import { describe, expect, it } from "vitest";
import {
  OrientationFusion,
  expectedAccelDirection,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  type Quat,
  type Vec3,
} from "../src/index.js";

const GRAVITY = 9.80665;
const d2r = (d: number) => (d * Math.PI) / 180;

function angleBetweenDeg(a: Quat, b: Quat): number {
  const cos = Math.abs(quatMultiply(a, quatConjugate(b))[3]);
  return (2 * Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

/** What a spec-compliant accelerometer reads for a device at this attitude. */
function accelFor(q: Quat, sign = 1): Vec3 {
  const dir = expectedAccelDirection(q);
  return [dir[0] * GRAVITY * sign, dir[1] * GRAVITY * sign, dir[2] * GRAVITY * sign];
}

function teach(fusion: OrientationFusion, truth: Quat, sign = 1): void {
  for (let i = 0; i < 10; i++) fusion.observeAccelSign(truth, accelFor(truth, sign));
}

describe("OrientationFusion", () => {
  it("stays finite when the phone lies flat and perfectly still", () => {
    const fusion = new OrientationFusion();
    const flat: Quat = [0, 0, 0, 1];
    teach(fusion, flat);
    fusion.seed(flat);
    for (let i = 0; i < 6000; i++) {
      fusion.update([0, 0, 0], accelFor(flat), 1 / 60);
    }
    const q = fusion.orientation();
    expect(q.every((v) => Number.isFinite(v))).toBe(true);
    expect(angleBetweenDeg(q, flat)).toBeLessThan(1e-6);
  });

  it("pulls a wrong pitch estimate back onto gravity", () => {
    const truth = quatFromAxisAngle([1, 0, 0], d2r(35));
    const fusion = new OrientationFusion();
    teach(fusion, truth);
    fusion.seed(quatFromAxisAngle([1, 0, 0], d2r(5)));

    for (let i = 0; i < 1200; i++) fusion.update([0, 0, 0], accelFor(truth), 1 / 60);

    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(1);
  });

  it("cancels gyro drift that pure integration would accumulate", () => {
    const truth: Quat = [0, 0, 0, 1];
    const drift: Vec3 = [d2r(2), d2r(-3), 0];
    const fusion = new OrientationFusion();
    teach(fusion, truth);
    fusion.seed(truth);

    for (let i = 0; i < 3600; i++) fusion.update(drift, accelFor(truth), 1 / 60);

    // A minute of unfused integration at this bias would be over 200 deg off.
    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(0.5);
    const bias = fusion.biasEstimate();
    expect(bias[0]).toBeCloseTo(drift[0], 3);
    expect(bias[1]).toBeCloseTo(drift[1], 3);
  });

  it("tracks a real rotation instead of fighting it", () => {
    const fusion = new OrientationFusion();
    const start: Quat = [0, 0, 0, 1];
    teach(fusion, start);
    fusion.seed(start);

    const rate: Vec3 = [0, 0, d2r(90)];
    let truth = start;
    for (let i = 0; i < 60; i++) {
      truth = quatNormalize(
        quatMultiply(truth, quatFromAxisAngle([0, 0, 1], d2r(90) / 60)),
      );
      fusion.update(rate, accelFor(truth), 1 / 60);
    }

    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(2);
    const spun = quatRotateVec(fusion.orientation(), [1, 0, 0]);
    expect(spun[0]).toBeCloseTo(Math.cos(d2r(90)), 1);
  });

  it("detects the iOS accelerometer sign and still converges", () => {
    const truth = quatFromAxisAngle([1, 0, 0], d2r(50));
    const fusion = new OrientationFusion();
    teach(fusion, truth, -1);
    expect(fusion.accelSignConvention()).toBe(-1);

    fusion.seed(quatFromAxisAngle([1, 0, 0], d2r(20)));
    for (let i = 0; i < 1200; i++) {
      fusion.update([0, 0, 0], accelFor(truth, -1), 1 / 60);
    }
    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(1);
  });

  it("detects the spec accelerometer sign", () => {
    const fusion = new OrientationFusion();
    teach(fusion, quatFromAxisAngle([1, 0, 0], d2r(50)), 1);
    expect(fusion.accelSignConvention()).toBe(1);
  });

  it("ignores the accelerometer while the device is being shaken", () => {
    const truth: Quat = [0, 0, 0, 1];
    const fusion = new OrientationFusion();
    teach(fusion, truth);
    fusion.seed(truth);
    const before = fusion.orientation();

    // A hard shake reads far more than 1 g, so it carries no attitude information.
    for (let i = 0; i < 60; i++) fusion.update([0, 0, 0], [0, 0, GRAVITY * 3], 1 / 60);

    expect(angleBetweenDeg(fusion.orientation(), before)).toBeLessThan(1e-6);
    expect(fusion.isStationary()).toBe(false);
  });

  it("only trusts bias after sustained stillness", () => {
    const fusion = new OrientationFusion();
    const flat: Quat = [0, 0, 0, 1];
    teach(fusion, flat);
    fusion.seed(flat);
    fusion.update([0, 0, 0], accelFor(flat), 1 / 60);
    expect(fusion.isStationary()).toBe(false);
    for (let i = 0; i < 60; i++) fusion.update([0, 0, 0], accelFor(flat), 1 / 60);
    expect(fusion.isStationary()).toBe(true);
  });

  it("coasts on the gyroscope when no accelerometer is available", () => {
    const fusion = new OrientationFusion();
    fusion.seed([0, 0, 0, 1]);
    for (let i = 0; i < 30; i++) fusion.update([0, 0, d2r(90)], null, 1 / 60);
    const q = fusion.orientation();
    expect(q.every((v) => Number.isFinite(v))).toBe(true);
    expect(angleBetweenDeg(q, quatFromAxisAngle([0, 0, 1], d2r(45)))).toBeLessThan(1e-6);
  });

  // A backgrounded tab can deliver a huge gap on resume; integrating it whole
  // would fling the crosshair across the screen.
  it("clamps an implausibly long gap between samples", () => {
    const fusion = new OrientationFusion();
    fusion.seed([0, 0, 0, 1]);
    fusion.update([0, 0, d2r(90)], null, 30);
    expect(angleBetweenDeg(fusion.orientation(), [0, 0, 0, 1])).toBeLessThan(10);
  });
});
