import {
  AimSession,
  CALIB_FULL_COUNT,
  CALIB_POINT_COUNT,
  CALIB_REFRESH_COUNT,
  MUZZLE_CANDIDATES,
  applyHomography,
  applyReferenceFrame,
  averageQuats,
  calibReferencePose,
  calibTargets,
  crossValidateHomography,
  orientationToPlane,
  pixelsPerDegree,
  quatAngularSpread,
  quatDriftRate,
  referenceFrameForRecentre,
  sliceCalibWindow,
  solveHomography,
  type AimBasis,
  type Quat,
  type StoredAimMapping,
  type Vec2,
} from "gyro-aim";
import type { Entity } from "koota";
import { diagLog, round, roundAll } from "./diag";
import { Aim, Player } from "./ecs/traits";

export {
  CALIB_FULL_COUNT,
  CALIB_POINT_COUNT,
  CALIB_REFRESH_COUNT,
  averageQuats,
  calibTargets,
  quatAngularSpread,
  quatDriftRate,
  sliceCalibWindow,
};

export {
  DEFAULT_DEBUG_SETTINGS,
  loadSettings,
  saveSettings,
  type DebugSettings,
} from "./gameSettings";

export function sessionOf(entity: Entity): AimSession {
  return entity.get(Aim)!.session;
}

export function beginCalibration(
  entity: Entity,
  opts: { total?: number; keepMapping?: boolean } = {},
): void {
  sessionOf(entity).beginCalibration(opts);
}

export function samplePlane(entity: Entity): Vec2 | null {
  return sessionOf(entity).samplePlane();
}

export function sampleCalibQuat(entity: Entity): Quat | null {
  return sessionOf(entity).sampleCalibQuat();
}

export function recordCalibCorner(
  entity: Entity,
  quat: Quat,
  plane: Vec2,
  screen: Vec2,
): void {
  const session = sessionOf(entity);
  session.setScreen(screen);
  session.recordPoint(quat, plane);
}

export function finishCalibration(
  entity: Entity,
  screen: Vec2,
): ReturnType<AimSession["finishCalibration"]> {
  const session = sessionOf(entity);
  session.setScreen(screen);
  const needed = session.calibTotal;
  const quats = session.calibQuats.slice();
  const used = calibTargets(screen).slice(0, quats.length);
  const posed =
    quats.length >= needed
      ? quats.map((q) =>
          applyReferenceFrame(
            q,
            referenceFrameForRecentre(calibReferencePose(quats, used, screen)),
          ),
        )
      : [];
  const result = session.finishCalibration();
  if (posed.length) logCalibrationReport(entity, posed, screen, result.ok, quats);
  return result;
}

export function applyStoredCalibration(
  entity: Entity,
  stored: StoredAimMapping,
): void {
  sessionOf(entity).applyStoredMapping(stored);
}

export function logCalibrationReport(
  entity: Entity,
  recentred: Quat[],
  screen: Vec2,
  accepted: boolean,
  rawQuats: Quat[] = recentred,
): void {
  const session = sessionOf(entity);
  const targets = calibTargets(screen).slice(0, recentred.length);
  const candidates = MUZZLE_CANDIDATES.map((candidate) => {
    const basis: AimBasis = { muzzle: candidate.muzzle, label: candidate.label };
    const planes = recentred.map((q) => orientationToPlane(q, basis));
    if (planes.some((plane) => !plane)) {
      return { label: candidate.label, error: "plane undefined" };
    }
    const src = planes as Vec2[];
    const H = solveHomography(src, targets);
    const cv = crossValidateHomography(src, targets);
    return {
      label: candidate.label,
      cvMaxPx: cv ? round(cv.maxError, 1) : null,
      cvMeanPx: cv ? round(cv.meanError, 1) : null,
      planes: src.map((s) => roundAll(s)),
      pxPerDeg: H ? roundAll(pixelsPerDegree(H, [0, 0], screen), 2) : null,
    };
  });

  const chosenPlanes = recentred.map((q) =>
    orientationToPlane(q, session.aimBasis),
  );
  diagLog("calib_report", {
    id: entity.get(Player)?.id,
    accepted,
    screen,
    chosen: session.aimBasis.label,
    muzzle: session.aimBasis.muzzle,
    homography: session.homography
      ? roundAll(session.homography, 6)
      : null,
    targets,
    quats: recentred.map((q) => roundAll(q)),
    rawQuats: rawQuats.map((q) => roundAll(q)),
    chosenPlanes: chosenPlanes.map((s) => (s ? roundAll(s) : null)),
    mappedPx: session.homography
      ? chosenPlanes.map((s) =>
          s ? roundAll(applyHomography(session.homography!, s), 1) : null,
        )
      : null,
    pxPerDegCentre: roundAll(
      pixelsPerDegree(session.homography, [0, 0], screen),
      2,
    ),
    candidates,
  });
}
