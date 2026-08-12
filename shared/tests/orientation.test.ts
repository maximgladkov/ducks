import { describe, expect, it } from "vitest";
import {
  angularVelocityFromQuats,
  applyScreenAngle,
  anglesDegToPlane,
  deviceOrientationToQuaternion,
  expectedAccelDirection,
  orientationToPlane,
  planeToAnglesDeg,
  predictOrientation,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  toScreenFrame,
  DEFAULT_AIM_BASIS,
  type Quat,
  type Vec3,
} from "../src/index.js";

const d2r = (d: number) => (d * Math.PI) / 180;

function matFromQuat(q: Quat): number[][] {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function mul3(a: number[][], b: number[][]): number[][] {
  return a.map((_, i) =>
    [0, 1, 2].map((j) =>
      [0, 1, 2].reduce((s, k) => s + a[i]![k]! * b[k]![j]!, 0),
    ),
  );
}

/** The rotation the DeviceOrientation spec defines: Rz(alpha) Rx(beta) Ry(gamma). */
function specMatrix(alpha: number, beta: number, gamma: number): number[][] {
  const a = d2r(alpha);
  const b = d2r(beta);
  const g = d2r(gamma);
  const rz = [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a), Math.cos(a), 0],
    [0, 0, 1],
  ];
  const rx = [
    [1, 0, 0],
    [0, Math.cos(b), -Math.sin(b)],
    [0, Math.sin(b), Math.cos(b)],
  ];
  const ry = [
    [Math.cos(g), 0, Math.sin(g)],
    [0, 1, 0],
    [-Math.sin(g), 0, Math.cos(g)],
  ];
  return mul3(mul3(rz, rx), ry);
}

const POSES: Array<[number, number, number]> = [
  [0, 0, 0],
  [30, 0, 0],
  [0, 45, 0],
  [0, 0, 30],
  [20, 70, 15],
  [120, 85, -40],
  [300, 90, 0],
  [-75, -20, 60],
];

describe("deviceOrientationToQuaternion", () => {
  it("reproduces the spec's Z-X'-Y'' rotation at every pose", () => {
    for (const [alpha, beta, gamma] of POSES) {
      const actual = matFromQuat(deviceOrientationToQuaternion(alpha, beta, gamma));
      const expected = specMatrix(alpha, beta, gamma);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          expect(actual[i]![j]!).toBeCloseTo(expected[i]![j]!, 10);
        }
      }
    }
  });

  it("stays a unit quaternion", () => {
    for (const pose of POSES) {
      expect(Math.hypot(...deviceOrientationToQuaternion(...pose))).toBeCloseTo(1, 10);
    }
  });

  it("treats a screen rotation as a spin about the screen normal", () => {
    const q = deviceOrientationToQuaternion(20, 70, 15);
    const rotated = deviceOrientationToQuaternion(20, 70, 15, 90);
    const delta = quatNormalize(quatMultiply(quatConjugate(q), rotated));
    const axis = [delta[0], delta[1], delta[2]];
    const norm = Math.hypot(...axis);
    expect(Math.abs(axis[2]! / norm)).toBeCloseTo(1, 8);
    expect(2 * Math.atan2(norm, Math.abs(delta[3]))).toBeCloseTo(d2r(90), 8);
  });
});

