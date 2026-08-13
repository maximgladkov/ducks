import { describe, expect, it } from "vitest";
import { AimBench } from "../src/bench.js";
import {
  predictionHorizonSec,
  smoothSampleAgeMs,
} from "../src/clock.js";
import {
  AngularRateEstimator,
  MagnetHeadingGate,
} from "../src/fusion.js";
import {
  predictOrientation,
  predictOrientationSafe,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
} from "../src/quat.js";
import { sampleAtTime } from "../src/sampleAt.js";
import { StillLock } from "../src/stillLock.js";
import type { ControllerSample, Quat, Vec3 } from "../src/types.js";

const d2r = (d: number) => (d * Math.PI) / 180;
const HZ = 60;
const STEP = 1 / HZ;

function angleBetweenDeg(a: Quat, b: Quat): number {
  const cos = Math.abs(quatMultiply(a, quatConjugate(b))[3]);
  return (2 * Math.acos(Math.min(1, cos)) * 180) / Math.PI;
}

describe("predictionHorizonSec", () => {
  it("sums sample age, display lag and one frame", () => {
    const sec = predictionHorizonSec({
      sampleAgeMs: 20,
      displayLagMs: 25,
      extraMs: 0,
      quality: 1,
      maxSec: 1,
    });
    expect(sec).toBeCloseTo((20 + 25 + 1000 / 60) / 1000, 5);
  });

  it("shrinks the horizon when the rate fit is uncertain", () => {
    const full = predictionHorizonSec({
      sampleAgeMs: 40,
      displayLagMs: 30,
      quality: 1,
      maxSec: 1,
    });
    const half = predictionHorizonSec({
      sampleAgeMs: 40,
      displayLagMs: 30,
      quality: 0.4,
      maxSec: 1,
    });
    expect(half).toBeCloseTo(full * 0.4, 5);
  });
});

describe("smoothSampleAgeMs", () => {
  it("damps a jump in sample age", () => {
    const next = smoothSampleAgeMs(20, 60, 0.3);
    expect(next).toBeGreaterThan(20);
    expect(next).toBeLessThan(60);
  });
});

describe("AngularRateEstimator poseAt", () => {
  it("predicts a steady turn from the fitted polynomial", () => {
    const fit = new AngularRateEstimator();
    const rate: Vec3 = [0, 0, d2r(90)];
    let q: Quat = [0, 0, 0, 1];
    for (let i = 0; i < 30; i++) {
      q = predictOrientation(q, rate, STEP);
      fit.update(q, i * STEP);
    }
    const horizon = 0.04;
    const predicted = fit.poseAt(horizon);
    const truth = predictOrientation(q, rate, horizon);
    expect(predicted).not.toBeNull();
    expect(angleBetweenDeg(predicted!, truth)).toBeLessThan(2);
  });

  it("is quieter than raw-gyro prediction on a noisy pan", () => {
    const fit = new AngularRateEstimator();
    let seed = 9;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const rate: Vec3 = [0, 0, d2r(40)];
    let q: Quat = [0, 0, 0, 1];
    let noisy: Vec3 = [0, 0, 0];
    for (let i = 0; i < 40; i++) {
      q = predictOrientation(q, rate, STEP);
      noisy = [
        rate[0] + (rand() - 0.5) * d2r(8),
        rate[1] + (rand() - 0.5) * d2r(8),
        rate[2] + (rand() - 0.5) * d2r(8),
      ];
      fit.update(q, i * STEP);
    }
    const horizon = 0.04;
    const fromFit = fit.poseAt(horizon)!;
    const fromNoisy = predictOrientationSafe(q, noisy, horizon);
    const truth = predictOrientation(q, rate, horizon);
    expect(angleBetweenDeg(fromFit, truth)).toBeLessThan(
      angleBetweenDeg(fromNoisy, truth),
    );
    expect(fit.quality()).toBeGreaterThan(0.4);
  });
});

describe("StillLock", () => {
  it("freezes after a brief hold and releases on motion", () => {
    const lock = new StillLock(0.2, 0.12);
    const held = lock.update([100, 100], 0.02, 0.25);
    expect(held).toEqual([100, 100]);
    const crawled = lock.update([102, 101], 0.02, 0.05);
    expect(crawled).toEqual([100, 100]);
    const released = lock.update([120, 90], 0.5, 0.016);
    expect(released).toEqual([120, 90]);
  });

  it("does not lock during a slow pan below the rate threshold", () => {
    const lock = new StillLock(0.2, 0.12);
    for (let i = 0; i < 40; i++) {
      const aim: [number, number] = [100 + i * 2, 100];
      const out = lock.update(aim, 0.05, 0.016);
      expect(out).toEqual(aim);
      expect(lock.locked()).toBe(false);
    }
  });

  it("releases when the live aim walks away even if gyro rate stays low", () => {
    const lock = new StillLock(0.2, 0.12);
    lock.update([100, 100], 0.02, 0.25);
    expect(lock.locked()).toBe(true);
    const released = lock.update([120, 100], 0.02, 0.016);
    expect(released).toEqual([120, 100]);
    expect(lock.locked()).toBe(false);
  });
});

describe("sampleAtTime", () => {
  const samples: ControllerSample[] = [
    { t: 0, q: [0, 0, 0, 1], w: [0, 0, 0], nq: 1 },
    {
      t: 100,
      q: quatNormalize(quatFromAxisAngle([0, 0, 1], d2r(20))),
      w: [0, 0, d2r(20)],
      nq: 0.8,
    },
  ];

  it("interpolates between bracketing samples", () => {
    const at = sampleAtTime(samples, 50);
    expect(at).not.toBeNull();
    const half = quatNormalize(quatFromAxisAngle([0, 0, 1], d2r(10)));
    expect(angleBetweenDeg(at!.q, half)).toBeLessThan(0.5);
    expect(at!.w[2]).toBeCloseTo(d2r(10), 5);
  });
});

describe("AimBench", () => {
  it("reports low static jitter for a still aim", () => {
    const bench = new AimBench();
    for (let i = 0; i < 40; i++) {
      bench.observe({
        aim: [800 + (i % 2) * 0.4, 400],
        tSec: i / 30,
        rateRad: 0.02,
        sampleAgeMs: 18,
        horizonMs: 40,
        yawDeg: 2,
      });
    }
    const snap = bench.snapshot();
    expect(snap.staticRmsPx).not.toBeNull();
    expect(snap.staticRmsPx!).toBeLessThan(2);
  });
});

describe("MagnetHeadingGate", () => {
  it("trusts an absolute attitude that matches relative motion", () => {
    const gate = new MagnetHeadingGate();
    let q: Quat = [0, 0, 0, 1];
    const rate: Vec3 = [0, 0, d2r(50)];
    for (let i = 0; i < 80; i++) {
      q = predictOrientation(q, rate, STEP);
      gate.observe(q, q, i * STEP);
    }
    expect(gate.isTrusted()).toBe(true);
    expect(gate.isRejected()).toBe(false);
  });

  it("rejects an absolute attitude that does not follow the gyro", () => {
    const gate = new MagnetHeadingGate();
    let rel: Quat = [0, 0, 0, 1];
    let abs: Quat = [0, 0, 0, 1];
    const yaw: Vec3 = [0, 0, d2r(50)];
    const other: Vec3 = [d2r(40), 0, 0];
    for (let i = 0; i < 80; i++) {
      rel = predictOrientation(rel, yaw, STEP);
      abs = predictOrientation(abs, other, STEP);
      gate.observe(rel, abs, i * STEP);
    }
    expect(gate.isRejected()).toBe(true);
  });
});
