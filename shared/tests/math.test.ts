import { describe, expect, it } from "vitest";
import {
  applyHomography,
  solveHomography,
  validateHomography,
} from "../src/homography.js";
import {
  deviceOrientationToQuaternion,
  phoneForwardRay,
  predictOrientation,
  quatIdentity,
  quatNormalize,
  rayToNormalizedPlane,
} from "../src/quat.js";
import { OneEuroFilter2D } from "../src/oneEuro.js";
import {
  clockOffsetFromExchange,
  estimateClockOffset,
} from "../src/clock.js";
import { aimAssistPull, hitscan } from "../src/aim.js";

describe("quat", () => {
  it("normalizes identity", () => {
    const q = quatNormalize([0, 0, 0, 2]);
    expect(q[3]).toBeCloseTo(1);
  });

  it("converts device orientation to a unit quaternion", () => {
    const q = deviceOrientationToQuaternion(10, 20, 5);
    const n = Math.hypot(...q);
    expect(n).toBeCloseTo(1, 5);
  });

  it("maps phone top-edge forward ray", () => {
    const ray = phoneForwardRay(quatIdentity());
    expect(ray[1]).toBeCloseTo(1);
  });

  it("predicts orientation along angular velocity", () => {
    const q0 = quatIdentity();
    const q1 = predictOrientation(q0, [0, 0, Math.PI], 0.5);
    const ray = phoneForwardRay(q1);
    expect(Math.hypot(ray[0], ray[1], ray[2])).toBeCloseTo(1, 5);
  });

  it("projects Y-forward ray to normalized plane", () => {
    const p = rayToNormalizedPlane([0, 1, 0]);
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(0);
    expect(p![1]).toBeCloseTo(0);
    const tipped = rayToNormalizedPlane([0.5, 1, 0]);
    expect(Math.hypot(tipped![0], tipped![1])).toBeGreaterThan(0.1);
  });
});

describe("homography", () => {
  it("recovers an identity-like screen mapping", () => {
    const src: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const dst: Array<[number, number]> = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const H = solveHomography(src, dst);
    expect(H).not.toBeNull();
    const check = validateHomography(H!, src, dst, 0.02, [100, 100]);
    expect(check.ok).toBe(true);
    const mid = applyHomography(H!, [0, 0]);
    expect(mid[0]).toBeCloseTo(50, 0);
    expect(mid[1]).toBeCloseTo(50, 0);
  });
});

describe("one euro", () => {
  it("smooths a noisy hold without huge lag on a step", () => {
    const f = new OneEuroFilter2D({ minCutoff: 1, beta: 0.01 });
    let y = 0;
    for (let i = 0; i < 30; i++) {
      const noise = (i % 2 === 0 ? 1 : -1) * 0.5;
      [ , y] = f.filter(0, 100 + noise, i / 60);
    }
    expect(Math.abs(y - 100)).toBeLessThan(2);

    let x = 0;
    for (let i = 30; i < 45; i++) {
      [x] = f.filter(200, 100, i / 60);
    }
    expect(x).toBeGreaterThan(100);
  });
});

describe("clock", () => {
  it("estimates host-minus-controller offset from lowest-RTT samples", () => {
    const samples = [
      clockOffsetFromExchange(0, 100, 20),
      clockOffsetFromExchange(0, 105, 40),
      clockOffsetFromExchange(0, 101, 10),
    ];
    const est = estimateClockOffset(samples);
    expect(est.rtt).toBeLessThanOrEqual(20);
    expect(est.offset).toBeCloseTo(-96, -1);
  });
});

describe("aim", () => {
  it("pulls toward nearby targets", () => {
    const pulled = aimAssistPull([10, 10], [{ x: 20, y: 10, radius: 5 }], 20);
    expect(pulled[0]).toBeGreaterThan(10);
  });

  it("hitscans with bonus radius", () => {
    const id = hitscan(
      [50, 50],
      [{ id: "a", x: 58, y: 50, radius: 5 }],
      8,
    );
    expect(id).toBe("a");
  });
});
