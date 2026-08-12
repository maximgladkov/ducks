import {
  fitPlaneToScreen,
  homographyResiduals,
  solveHomography,
  type PlaneFitModel,
} from "./homography.js";
import {
  MUZZLE_CANDIDATES,
  orientationToPlane,
  type AimBasis,
} from "./quat.js";
import type { Mat3, Quat, Vec2 } from "./types.js";

export type GripFit = {
  basis: AimBasis;
  H: Mat3;
  /** Worst leave-one-out error in pixels, or fit residual when N < 5. */
  maxError: number;
  meanError: number;
  /** True when enough points were supplied for the error to be meaningful. */
  validated: boolean;
  /** Which mapping won on held-out error. */
  model: PlaneFitModel;
};

/**
 * Picks the muzzle axis whose projection best explains the calibration captures.
 *
 * Only the muzzle is searched. Axis swaps and inversions are linear maps of the
 * plane, so the homography reproduces them exactly and every combination scores
 * identically -- including them would leave the winner decided by floating-point
 * noise rather than geometry.
 */
export function detectAimBasis(
  quats: Quat[],
  screenPoints: Vec2[],
): GripFit | null {
  const n = Math.min(quats.length, screenPoints.length);
  if (n < 4) return null;
  const targets = screenPoints.slice(0, n);

  let best: GripFit | null = null;

  for (const candidate of MUZZLE_CANDIDATES) {
    const basis: AimBasis = {
      muzzle: candidate.muzzle,
      label: candidate.label,
    };

    const planes: Vec2[] = [];
    let ok = true;
    for (const q of quats.slice(0, n)) {
      const plane = orientationToPlane(q, basis);
      if (!plane) {
        ok = false;
        break;
      }
      planes.push(plane);
    }
    if (!ok) continue;

    const chosen = fitPlaneToScreen(planes, targets);
    let fit: GripFit;
    if (chosen) {
      fit = {
        basis,
        H: chosen.H,
        maxError: chosen.maxError,
        meanError: chosen.meanError,
        validated: true,
        model: chosen.model,
      };
    } else {
      // Too few points to hold any out, so residuals are all that is available.
      const H = solveHomography(planes, targets);
      if (!H) continue;
      const residuals = homographyResiduals(H, planes, targets);
      fit = {
        basis,
        H,
        maxError: Math.max(...residuals),
        meanError: residuals.reduce((a, b) => a + b, 0) / residuals.length,
        validated: false,
        model: "projective",
      };
    }

    if (!best || fit.meanError < best.meanError) best = fit;
  }

  return best;
}
