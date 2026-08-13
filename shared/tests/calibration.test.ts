import { describe, expect, it } from "vitest";
import {
  applyHomography,
  applyReferenceFrame,
  calibrationPoints,
  clampToSafeDomain,
  cross3,
  crossValidateHomography,
  detectAimBasis,
  dot3,
  homographyJacobian,
  normalize3,
  orientationToPlane,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  referenceFrameForRecentre,
  solveAffine,
  solveHomography,
  crossValidateAffine,
  type Mat3,
  type Quat,
  type Vec2,
  type Vec3,
} from "../src/index.js";

const SCREEN: Vec2 = [1920, 1080];
const CENTRE: Vec2 = [SCREEN[0] / 2, SCREEN[1] / 2];
const DISTANCE_PX = 3600;

/** Minimal rotation taking `from` onto `to`, i.e. a grip offset with no roll. */
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

/**
 * The pose a player holds to aim the barrel at a screen pixel, for a screen
 * sitting `DISTANCE_PX` away. World y runs toward the screen, world z is up.
 *
 * The player keeps one grip and aims by yawing and pitching the wrist, so the
 * pose is an aiming rotation composed with a fixed grip offset. Modelling it as
 * a minimal rotation instead would make several muzzle axes indistinguishable
 * for reasons that have nothing to do with how anyone actually holds a phone.
 */
function poseAiming(point: Vec2, muzzle: Vec3, eyeX = 0): Quat {
  const dx = point[0] - CENTRE[0] - eyeX;
  const dz = -(point[1] - CENTRE[1]);
  const yaw = Math.atan(dx / DISTANCE_PX);
  const pitch = Math.atan((dz * Math.cos(yaw)) / DISTANCE_PX);
  const aim = quatMultiply(
    quatFromAxisAngle([0, 0, 1], -yaw),
    quatFromAxisAngle([1, 0, 0], pitch),
  );
  return quatNormalize(quatMultiply(aim, quatFromTo(muzzle, [0, 1, 0])));
}

/**
 * Poses as the host stores them: relative to the pose that aims at the screen
 * centre. Recentring is what makes the muzzle axis coincide with the projection's
 * forward direction, so calibration data is only meaningful in this frame.
 */
function recentredPoses(points: Vec2[], muzzle: Vec3): Quat[] {
  const ref = referenceFrameForRecentre(poseAiming(CENTRE, muzzle));
  return points.map((pt) => applyReferenceFrame(poseAiming(pt, muzzle), ref));
}

function planesFor(points: Vec2[], muzzle: Vec3, as = muzzle): Vec2[] {
  return recentredPoses(points, muzzle).map(
    (q) => orientationToPlane(q, { muzzle: as, label: "" })!,
  );
}

const POINTS = calibrationPoints(SCREEN[0], SCREEN[1], 40);

describe("calibrationPoints", () => {
  it("puts the four corners first and adds interior coverage", () => {
    expect(POINTS).toHaveLength(9);
    expect(POINTS.slice(0, 4)).toEqual([
      [40, 40],
      [1880, 40],
      [1880, 1040],
      [40, 1040],
    ]);
    expect(POINTS[8]).toEqual([960, 540]);
  });
});