describe("predictOrientation", () => {
  it("integrates a body-frame rate exactly, even when pitched", () => {
    const w: Vec3 = [0, 1.5, 0];
    const start = quatFromAxisAngle([1, 0, 0], d2r(40));
    const dt = 1 / 60;

    let q = start;
    for (let i = 0; i < 60; i++) q = predictOrientation(q, w, dt);

    const truth = quatNormalize(
      quatMultiply(start, quatFromAxisAngle(w, Math.hypot(...w) * dt * 60)),
    );
    const cos = Math.abs(quatMultiply(q, quatConjugate(truth))[3]);
    const errDeg = (2 * Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    expect(errDeg).toBeLessThan(1e-6);
  });

  it("rotates about the device's own axis, not a world axis", () => {
    const pitched = quatFromAxisAngle([1, 0, 0], d2r(90));
    const spun = predictOrientation(pitched, [0, 0, d2r(90)], 1);
    const deviceZ = quatRotateVec(pitched, [0, 0, 1]);
    const movedAxis = quatRotateVec(spun, [0, 0, 1]);
    expect(movedAxis[0]!).toBeCloseTo(deviceZ[0]!, 8);
    expect(movedAxis[1]!).toBeCloseTo(deviceZ[1]!, 8);
    expect(movedAxis[2]!).toBeCloseTo(deviceZ[2]!, 8);
  });

  it("round-trips against angularVelocityFromQuats", () => {
    const q0 = quatFromAxisAngle([0.3, 0.5, -0.2], 0.8);
    const w: Vec3 = [0.4, -1.1, 0.7];
    const dt = 1 / 60;
    const q1 = predictOrientation(q0, w, dt);
    const recovered = angularVelocityFromQuats(q0, q1, dt);
    expect(recovered[0]!).toBeCloseTo(w[0]!, 8);
    expect(recovered[1]!).toBeCloseTo(w[1]!, 8);
    expect(recovered[2]!).toBeCloseTo(w[2]!, 8);
  });
});

describe("aim plane", () => {
  it("maps a centred pose to the origin", () => {
    const plane = orientationToPlane(quatNormalize([0, 0, 0, 1]), DEFAULT_AIM_BASIS);
    expect(plane![0]!).toBeCloseTo(0, 10);
    expect(plane![1]!).toBeCloseTo(0, 10);
  });

  it("is invariant to roll about the barrel", () => {
    const aimed = quatMultiply(
      quatFromAxisAngle([0, 0, 1], d2r(-12)),
      quatFromAxisAngle([1, 0, 0], d2r(7)),
    );
    const base = orientationToPlane(quatNormalize(aimed), DEFAULT_AIM_BASIS)!;
    const rolled = quatNormalize(
      quatMultiply(aimed, quatFromAxisAngle(DEFAULT_AIM_BASIS.muzzle, d2r(35))),
    );
    const after = orientationToPlane(rolled, DEFAULT_AIM_BASIS)!;
    expect(after[0]!).toBeCloseTo(base[0]!, 8);
    expect(after[1]!).toBeCloseTo(base[1]!, 8);
  });

  it("converts between plane coordinates and true angles", () => {
    const plane: [number, number] = [Math.tan(d2r(13)), Math.tan(d2r(-6))];
    const angles = planeToAnglesDeg(plane);
    expect(angles[0]).toBeCloseTo(13, 8);
    expect(angles[1]).toBeCloseTo(-6, 8);
    const back = anglesDegToPlane(angles);
    expect(back[0]).toBeCloseTo(plane[0], 8);
    expect(back[1]).toBeCloseTo(plane[1], 8);
  });

  // Which plane axis a rotation lands on depends on the basis derived from the
  // muzzle, and calibration is what ties those axes to the screen. The physically
  // meaningful invariant is the radius: it is the tangent of the off-axis angle.
  it("reports plane radius as the true off-axis angle", () => {
    for (const deg of [3, 17, 40]) {
      for (const axis of [[0, 0, 1], [1, 0, 0]] as const) {
        const q = quatNormalize(quatFromAxisAngle([...axis], d2r(deg)));
        const plane = orientationToPlane(q, DEFAULT_AIM_BASIS)!;
        const offAxis = (Math.atan(Math.hypot(plane[0], plane[1])) * 180) / Math.PI;
        expect(offAxis).toBeCloseTo(deg, 6);
      }
    }
  });
});

describe("expectedAccelDirection", () => {
  it("points along device +z when the phone lies screen-up", () => {
    const dir = expectedAccelDirection(quatNormalize([0, 0, 0, 1]));
    expect(dir[2]!).toBeCloseTo(1, 10);
  });

  // Standing the phone upright puts its top edge skyward, so a spec-compliant
  // accelerometer reads +g along device +y. iOS reports the negation, which is
  // the discrepancy the controller uses this to detect.
  it("points along device +y when the phone stands upright", () => {
    const upright = quatFromAxisAngle([1, 0, 0], d2r(90));
    const dir = expectedAccelDirection(upright);
    expect(dir[1]!).toBeCloseTo(1, 8);
    expect(Math.abs(dir[2]!)).toBeLessThan(1e-8);
  });
});

describe("applyScreenAngle", () => {
  it("leaves aim unchanged when the phone rotates with the UI", () => {
    const held = quatFromAxisAngle([1, 0, 0], d2r(90));
    const landscape = quatNormalize(
      quatMultiply(held, quatFromAxisAngle([0, 0, 1], d2r(90))),
    );
    const compensated = applyScreenAngle(landscape, 90);
    const cos = Math.abs(quatMultiply(compensated, quatConjugate(held))[3]);
    expect((2 * Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeLessThan(1e-8);
  });
});

describe("toScreenFrame", () => {
  it("passes values through untouched at zero angle", () => {
    const q = quatFromAxisAngle([0.2, 0.9, -0.3], 0.7);
    const out = toScreenFrame(q, [0.5, -1, 0.25], 0);
    expect(out.w).toEqual([0.5, -1, 0.25]);
    expect(out.q[3]).toBeCloseTo(quatNormalize(q)[3], 12);
  });

  // The converted rate must describe the converted orientation: integrating one
  // has to agree with converting the integral of the other.
  it("keeps the rate consistent with the rotated orientation", () => {
    const angle = 90;
    const q = quatFromAxisAngle([0.3, 0.5, -0.2], 0.8);
    const w: Vec3 = [0.4, -1.1, 0.7];
    const dt = 1 / 240;

    const stepped = toScreenFrame(predictOrientation(q, w, dt), w, angle).q;
    const converted = toScreenFrame(q, w, angle);
    const predicted = predictOrientation(converted.q, converted.w, dt);

    const cos = Math.abs(quatMultiply(stepped, quatConjugate(predicted))[3]);
    expect((2 * Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeLessThan(1e-8);
  });
});
