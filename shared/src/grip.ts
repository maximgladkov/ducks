import {
  applyHomography,
  solveHomography,
  validateHomography,
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
  maxError: number;
};

export function detectAimBasis(
  quats: Quat[],
  screenCorners: Vec2[],
  screenSize: Vec2,
): GripFit | null {
  if (quats.length < 4 || screenCorners.length < 4) return null;

  let best: GripFit | null = null;

  for (const candidate of MUZZLE_CANDIDATES) {
    for (const swapXY of [false, true]) {
      for (const invertX of [false, true]) {
        for (const invertY of [false, true]) {
          const basis: AimBasis = {
            muzzle: candidate.muzzle,
            swapXY,
            invertX,
            invertY,
            label: formatBasisLabel(candidate.label, swapXY, invertX, invertY),
          };
          const planes: Vec2[] = [];
          let ok = true;
          for (const q of quats.slice(0, 4)) {
            const plane = orientationToPlane(q, basis);
            if (!plane) {
              ok = false;
              break;
            }
            planes.push(plane);
          }
          if (!ok) continue;

          const H = solveHomography(planes, screenCorners.slice(0, 4));
          if (!H) continue;
          const check = validateHomography(
            H,
            planes,
            screenCorners.slice(0, 4),
            0.08,
            screenSize,
          );
          if (!best || check.maxError < best.maxError) {
            best = { basis, H, maxError: check.maxError };
          }
        }
      }
    }
  }

  if (!best) return null;
  const cornersMapped = [0, 1, 2, 3].every((i) => {
    const plane = orientationToPlane(quats[i]!, best!.basis);
    if (!plane) return false;
    const p = applyHomography(best!.H, plane);
    const dx = (p[0] - screenCorners[i]![0]) / screenSize[0];
    const dy = (p[1] - screenCorners[i]![1]) / screenSize[1];
    return Math.hypot(dx, dy) < 0.08;
  });
  if (!cornersMapped && best.maxError > 0.05) return null;
  return best;
}

function formatBasisLabel(
  muzzle: string,
  swapXY: boolean,
  invertX: boolean,
  invertY: boolean,
): string {
  const bits = [muzzle];
  if (swapXY) bits.push("swapXY");
  if (invertX) bits.push("invX");
  if (invertY) bits.push("invY");
  return bits.join(" · ");
}
