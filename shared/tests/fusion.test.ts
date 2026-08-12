import { describe, expect, it } from "vitest";
import {
  AngularRateEstimator,
  GYRO_CONVENTIONS,
  GyroAxisDetector,
  OrientationFusion,
  angularVelocityFromQuats,
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

  // The seed comes from DeviceOrientation, which can be tens of degrees out.
  // Walking that off at the steady-state gain took several seconds, and a
  // calibration taken during it measures every target against a moving frame.
  it("walks out a badly wrong seed within the settling window", () => {
    const truth = quatFromAxisAngle([1, 0, 0], d2r(5));
    const fusion = new OrientationFusion();
    teach(fusion, truth);
    fusion.seed(quatFromAxisAngle([1, 0, 0], d2r(62)));
    expect(fusion.isConverged()).toBe(false);

    // A hand-held phone is never perfectly still, so tremor rides along.
    const step = (i: number) => {
      const tremor: Vec3 = [
        d2r(1.5) * Math.sin(i / 7),
        d2r(1.5) * Math.cos(i / 5),
        d2r(1.5) * Math.sin(i / 11),
      ];
      const shake = 1 + 0.05 * Math.sin(i / 3);
      const accel = accelFor(truth).map((v) => v * shake) as Vec3;
      fusion.update(tremor, accel, 1 / 60);
    };

    for (let i = 0; i < 90; i++) step(i);
    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(3);

    for (let i = 90; i < 180; i++) step(i);
    expect(fusion.isConverged()).toBe(true);
    expect(fusion.tiltResidualDeg()).toBeLessThan(2.5);
  });

  it("still corrects while the phone is being swung", () => {
    const truth = quatFromAxisAngle([1, 0, 0], d2r(30));
    const fusion = new OrientationFusion();
    teach(fusion, truth);
    fusion.seed(quatFromAxisAngle([1, 0, 0], d2r(10)));

    // Swinging the phone puts the reading 25% off gravity, which used to be
    // rejected outright and left the estimate uncorrected for the whole round.
    for (let i = 0; i < 600; i++) {
      const accel = accelFor(truth).map((v) => v * 1.25) as Vec3;
      fusion.update([0, 0, 0], accel, 1 / 60);
    }

    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(2);
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

  // Gravity says nothing about heading, so without a reference attitude a phone
  // can be turned to aim sideways and the estimate never follows.
  it("follows a reference attitude in heading, which gravity cannot fix", () => {
    const fusion = new OrientationFusion();
    const start: Quat = [0, 0, 0, 1];
    teach(fusion, start);
    fusion.seed(start);

    const truth = quatFromAxisAngle([0, 0, 1], d2r(30));
    for (let i = 0; i < 240; i++) fusion.updateWithReference([0, 0, 0], truth, 1 / 60, 0);

    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(1);
    expect(fusion.isConverged()).toBe(true);
  });

  it("takes the short way round when the reference sign is flipped", () => {
    const fusion = new OrientationFusion();
    const truth = quatFromAxisAngle([0, 1, 0], d2r(20));
    fusion.seed([0, 0, 0, 1]);
    const flipped = truth.map((v) => -v) as Quat;

    for (let i = 0; i < 240; i++) fusion.updateWithReference([0, 0, 0], flipped, 1 / 60, 0);

    expect(angleBetweenDeg(fusion.orientation(), truth)).toBeLessThan(1);
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

describe("GyroAxisDetector", () => {
  /**
   * Turns a body-frame truth into what a platform using `convention` would put
   * in [alpha, beta, gamma].
   */
  function report(w: Vec3, convention: "spec" | "webkit"): Vec3 {
    return convention === "webkit" ? [w[0], w[1], w[2]] : [w[2], w[0], w[1]];
  }

  const motion = (i: number): Vec3 => [
    d2r(40) * Math.sin(i / 9),
    d2r(25) * Math.cos(i / 13),
    d2r(60) * Math.sin(i / 7 + 1),
  ];

  for (const convention of ["spec", "webkit"] as const) {
    it(`recognises the ${convention} labelling from a reference rate`, () => {
      const detector = new GyroAxisDetector();
      for (let i = 0; i < 200 && !detector.convention(); i++) {
        const truth = motion(i);
        detector.observe(report(truth, convention), truth);
      }
      expect(detector.convention()).toBe(convention);

      const truth = motion(7);
      const mapped = detector.map(report(truth, convention));
      expect(mapped[0]).toBeCloseTo(truth[0], 6);
      expect(mapped[1]).toBeCloseTo(truth[1], 6);
      expect(mapped[2]).toBeCloseTo(truth[2], 6);
    });
  }

  // If none of the labellings fits, committing to the least-bad one would feed
  // one axis of motion into another; leaning on the reference is the safe loss.
  it("stays undecided when no labelling explains the motion", () => {
    const detector = new GyroAxisDetector();
    for (let i = 0; i < 400; i++) {
      const truth = motion(i);
      const unrelated: Vec3 = [
        d2r(30) * Math.cos(i / 5),
        d2r(50) * Math.sin(i / 3),
        d2r(20) * Math.cos(i / 11 + 2),
      ];
      detector.observe(unrelated, truth);
    }
    expect(detector.convention()).toBeNull();
  });

  it("stays undecided while the phone is barely moving", () => {
    const detector = new GyroAxisDetector();
    for (let i = 0; i < 400; i++) {
      const crawl: Vec3 = [d2r(1), d2r(-1), d2r(0.5)];
      detector.observe(report(crawl, "webkit"), crawl);
    }
    expect(detector.convention()).toBeNull();
    // Falling back to the spec labelling keeps behaviour defined meanwhile.
    expect(detector.map([1, 2, 3])).toEqual(GYRO_CONVENTIONS.spec([1, 2, 3]));
  });

  // The mislabelling this guards against sent pitch into yaw and yaw into roll,
  // where gravity cancelled it, so aiming sideways moved nothing at all.
  it("recovers heading tracking that the wrong labelling destroys", () => {
    const detector = new GyroAxisDetector();
    for (let i = 0; i < 200 && !detector.convention(); i++) {
      const truth = motion(i);
      detector.observe(report(truth, "webkit"), truth);
    }
    expect(detector.convention()).toBe("webkit");

    // Turning to aim sideways is pure yaw, the one axis gravity cannot police.
    const yawRate: Vec3 = [0, 0, d2r(45)];
    const reference = (i: number) => quatFromAxisAngle([0, 0, 1], (d2r(45) * i) / 60);
    const fusion = new OrientationFusion();
    fusion.seed([0, 0, 0, 1]);

    let q = fusion.orientation();
    for (let i = 1; i <= 60; i++) {
      const truth = angularVelocityFromQuats(reference(i - 1), reference(i), 1 / 60);
      expect(detector.map(report(yawRate, "webkit"))[2]).toBeCloseTo(truth[2], 3);
      q = fusion.updateWithReference(
        detector.map(report(yawRate, "webkit")),
        reference(i),
        1 / 60,
      );
    }
    expect(angleBetweenDeg(q, reference(60))).toBeLessThan(2);
  });
});

describe("AngularRateEstimator", () => {
  const HZ = 60;
  const STEP = 1 / HZ;

  // Attitude arrives quantised to about a degree, and differentiating that is
  // what used to make a still hand look like it was moving.
  const quantise = (deg: number, step = 1) => Math.round(deg / step) * step;

  function run(
    rateDegPerSec: (tSec: number) => number,
    seconds: number,
    quantStep = 1,
  ) {
    const fit = new AngularRateEstimator();
    const fitted: number[] = [];
    const smoothed: number[] = [];
    const truth: number[] = [];
    let angleDeg = 0;
    let ema = 0;
    let lastQ = quatFromAxisAngle([0, 0, 1], 0);

    for (let i = 0; i * STEP <= seconds; i++) {
      const t = i * STEP;
      angleDeg += rateDegPerSec(t) * STEP;
      const q = quatFromAxisAngle([0, 0, 1], d2r(quantise(angleDeg, quantStep)));

      const w = fit.update(q, t);
      const diff = angularVelocityFromQuats(lastQ, q, STEP);
      // The exponential average this replaced, for comparison.
      const a = 1 - Math.exp(-STEP / 0.04);
      ema += (diff[2]! - ema) * a;
      lastQ = q;

      fitted.push(w[2]!);
      smoothed.push(ema);
      truth.push(d2r(rateDegPerSec(t)));
    }
    return { fitted, smoothed, truth };
  }

  /** Skips the first `from` samples of both series, keeping them aligned. */
  const rmsAgainst = (v: number[], truth: number[], from: number) => {
    let sum = 0;
    for (let i = from; i < v.length; i++) sum += (v[i]! - truth[i]!) ** 2;
    return Math.sqrt(sum / (v.length - from));
  };

  it("reads zero from a still phone", () => {
    const { fitted } = run(() => 0, 1);
    for (const w of fitted) expect(Math.abs(w)).toBeLessThan(1e-9);
  });

  it("recovers a steady turn rate", () => {
    const { fitted } = run(() => 90, 1);
    const settled = fitted.slice(20);
    for (const w of settled) expect(w).toBeCloseTo(d2r(90), 1);
  });

  it("tracks a flick far better than the average it replaces", () => {
    // A wrist cannot change speed instantly, so the flick ramps up and down.
    const ramp = (x: number) =>
      0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
    const flick = (t: number) => {
      const p = t % 1.6;
      if (p < 0.07) return 400 * ramp(p / 0.07);
      if (p < 0.17) return 400;
      if (p < 0.24) return 400 * (1 - ramp((p - 0.17) / 0.07));
      return 0;
    };
    const { fitted, smoothed, truth } = run(flick, 5);
    const from = 40;
    expect(rmsAgainst(fitted, truth, from)).toBeLessThan(
      rmsAgainst(smoothed, truth, from) * 0.6,
    );
  });

  it("is no noisier than that average on a hand just holding still", () => {
    const { fitted, smoothed, truth } = run(
      (t) => 3 * Math.sin(2 * Math.PI * 6 * t),
      4,
    );
    const from = 40;
    expect(rmsAgainst(fitted, truth, from)).toBeLessThanOrEqual(
      rmsAgainst(smoothed, truth, from) * 1.1,
    );
  });

  it("beats it on a slow steady pan too, by averaging over more samples", () => {
    const { fitted, smoothed, truth } = run(() => 25, 4);
    const from = 40;
    expect(rmsAgainst(fitted, truth, from)).toBeLessThan(
      rmsAgainst(smoothed, truth, from),
    );
  });

  it("forgets the window after a stall instead of inventing a spike", () => {
    const fit = new AngularRateEstimator();
    for (let i = 0; i < 5; i++) {
      fit.update(quatFromAxisAngle([0, 0, 1], d2r(i * 2)), i * STEP);
    }
    // Six seconds of silence, then the phone reappears somewhere else.
    const after = fit.update(quatFromAxisAngle([0, 0, 1], d2r(60)), 6);
    expect(Math.hypot(...after)).toBe(0);
  });
});