describe("solveHomography", () => {
  it("recovers the screen mapping from 9 aimed poses", () => {
    const planes = planesFor(POINTS, [0, 1, 0]);
    const H = solveHomography(planes, POINTS);
    expect(H).not.toBeNull();
    for (let i = 0; i < POINTS.length; i++) {
      const got = applyHomography(H!, planes[i]!);
      expect(got[0]).toBeCloseTo(POINTS[i]![0]!, 3);
      expect(got[1]).toBeCloseTo(POINTS[i]![1]!, 3);
    }
  });

  it("still handles the minimal four-point case", () => {
    const src: Vec2[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const dst: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const H = solveHomography(src, dst);
    expect(H).not.toBeNull();
    const mid = applyHomography(H!, [0, 0]);
    expect(mid[0]).toBeCloseTo(50, 6);
    expect(mid[1]).toBeCloseTo(50, 6);
  });

  it("interpolates an untrained interior point after a corners-only fit", () => {
    const corners = POINTS.slice(0, 4);
    const H = solveHomography(planesFor(corners, [0, 1, 0]), corners)!;
    const got = applyHomography(H, planesFor([CENTRE], [0, 1, 0])[0]!);
    expect(Math.hypot(got[0] - CENTRE[0], got[1] - CENTRE[1])).toBeLessThan(1);
  });
});

describe("crossValidateHomography", () => {
  it("reports sub-pixel error for consistent captures", () => {
    const cv = crossValidateHomography(planesFor(POINTS, [0, 1, 0]), POINTS);
    expect(cv).not.toBeNull();
    expect(cv!.maxError).toBeLessThan(1);
  });

  it("exposes a sloppy capture that a 4-point fit would hide", () => {
    const planes = planesFor(POINTS, [0, 1, 0]);
    const ref = referenceFrameForRecentre(poseAiming(CENTRE, [0, 1, 0]));
    const nudged = applyReferenceFrame(
      quatNormalize(
        quatMultiply(
          poseAiming(POINTS[5]!, [0, 1, 0]),
          quatFromAxisAngle([1, 0, 0], (4 * Math.PI) / 180),
        ),
      ),
      ref,
    );
    planes[5] = orientationToPlane(nudged, { muzzle: [0, 1, 0], label: "" })!;

    const cv = crossValidateHomography(planes, POINTS);
    expect(cv!.maxError).toBeGreaterThan(50);

    // The same data inside an exactly-determined fit leaves no trace at all.
    const fourPoint = solveHomography(planes.slice(0, 4), POINTS.slice(0, 4))!;
    const mapped = applyHomography(fourPoint, planes[0]!);
    expect(Math.hypot(mapped[0] - POINTS[0]![0], mapped[1] - POINTS[0]![1])).toBeLessThan(1e-6);
  });
});

describe("detectAimBasis", () => {
  // A muzzle and its opposite produce plane coordinates that differ by a fixed
  // linear map, so the homography absorbs the difference and both give the same
  // aim. Only the axis matters, not its sign.
  it("identifies the axis the player used as the barrel", () => {
    for (const muzzle of [[0, 1, 0], [0, 0, -1], [1, 0, 0]] as Vec3[]) {
      const fit = detectAimBasis(recentredPoses(POINTS, muzzle), POINTS);
      expect(fit).not.toBeNull();
      expect(fit!.validated).toBe(true);
      expect(fit!.maxError).toBeLessThan(1);
      expect(Math.abs(dot3(fit!.basis.muzzle, muzzle))).toBeCloseTo(1, 8);
    }
  });

  it("aims correctly at points it was never calibrated on", () => {
    const muzzle: Vec3 = [0, 1, 0];
    const fit = detectAimBasis(recentredPoses(POINTS, muzzle), POINTS)!;
    const ref = referenceFrameForRecentre(poseAiming(CENTRE, muzzle));
    for (const probe of [[300, 200], [1500, 850], [960, 300]] as Vec2[]) {
      const q = applyReferenceFrame(poseAiming(probe, muzzle), ref);
      const aimed = applyHomography(fit.H, orientationToPlane(q, fit.basis)!);
      expect(Math.hypot(aimed[0] - probe[0], aimed[1] - probe[1])).toBeLessThan(1);
    }
  });

  it("separates the correct barrel axis from a perpendicular one", () => {
    const fit = detectAimBasis(recentredPoses(POINTS, [0, 1, 0]), POINTS)!;
    const wrong = crossValidateHomography(
      planesFor(POINTS, [0, 1, 0], [0, 0, 1]),
      POINTS,
    );
    expect(fit.meanError).toBeLessThan(1);
    expect(wrong!.meanError).toBeGreaterThan(fit.meanError * 10);
  });

  // Four points determine a homography exactly. Affine leave-one-out is the
  // check that used to run, but a player sitting off-centre makes the screen a
  // trapezoid, and three corners then "predict" the fourth hundreds of pixels
  // off even when every capture is perfect.
  it("fits a four-point homography instead of treating perspective as error", () => {
    const corners = POINTS.slice(0, 4);
    const eyeX = 480;
    const muzzle: Vec3 = [0, 1, 0];
    const poseAt = (point: Vec2) => poseAiming(point, muzzle, eyeX);
    const ref = referenceFrameForRecentre(poseAt(CENTRE));
    const recentred = corners.map((pt) => applyReferenceFrame(poseAt(pt), ref));
    const planes = recentred.map(
      (q) => orientationToPlane(q, { muzzle, label: "" })!,
    );
    const affineCv = crossValidateAffine(planes, corners)!;
    const fit = detectAimBasis(recentred, corners)!;
    expect(affineCv.maxError).toBeGreaterThan(50);
    expect(fit.model).toBe("projective");
    expect(fit.validated).toBe(false);
    expect(fit.maxError).toBeLessThan(1);
    expect(fit.maxError).toBeLessThan(affineCv.maxError / 20);
  });

  it("validates corners plus centre with homography leave-one-out", () => {
    const five = [...POINTS.slice(0, 4), POINTS[8]!];
    const fit = detectAimBasis(recentredPoses(five, [0, 1, 0]), five)!;
    expect(fit.validated).toBe(true);
    expect(fit.maxError).toBeLessThan(2);
  });

  it("only pays for projective terms when they earn it on held-out error", () => {
    const fit = detectAimBasis(recentredPoses(POINTS, [0, 1, 0]), POINTS)!;
    if (fit.model === "affine") {
      expect(fit.H[6]).toBe(0);
      expect(fit.H[7]).toBe(0);
    }
    const affineOnly = solveAffine(planesFor(POINTS, [0, 1, 0], [0, 1, 0]), POINTS)!;
    expect(affineOnly[6]).toBe(0);
    expect(affineOnly[7]).toBe(0);
  });
});

describe("clampToSafeDomain", () => {
  // The denominator's zero sat just outside this screen, so aiming a little past
  // the edge sent the gain to hundreds of pixels per degree.
  const H: Mat3 = [800, 0, 815, 0, 800, 518, 0, 0.826, 1];

  it("leaves an aim inside the calibrated area untouched", () => {
    for (const p of [[0, 0], [0.3, -0.18], [-0.34, 0.28]] as Vec2[]) {
      const safe = clampToSafeDomain(H, p);
      expect(safe[0]).toBeCloseTo(p[0], 12);
      expect(safe[1]).toBeCloseTo(p[1], 12);
    }
  });

  it("keeps the mapping's gain bounded however far past the screen you aim", () => {
    let worst = 0;
    for (let deg = 0; deg <= 80; deg += 1) {
      const p: Vec2 = [0, -Math.tan((deg * Math.PI) / 180)];
      const safe = clampToSafeDomain(H, p);
      const [a, b, c, d] = homographyJacobian(H, safe);
      worst = Math.max(worst, Math.hypot(a, b, c, d));
      expect(Number.isFinite(safe[0]) && Number.isFinite(safe[1])).toBe(true);
    }
    // Unclamped this reaches into the tens of thousands as the denominator dies.
    expect(worst).toBeLessThan(6000);
  });

  it("holds the aim direction while pulling it in", () => {
    const p: Vec2 = [0.4, -1.4];
    const safe = clampToSafeDomain(H, p);
    expect(safe[0] / safe[1]).toBeCloseTo(p[0] / p[1], 8);
    expect(Math.hypot(...safe)).toBeLessThan(Math.hypot(...p));
  });
});

describe("homographyJacobian", () => {
  it("matches a finite-difference of the mapping", () => {
    const H = solveHomography(planesFor(POINTS, [0, 1, 0]), POINTS)!;
    const p: Vec2 = [0.05, -0.03];
    const [dudx, dudy, dvdx, dvdy] = homographyJacobian(H, p);
    const eps = 1e-6;
    const base = applyHomography(H, p);
    const byX = applyHomography(H, [p[0] + eps, p[1]]);
    const byY = applyHomography(H, [p[0], p[1] + eps]);
    expect((byX[0] - base[0]) / eps).toBeCloseTo(dudx, 2);
    expect((byY[0] - base[0]) / eps).toBeCloseTo(dudy, 2);
    expect((byX[1] - base[1]) / eps).toBeCloseTo(dvdx, 2);
    expect((byY[1] - base[1]) / eps).toBeCloseTo(dvdy, 2);
  });
});
