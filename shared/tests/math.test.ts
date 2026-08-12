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
import { DEFAULT_DEBUG_SETTINGS } from "../src/types.js";
import {
  clockOffsetFromExchange,
  estimateClockOffset,
} from "../src/clock.js";
import { aimAssistPull, hitscan, learnAimOffset } from "../src/aim.js";
import type { Vec2 } from "../src/types.js";

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

  /**
   * Sweep to a target and stop dead on it, which is what aiming at a duck is.
   * Returns where the crosshair is drawn over the second after the hand stops.
   */
  function sweepThenHold(leadGain: number): number[] {
    const f = new OneEuroFilter2D({ ...DEFAULT_DEBUG_SETTINGS });
    f.setParams({ minCutoff: 1, beta: DEFAULT_DEBUG_SETTINGS.beta });
    const held = 30;
    let i = 0;
    for (; i < 60; i++) {
      f.filterWithLead((held * i) / 60, 0, i / 60, leadGain);
    }
    const after: number[] = [];
    for (; i < 120; i++) {
      after.push(f.filterWithLead(held, 0, i / 60, leadGain)[0]);
    }
    return after;
  }

  it("settles onto a held aim without drifting back afterwards", () => {
    const after = sweepThenHold(0);
    expect(Math.abs(after[after.length - 1]! - 30)).toBeLessThan(0.2);
    // Whatever remains must be gone quickly, not creeping for a second.
    expect(Math.abs(after[18]! - 30)).toBeLessThan(0.5);
    expect(Math.max(...after)).toBeLessThan(30.5);
  });

  // Why the lead is off by default: the filter's lag peaks as the hand slows, so
  // the lead outlives the movement and hauls the crosshair back afterwards.
  it("overshoots and unwinds for a long time when led by its own lag", () => {
    const led = sweepThenHold(1);
    expect(Math.max(...led)).toBeGreaterThan(31);

    // Frames drawn beyond the target after the hand stopped: this is the slow
    // creep back towards the middle, and it should not survive at all unled.
    const overshootFrames = (samples: number[]) =>
      samples.filter((v) => v > 30.3).length;
    expect(overshootFrames(led)).toBeGreaterThan(10);
    expect(overshootFrames(sweepThenHold(0))).toBe(0);
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

describe("aim assist magnetism", () => {
  const duck = (x: number, y: number) => ({ x, y, radius: 24 });

  it("leaves the aim alone well outside the radius", () => {
    const aim = aimAssistPull([0, 0], [duck(400, 0)], 90);
    expect(aim).toEqual([0, 0]);
  });

  it("eases in rather than switching on at the edge", () => {
    // Just inside the radius the help should be barely perceptible.
    const atEdge = aimAssistPull([24 + 89, 0], [duck(0, 0)], 90);
    expect(Math.abs(atEdge[0] - (24 + 89))).toBeLessThan(0.5);
  });

  it("pulls hardest with the crosshair on the duck", () => {
    const near = aimAssistPull([30, 0], [duck(0, 0)], 90);
    const far = aimAssistPull([100, 0], [duck(0, 0)], 90);
    expect(30 - near[0]).toBeGreaterThan(100 - far[0]);
  });

  it("moves smoothly as a duck flies past, with no jump", () => {
    let previous: number | null = null;
    let biggestStep = 0;
    for (let x = -300; x <= 300; x += 2) {
      const aim = aimAssistPull([0, 0], [duck(x, 0)], 90);
      if (previous !== null) {
        biggestStep = Math.max(biggestStep, Math.abs(aim[0] - previous));
      }
      previous = aim[0];
    }
    expect(biggestStep).toBeLessThan(3);
  });

  it("does not flick between two ducks that swap for nearest", () => {
    // As the pair slides across, a winner-takes-all pull would jump at the
    // moment they trade places.
    let previous: number | null = null;
    let biggestStep = 0;
    for (let shift = -40; shift <= 40; shift += 1) {
      const aim = aimAssistPull(
        [0, 0],
        [duck(-60 + shift, 0), duck(60 + shift, 0)],
        120,
      );
      if (previous !== null) {
        biggestStep = Math.max(biggestStep, Math.abs(aim[0] - previous));
      }
      previous = aim[0];
    }
    expect(biggestStep).toBeLessThan(3);
  });

  it("never carries the crosshair further than half the radius", () => {
    const aim = aimAssistPull([0, 0], [{ x: 400, y: 0, radius: 380 }], 100);
    expect(Math.hypot(aim[0], aim[1])).toBeLessThanOrEqual(50.001);
  });
});

describe("learning drift from shots", () => {
  const d2r = (deg: number) => (deg * Math.PI) / 180;

  // A calibrated mapping of 800 pixels per unit of aim, centred on a 1600x1000
  // screen, with no projective terms.
  const JACOBIAN: [number, number, number, number] = [800, 0, 0, 800];
  const duck = (x: number, y: number) => ({ x, y, radius: 24 });

  /** Where the crosshair lands when the true aim is at `x, y` and drift is on. */
  const drawn = (x: number, y: number, bias: Vec2, driftPlane: Vec2): Vec2 => [
    x + (driftPlane[0] + bias[0]) * JACOBIAN[0],
    y + (driftPlane[1] + bias[1]) * JACOBIAN[3],
  ];

  it("declines to learn when no target is near the shot", () => {
    expect(
      learnAimOffset([0, 0], [800, 500], [duck(1400, 900)], JACOBIAN),
    ).toBeNull();
  });

  it("declines to learn when two targets are equally plausible", () => {
    expect(
      learnAimOffset([0, 0], [800, 500], [duck(760, 500), duck(840, 500)], JACOBIAN),
    ).toBeNull();
  });

  it("cancels a steady drift over a handful of shots", () => {
    // A degree of accumulated yaw error, which is what a minute of play costs.
    const drift: Vec2 = [Math.tan(d2r(1)), 0];
    let bias: Vec2 = [0, 0];
    for (let shot = 0; shot < 40; shot++) {
      const duckX = 500 + ((shot * 137) % 700);
      const duckY = 300 + ((shot * 91) % 400);
      // The player aims true; the drift is what puts the crosshair off.
      const aim = drawn(duckX, duckY, bias, drift);
      bias = learnAimOffset(bias, aim, [duck(duckX, duckY)], JACOBIAN) ?? bias;
    }
    expect(bias[0]).toBeCloseTo(-drift[0], 3);
    expect(bias[1]).toBeCloseTo(0, 3);
    const settled = drawn(800, 500, bias, drift);
    expect(Math.hypot(settled[0] - 800, settled[1] - 500)).toBeLessThan(2);
  });

  it("is not dragged off by a player whose own aim scatters", () => {
    let seed = 11;
    const scatter = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff - 0.5) * 120;
    };
    let bias: Vec2 = [0, 0];
    for (let shot = 0; shot < 60; shot++) {
      const duckX = 500 + ((shot * 137) % 700);
      const duckY = 300 + ((shot * 91) % 400);
      const aim: Vec2 = [duckX + scatter(), duckY + scatter()];
      bias = learnAimOffset(bias, aim, [duck(duckX, duckY)], JACOBIAN) ?? bias;
    }
    // 60px of random scatter either way must not become a standing correction.
    expect(Math.hypot(bias[0], bias[1]) * 800).toBeLessThan(20);
  });

  it("cannot be taken over, however far off the shots are", () => {
    let bias: Vec2 = [0, 0];
    for (let shot = 0; shot < 200; shot++) {
      bias = learnAimOffset(bias, [800, 500], [duck(680, 620)], JACOBIAN) ?? bias;
    }
    const cap = Math.tan(d2r(5));
    expect(Math.hypot(bias[0], bias[1])).toBeLessThanOrEqual(cap + 1e-9);
  });
});
