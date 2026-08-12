import {
  DEFAULT_AIM_BASIS,
  DEFAULT_DEBUG_SETTINGS,
  MUZZLE_CANDIDATES,
  OneEuroFilter2D,
  aimAssistPull,
  anglesDegToPlane,
  applyHomography,
  applyReferenceFrame,
  calibrationPoints,
  clampAim,
  clampToSafeDomain,
  colorForPlayer,
  crossValidateHomography,
  detectAimBasis,
  hitscan,
  learnAimOffset,
  solveHomography,
  homographyJacobian,
  hostTimeFromController,
  lerp,
  orientationToPlane,
  planeToAnglesDeg,
  predictOrientationSafe,
  quatConjugate,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  referenceFrameForRecentre,
  sampleAgeMs,
  type AimBasis,
  type ControllerEvent,
  type ControllerSample,
  type DebugSettings,
  type Mat3,
  type Quat,
  type TransportKind,
  type Vec2,
} from "@duckhunt/shared";
import { HUD_MAX_SHOTS } from "./hud";
import { diagEvery, diagLog, round, roundAll } from "./diag";

export type Target = {
  id: string;
  x: number;
  y: number;
  radius: number;
  vx: number;
  vy: number;
  phase: number;
  amp: number;
  baseY: number;
  life: number;
  flash: number;
  falling: boolean;
  stationary: boolean;
  kind: "black" | "brown" | "blue";
};

export type PlayerRuntime = {
  id: string;
  color: string;
  index: number;
  transport: TransportKind;
  clockOffset: number;
  rtt: number;
  packets: number;
  dropped: number;
  lastSample: ControllerSample | null;
  prevSample: ControllerSample | null;
  lastHostReceive: number;
  refInverse: Quat;
  homography: Mat3 | null;
  aimBasis: AimBasis;
  relativePos: Vec2;
  prevQ: Quat | null;
  filter: OneEuroFilter2D;
  raw: Vec2;
  filtered: Vec2;
  predicted: Vec2;
  aim: Vec2;
  clamped: boolean;
  edge: Vec2;
  sampleAge: number;
  missFlash: number;
  score: number;
  shots: number;
  flightHits: number;
  awaitingDog: boolean;
  calibRays: Vec2[];
  calibQuats: Quat[];
  calibrating: boolean;
  hasRecentered: boolean;
  sensorReady: boolean;
  sensorTiltDeg: number;
  /** Standing correction for accumulated drift, in plane units. */
  aimBias: Vec2;
  /** Shots that have contributed to `aimBias`. */
  biasShots: number;
  lastAimPlane: Vec2 | null;
  gripLabel: string;
  el: HTMLDivElement;
  wedge: HTMLDivElement;
  ghostRaw: HTMLDivElement;
  ghostFilt: HTMLDivElement;
  ghostPred: HTMLDivElement;
};

// Bumped from v4: filter parameters moved from pixels to degrees of aim angle,
// so previously stored values mean something entirely different now.
const SETTINGS_KEY = "duckhunt.debug.v7";

export function loadSettings(): DebugSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_DEBUG_SETTINGS, invertX: false, invertY: false };
    return {
      ...DEFAULT_DEBUG_SETTINGS,
      invertX: false,
      invertY: false,
      ...JSON.parse(raw),
    };
  } catch {
    return { ...DEFAULT_DEBUG_SETTINGS, invertX: false, invertY: false };
  }
}

export function saveSettings(s: DebugSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  diagLog("settings", { ...s });
}

export function createPlayer(
  id: string,
  index: number,
  layer: HTMLElement,
  settings: DebugSettings,
): PlayerRuntime {
  const color = colorForPlayer(index);
  const el = document.createElement("div");
  el.className = "crosshair";
  el.style.color = color;
  el.innerHTML =
    '<div class="crosshair-outer"></div><div class="crosshair-ring"></div><div class="crosshair-h"></div><div class="crosshair-v"></div><div class="crosshair-dot"></div>';
  const wedge = document.createElement("div");
  wedge.className = "wedge";
  wedge.style.color = color;
  wedge.style.display = "none";
  el.appendChild(wedge);

  const ghostRaw = ghost(color, 0.35);
  const ghostFilt = ghost(color, 0.55);
  const ghostPred = ghost("#ffffff", 0.45);
  layer.appendChild(ghostRaw);
  layer.appendChild(ghostFilt);
  layer.appendChild(ghostPred);
  layer.appendChild(el);

  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    id,
    color,
    index,
    transport: "websocket",
    clockOffset: 0,
    rtt: 0,
    packets: 0,
    dropped: 0,
    lastSample: null,
    prevSample: null,
    lastHostReceive: 0,
    refInverse: quatIdentity(),
    homography: null,
    aimBasis: { ...DEFAULT_AIM_BASIS },
    relativePos: [w / 2, h / 2],
    prevQ: null,
    filter: new OneEuroFilter2D({
      minCutoff: settings.minCutoff,
      beta: settings.beta,
    }),
    raw: [w / 2, h / 2],
    filtered: [w / 2, h / 2],
    predicted: [w / 2, h / 2],
    aim: [w / 2, h / 2],
    clamped: false,
    edge: [0, 0],
    sampleAge: 0,
    missFlash: 0,
    score: 0,
    shots: HUD_MAX_SHOTS,
    flightHits: 0,
    awaitingDog: false,
    calibRays: [],
    calibQuats: [],
    calibrating: false,
    hasRecentered: false,
    sensorReady: false,
    sensorTiltDeg: 0,
    aimBias: [0, 0],
    biasShots: 0,
    lastAimPlane: null,
    gripLabel: DEFAULT_AIM_BASIS.label,
    el,
    wedge,
    ghostRaw,
    ghostFilt,
    ghostPred,
  };
}

function ghost(color: string, opacity: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ghost";
  el.style.background = color;
  el.style.opacity = String(opacity);
  return el;
}

export function removePlayer(p: PlayerRuntime): void {
  p.el.remove();
  p.ghostRaw.remove();
  p.ghostFilt.remove();
  p.ghostPred.remove();
}

export function ingestSample(p: PlayerRuntime, sample: ControllerSample, settings: DebugSettings): void {
  if (!p.hasRecentered) {
    p.refInverse = referenceFrameForRecentre(sample.q);
    p.hasRecentered = true;
    p.filter.reset();
  }
  if (!settings.absoluteAiming && p.lastSample) {
    const from = orientationToPlane(
      applyReferenceFrame(p.lastSample.q, p.refInverse),
      p.aimBasis,
    );
    const to = orientationToPlane(
      applyReferenceFrame(sample.q, p.refInverse),
      p.aimBasis,
    );
    if (from && to) {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      // Converting the plane delta through the calibration Jacobian makes
      // relative mode inherit the axis orientation and scale that calibration
      // already established, instead of guessing them separately.
      let stepX: number;
      let stepY: number;
      if (p.homography) {
        const [dudx, dudy, dvdx, dvdy] = homographyJacobian(p.homography, from);
        stepX = dudx * dx + dudy * dy;
        stepY = dvdx * dx + dvdy * dy;
      } else {
        stepX = dx * settings.sensitivity;
        stepY = dy * settings.sensitivity;
      }
      const sx = settings.invertX ? -1 : 1;
      const sy = settings.invertY ? -1 : 1;
      p.relativePos = [
        p.relativePos[0] + stepX * sx,
        p.relativePos[1] + stepY * sy,
      ];
    }
  }
  p.prevSample = p.lastSample;
  p.lastSample = sample;
  p.lastHostReceive = performance.now();
  p.packets += 1;
}

export function handlePlayerEvent(
  p: PlayerRuntime,
  event: ControllerEvent,
  settings: DebugSettings,
  screen: Vec2,
  targets: Target[],
  onCalibPoint: (p: PlayerRuntime, seq: number) => void,
): { hitId: string | null; miss: boolean } {
  if (event.type === "recentre") {
    if (p.lastSample) {
      p.refInverse = referenceFrameForRecentre(p.lastSample.q);
      p.hasRecentered = true;
      // Measured against the old reference, so it means nothing against the new.
      p.aimBias = [0, 0];
      p.biasShots = 0;
    }
    if (!settings.absoluteAiming) {
      p.relativePos = [screen[0] / 2, screen[1] / 2];
    }
    p.filter.reset();
    return { hitId: null, miss: false };
  }

  if (event.type === "calib_point") {
    onCalibPoint(p, event.seq);
    return { hitId: null, miss: false };
  }

  if (event.type === "trigger_down") {
    if (p.calibrating) {
      onCalibPoint(p, p.calibRays.length);
      return { hitId: null, miss: false };
    }
    const hitId = hitscan(
      p.aim,
      targets.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        radius: t.radius,
      })),
      settings.aimAssistEnabled ? 10 : 4,
    );
    learnAimBias(p, targets, settings, screen);
    if (hitId) {
      return { hitId, miss: false };
    }
    p.missFlash = 1;
    return { hitId: null, miss: true };
  }

  return { hitId: null, miss: false };
}

/**
 * Resolves the orientation to show this frame.
 *
 * Samples arrive at their own rate, so the two most recent are interpolated with
 * slerp to the current display time. Extrapolating past the newest sample is
 * left to the gyroscope-driven prediction step, which knows the actual angular
 * velocity, rather than to the interpolator.
 */
function orientationForNow(
  p: PlayerRuntime,
  settings: DebugSettings,
  predictMs: number,
): { base: Quat; predicted: Quat } | null {
  const sample = p.lastSample;
  if (!sample) return null;

  const hostNow = performance.now();
  p.sampleAge = sampleAgeMs(sample.t, p.clockOffset, hostNow);

  let q = sample.q;
  let w = sample.w;
  if (p.prevSample) {
    const span = Math.max(1, sample.t - p.prevSample.t);
    const alpha = Math.min(
      1,
      Math.max(0, (hostNow - hostTimeFromController(p.prevSample.t, p.clockOffset)) / span),
    );
    q = quatSlerp(p.prevSample.q, sample.q, alpha);
    w = [
      lerp(p.prevSample.w[0], sample.w[0], alpha),
      lerp(p.prevSample.w[1], sample.w[1], alpha),
      lerp(p.prevSample.w[2], sample.w[2], alpha),
    ];
  }

  const base = applyReferenceFrame(q, p.refInverse);
  if (!settings.predictionEnabled) return { base, predicted: base };

  const horizon = (Math.max(0, p.sampleAge) + predictMs) / 1000;
  return {
    base,
    predicted: applyReferenceFrame(
      predictOrientationSafe(q, w, horizon),
      p.refInverse,
    ),
  };
}

function planeToScreen(
  plane: Vec2,
  p: PlayerRuntime,
  screen: Vec2,
  settings: DebugSettings,
): Vec2 {
  const corrected: Vec2 = [plane[0] + p.aimBias[0], plane[1] + p.aimBias[1]];
  const bounded: Vec2 = [
    Math.max(-3, Math.min(3, corrected[0])),
    Math.max(-3, Math.min(3, corrected[1])),
  ];
  let mapped: Vec2;
  if (p.homography) {
    mapped = applyHomography(
      p.homography,
      clampToSafeDomain(p.homography, bounded),
    );
  } else {
    const scale = Math.min(screen[0], screen[1]) * 0.55;
    mapped = [screen[0] / 2 + bounded[0] * scale, screen[1] / 2 + bounded[1] * scale];
  }
  return [
    settings.invertX ? screen[0] - mapped[0] : mapped[0],
    settings.invertY ? screen[1] - mapped[1] : mapped[1],
  ];
}

export function updatePlayerFrame(
  p: PlayerRuntime,
  settings: DebugSettings,
  screen: Vec2,
  targets: Target[],
  dt: number,
  showGhosts: boolean,
): void {
  p.filter.setParams({ minCutoff: settings.minCutoff, beta: settings.beta });

  const oriented = orientationForNow(
    p,
    settings,
    settings.predictionHorizonMs + 1000 / 60,
  );
  if (!oriented) return;
  p.prevQ = oriented.base;

  if (!settings.absoluteAiming) {
    p.raw = [...p.relativePos] as Vec2;
    p.predicted = p.raw;
    p.filtered = p.raw;
    finishFrame(p, p.raw, settings, screen, targets, dt, showGhosts);
    return;
  }

  const rawPlane = orientationToPlane(oriented.base, p.aimBasis);
  const predictedPlane = orientationToPlane(oriented.predicted, p.aimBasis);
  if (!rawPlane || !predictedPlane) return;

  p.raw = planeToScreen(rawPlane, p, screen, settings);
  p.predicted = planeToScreen(predictedPlane, p, screen, settings);

  // Smoothing happens in degrees of aim angle rather than pixels. Pixels are
  // stretched unevenly by the homography, which would make the crosshair damp
  // differently at the edges than in the middle.
  let aimPlane = predictedPlane;
  if (settings.filteringEnabled) {
    const angles = planeToAnglesDeg(predictedPlane);
    const smoothed = p.filter.filterWithLead(
      angles[0],
      angles[1],
      performance.now() / 1000,
      settings.filterLeadGain,
    );
    aimPlane = anglesDegToPlane(smoothed);
  }

  p.filtered = planeToScreen(aimPlane, p, screen, settings);
  p.lastAimPlane = aimPlane;
  logAimFrame(p, rawPlane, predictedPlane, aimPlane, screen);
  finishFrame(p, p.filtered, settings, screen, targets, dt, showGhosts);
}

/**
 * Learns a standing aim correction from where the player actually shoots.
 *
 * Heading has nothing to hold it in place: the phone has no compass worth using,
 * so gravity fixes tilt while yaw is free to wander a few tenths of a degree per
 * second, and after a minute the crosshair sits slightly off. There is no sensor
 * that can see this, but the player can, and they reveal it every time they
 * shoot: with one duck plainly under the crosshair, the gap between where they
 * fired and where that duck was is a reading of the accumulated error.
 *
 * Any single reading is mostly the player's own aim, so only a small fraction of
 * each is taken and only when the intended duck is unambiguous. Over a handful of
 * consistent shots the common part -- the drift -- accumulates while the player's
 * scatter cancels out. The total is capped, so even a run of strange shots can
 * only nudge the aim rather than take it over.
 */
function learnAimBias(
  p: PlayerRuntime,
  targets: Target[],
  settings: DebugSettings,
  screen: Vec2,
): void {
  if (!settings.driftLearningEnabled) return;
  if (!p.homography || !p.lastAimPlane || p.calibrating) return;

  // The mapping flips the pixel axes after the fact, so the gap has to be read
  // back through the same flip to mean anything in aim units.
  const seen: Vec2 = [
    settings.invertX ? screen[0] - p.filtered[0] : p.filtered[0],
    settings.invertY ? screen[1] - p.filtered[1] : p.filtered[1],
  ];
  const asAimed = targets.map((t) => ({
    x: settings.invertX ? screen[0] - t.x : t.x,
    y: settings.invertY ? screen[1] - t.y : t.y,
    radius: t.radius,
  }));

  const next = learnAimOffset(
    p.aimBias,
    seen,
    asAimed,
    homographyJacobian(p.homography, p.lastAimPlane),
  );
  if (!next) return;
  p.aimBias = next;
  p.biasShots += 1;

  diagLog("bias", {
    id: p.id,
    shots: p.biasShots,
    biasDeg: roundAll(
      [
        (Math.atan(p.aimBias[0]) * 180) / Math.PI,
        (Math.atan(p.aimBias[1]) * 180) / Math.PI,
      ],
      3,
    ),
  });
}

/**
 * Screen pixels per degree of aim angle, as the 2x2 matrix
 * [dU/dAngleX, dU/dAngleY; dV/dAngleX, dV/dAngleY]. Plane coordinates are
 * tangents, so the chain rule picks up a sec^2 term away from the centre.
 */
function pixelsPerDegree(H: Mat3 | null, plane: Vec2, screen: Vec2): number[] {
  const rad = Math.PI / 180;
  const sx = (1 + plane[0] * plane[0]) * rad;
  const sy = (1 + plane[1] * plane[1]) * rad;
  if (!H) {
    const scale = Math.min(screen[0], screen[1]) * 0.55;
    return [scale * sx, 0, 0, scale * sy];
  }
  const [dudx, dudy, dvdx, dvdy] = homographyJacobian(H, plane);
  return [dudx * sx, dudy * sy, dvdx * sx, dvdy * sy];
}

function logAimFrame(
  p: PlayerRuntime,
  rawPlane: Vec2,
  predictedPlane: Vec2,
  aimPlane: Vec2,
  screen: Vec2,
): void {
  if (!diagEvery(`aim:${p.id}`, 100)) return;
  const sample = p.lastSample;
  diagLog("aim", {
    id: p.id,
    sensorQ: sample ? roundAll(sample.q) : null,
    sensorW: sample ? roundAll(sample.w) : null,
    sampleAgeMs: round(p.sampleAge, 1),
    clockOffset: round(p.clockOffset, 1),
    plane: roundAll(rawPlane),
    predictedPlane: roundAll(predictedPlane),
    aimPlane: roundAll(aimPlane),
    anglesDeg: roundAll(planeToAnglesDeg(rawPlane), 3),
    filteredDeg: roundAll(planeToAnglesDeg(aimPlane), 3),
    rawPx: roundAll(p.raw, 1),
    filteredPx: roundAll(p.filtered, 1),
    predictedPx: roundAll(p.predicted, 1),
    pxPerDeg: roundAll(pixelsPerDegree(p.homography, rawPlane, screen), 2),
  });
}

/**
 * Everything needed to judge a calibration after the fact: how each muzzle
 * candidate scored, what the accepted fit maps to, and the resulting
 * sensitivity, which is what a sluggish or lopsided crosshair shows up in.
 */
export function logCalibrationReport(
  p: PlayerRuntime,
  recentred: Quat[],
  screen: Vec2,
  accepted: boolean,
): void {
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

  const chosenPlanes = recentred.map((q) => orientationToPlane(q, p.aimBasis));
  diagLog("calib_report", {
    id: p.id,
    accepted,
    screen,
    chosen: p.aimBasis.label,
    muzzle: p.aimBasis.muzzle,
    homography: p.homography ? roundAll(p.homography, 6) : null,
    targets,
    quats: recentred.map((q) => roundAll(q)),
    rawQuats: p.calibQuats.map((q) => roundAll(q)),
    chosenPlanes: chosenPlanes.map((s) => (s ? roundAll(s) : null)),
    mappedPx: p.homography
      ? chosenPlanes.map((s) =>
          s ? roundAll(applyHomography(p.homography!, s), 1) : null,
        )
      : null,
    pxPerDegCentre: roundAll(pixelsPerDegree(p.homography, [0, 0], screen), 2),
    candidates,
  });
}

function finishFrame(
  p: PlayerRuntime,
  point: Vec2,
  settings: DebugSettings,
  screen: Vec2,
  targets: Target[],
  dt: number,
  showGhosts: boolean,
): void {
  let aim = point;
  if (settings.aimAssistEnabled) {
    aim = aimAssistPull(
      aim,
      targets.map((t) => ({ x: t.x, y: t.y, radius: t.radius })),
      settings.aimAssistRadius,
    );
  }

  const clamped = clampAim(aim[0], aim[1], screen[0], screen[1]);
  p.aim = [clamped.x, clamped.y];
  p.clamped = clamped.clamped;
  p.edge = [clamped.nx, clamped.ny];

  p.el.style.transform = `translate3d(${p.aim[0]}px, ${p.aim[1]}px, 0)`;
  if (p.missFlash > 0) {
    p.el.classList.add("flash");
    p.missFlash = Math.max(0, p.missFlash - dt * 4);
  } else {
    p.el.classList.remove("flash");
  }

  if (p.clamped) {
    p.wedge.style.display = "block";
    const ang = (Math.atan2(p.edge[1], p.edge[0]) * 180) / Math.PI + 90;
    p.wedge.style.transform = `translate(9px, -22px) rotate(${ang}deg)`;
  } else {
    p.wedge.style.display = "none";
  }

  const display = showGhosts ? "block" : "none";
  p.ghostRaw.style.display = display;
  p.ghostFilt.style.display = display;
  p.ghostPred.style.display = display;
  p.ghostRaw.style.transform = `translate3d(${p.raw[0]}px, ${p.raw[1]}px, 0)`;
  p.ghostFilt.style.transform = `translate3d(${p.filtered[0]}px, ${p.filtered[1]}px, 0)`;
  p.ghostPred.style.transform = `translate3d(${p.predicted[0]}px, ${p.predicted[1]}px, 0)`;
}

export function beginCalibration(p: PlayerRuntime): void {
  p.calibrating = true;
  p.calibRays = [];
  p.calibQuats = [];
  p.homography = null;
  p.aimBias = [0, 0];
  p.biasShots = 0;
  p.aimBasis = { ...DEFAULT_AIM_BASIS };
  p.gripLabel = "detecting…";
  if (p.lastSample) {
    p.refInverse = referenceFrameForRecentre(p.lastSample.q);
    p.hasRecentered = true;
  }
  p.filter.reset();
}

export function samplePlane(p: PlayerRuntime): Vec2 | null {
  if (!p.lastSample) return null;
  const q = applyReferenceFrame(p.lastSample.q, p.refInverse);
  return orientationToPlane(q, p.aimBasis);
}

/**
 * Captures are stored in the raw sensor frame, not the recentred one. The
 * reference pose is only chosen once every target has been captured, so that it
 * can be the centre target's own pose.
 */
export function sampleCalibQuat(p: PlayerRuntime): Quat | null {
  return p.lastSample ? p.lastSample.q : null;
}

export function averageQuats(quats: Quat[]): Quat | null {
  if (quats.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  const ref = quats[0]!;
  for (const q of quats) {
    const sign =
      q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0
        ? -1
        : 1;
    x += sign * q[0];
    y += sign * q[1];
    z += sign * q[2];
    w += sign * q[3];
  }
  return quatNormalize([x, y, z, w]);
}

/**
 * Net rotation rate across a capture window, in deg/s.
 *
 * Spread about the mean cannot tell a steady hand apart from an estimate that is
 * sliding at a constant rate, and a sliding estimate is exactly what makes a
 * capture disagree with the ones around it.
 */
export function quatDriftRate(quats: Quat[], windowSeconds: number): number {
  const third = Math.floor(quats.length / 3);
  if (third < 2 || windowSeconds <= 0) return 0;
  const first = averageQuats(quats.slice(0, third));
  const last = averageQuats(quats.slice(-third));
  if (!first || !last) return 0;
  const d = quatNormalize(quatMultiply(quatConjugate(first), last));
  const angle = 2 * Math.acos(Math.min(1, Math.abs(d[3])));
  const baseline = windowSeconds * (2 / 3);
  return ((angle * 180) / Math.PI) / baseline;
}

export function quatAngularSpread(quats: Quat[]): number {
  const mean = averageQuats(quats);
  if (!mean || quats.length < 2) return 0;
  let acc = 0;
  for (const q of quats) {
    const d = quatNormalize(quatMultiply(quatConjugate(mean), q));
    const w = Math.min(1, Math.abs(d[3]));
    acc += 2 * Math.acos(w);
  }
  return acc / quats.length;
}

export function recordCalibCorner(
  p: PlayerRuntime,
  quat: Quat,
  plane: Vec2,
  screen: Vec2,
): void {
  p.calibQuats.push(quat);
  p.calibRays.push(plane);
  refreshProvisionalAim(p, screen);
}

/** Captures needed before the remaining targets can be aimed at with feedback. */
const CALIB_PREVIEW_POINTS = 4;

/**
 * Switches aiming onto a mapping fitted from the captures so far, so the player
 * aims the rest of the targets with a crosshair instead of by eye. Pointing a
 * phone at a dot unaided is only good to a few degrees, which is most of the
 * error a rejected calibration reports.
 *
 * The reference pose only rotates the viewing sphere, and on a gnomonic plane
 * that is a projective change the homography absorbs exactly, so referencing an
 * early capture here costs nothing against the final fit.
 */
function refreshProvisionalAim(p: PlayerRuntime, screen: Vec2): void {
  if (p.calibQuats.length < CALIB_PREVIEW_POINTS) return;
  const targets = calibTargets(screen);
  const basis: AimBasis = { ...DEFAULT_AIM_BASIS };
  const reference = referenceFrameForRecentre(p.calibQuats[0]!);

  const planes: Vec2[] = [];
  for (const q of p.calibQuats) {
    const plane = orientationToPlane(applyReferenceFrame(q, reference), basis);
    if (!plane) return;
    planes.push(plane);
  }
  const H = solveHomography(planes, targets.slice(0, planes.length));
  if (!H) return;

  if (p.calibQuats.length === CALIB_PREVIEW_POINTS) p.filter.reset();
  p.refInverse = reference;
  p.hasRecentered = true;
  p.aimBasis = basis;
  p.homography = H;
  p.aimBias = [0, 0];
  p.biasShots = 0;
}

export const CALIB_POINT_COUNT = 9;

/** Held-out error below which a fit is treated as properly calibrated. */
const CALIB_GOOD_ERROR_FRACTION = 0.035;
/**
 * Above this the captures cannot describe one consistent grip and are discarded.
 * Between the two the fit is kept and flagged: it still anchors the crosshair to
 * absolute screen positions, which beats the uncalibrated fallback outright, and
 * recalibrating from it is far easier than starting blind.
 */
const CALIB_USABLE_ERROR_FRACTION = 0.2;

export function calibTargets(screen: Vec2): Vec2[] {
  return calibrationPoints(screen[0], screen[1]);
}

export function finishCalibration(
  p: PlayerRuntime,
  screen: Vec2,
): {
  ok: boolean;
  reason?: string;
  /** Accepted, but loose enough to be worth redoing. */
  rough?: boolean;
  /** Leave-one-out aim error in pixels. */
  errorPx: number;
  worstIndex: number;
  gripLabel?: string;
  /** Which mapping won on held-out error. */
  model?: string;
} {
  const targets = calibTargets(screen);
  if (p.calibQuats.length < CALIB_POINT_COUNT) {
    return {
      ok: false,
      reason: `Need ${CALIB_POINT_COUNT} points`,
      errorPx: Infinity,
      worstIndex: p.calibQuats.length,
    };
  }

  const used = targets.slice(0, p.calibQuats.length);
  // The centre target is captured last, and referencing every capture to that
  // pose puts the screen centre at plane (0,0). Plane coordinates then stay
  // small and symmetric instead of running out towards the 90-degree
  // singularity, and a later recentre lands the crosshair mid-screen, which is
  // what the homography already maps plane (0,0) to.
  const reference = referenceFrameForRecentre(p.calibQuats[p.calibQuats.length - 1]!);
  const recentred = p.calibQuats.map((q) => applyReferenceFrame(q, reference));

  const fit = detectAimBasis(recentred, used);
  if (!fit) {
    logCalibrationReport(p, recentred, screen, false);
    p.calibRays = [];
    p.calibQuats = [];
    return {
      ok: false,
      reason: "Could not fit a mapping — hold one consistent grip and redo",
      errorPx: Infinity,
      worstIndex: 0,
    };
  }

  const worstIndex = worstCalibPoint(recentred, fit.basis, used);
  const diagonal = Math.hypot(screen[0], screen[1]);
  if (fit.maxError > diagonal * CALIB_USABLE_ERROR_FRACTION) {
    p.aimBasis = fit.basis;
    p.homography = fit.H;
    logCalibrationReport(p, recentred, screen, false);
    p.homography = null;
    p.aimBasis = { ...DEFAULT_AIM_BASIS };
    p.calibRays = [];
    p.calibQuats = [];
    return {
      ok: false,
      reason: `Aim was inconsistent (off by ${fit.maxError.toFixed(0)}px at target ${worstIndex + 1}) — redo`,
      errorPx: fit.maxError,
      worstIndex,
    };
  }
  const rough = fit.maxError > diagonal * CALIB_GOOD_ERROR_FRACTION;

  p.refInverse = reference;
  p.hasRecentered = true;
  p.aimBasis = fit.basis;
  p.gripLabel = fit.basis.label;
  p.homography = fit.H;
  p.aimBias = [0, 0];
  p.biasShots = 0;
  p.calibrating = false;
  p.filter.reset();
  logCalibrationReport(p, recentred, screen, true);
  return {
    ok: true,
    rough,
    errorPx: fit.maxError,
    worstIndex,
    gripLabel: fit.basis.label,
    model: fit.model,
  };
}

function worstCalibPoint(
  quats: Quat[],
  basis: AimBasis,
  targets: Vec2[],
): number {
  const planes = quats.map((q) => orientationToPlane(q, basis));
  if (planes.some((plane) => !plane)) return 0;
  const cv = crossValidateHomography(planes as Vec2[], targets);
  if (!cv) return 0;
  let worst = 0;
  let worstErr = -1;
  for (let i = 0; i < targets.length; i++) {
    const trainSrc = (planes as Vec2[]).filter((_, j) => j !== i);
    const trainDst = targets.filter((_, j) => j !== i);
    const H = solveHomography(trainSrc, trainDst);
    if (!H) continue;
    const mapped = applyHomography(H, (planes as Vec2[])[i]!);
    const err = Math.hypot(mapped[0] - targets[i]![0], mapped[1] - targets[i]![1]);
    if (err > worstErr) {
      worstErr = err;
      worst = i;
    }
  }
  return worst;
}

export function spawnMovingTarget(
  screen: Vec2,
  id: string,
  round = 1,
): Target {
  const fromLeft = Math.random() < 0.5;
  const difficulty = Math.max(0, round - 1);
  const speedScale = 1 + difficulty * 0.22;
  const sizeScale = Math.max(0.55, 1 - difficulty * 0.07);
  const radius = (18 + Math.random() * 16) * sizeScale;
  const speed = (100 + Math.random() * 170) * speedScale;
  const kinds = ["black", "brown", "blue"] as const;
  const playH = screen[1] * (184 / 240);
  const nearBand = Math.max(0.08, 0.2 - difficulty * 0.015);
  const farBand = Math.min(0.72, 0.55 + difficulty * 0.04);
  return {
    id,
    x: fromLeft ? -radius - 10 : screen[0] + radius + 10,
    y: playH * (nearBand + Math.random() * (farBand - nearBand)),
    radius,
    vx: fromLeft ? speed : -speed,
    vy: 0,
    phase: Math.random() * Math.PI * 2,
    amp: (35 + Math.random() * 75) * (1 + difficulty * 0.04),
    baseY: 0,
    life: 0,
    flash: 0,
    falling: false,
    stationary: false,
    kind: kinds[Math.floor(Math.random() * kinds.length)]!,
  };
}

export function spawnStationaryGrid(screen: Vec2): Target[] {
  const targets: Target[] = [];
  const cols = 4;
  const rows = 3;
  const kinds = ["black", "brown", "blue"] as const;
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      targets.push({
        id: `s${n++}`,
        x: ((c + 1) / (cols + 1)) * screen[0],
        y: ((r + 1) / (rows + 1)) * screen[1] * (184 / 240) * 0.85,
        radius: 24,
        vx: 0,
        vy: 0,
        phase: 0,
        amp: 0,
        baseY: 0,
        life: 0,
        flash: 0,
        falling: false,
        stationary: true,
        kind: kinds[n % kinds.length]!,
      });
    }
  }
  return targets;
}

export function updateTargets(
  targets: Target[],
  screen: Vec2,
  dt: number,
  stationaryMode: boolean,
  nextId: () => string,
  round = 1,
): Target[] {
  const playH = screen[1] * (184 / 240);
  let next = targets
    .map((t) => {
      if (t.flash > 0) {
        const flash = Math.max(0, t.flash - dt * 3.5);
        if (flash <= 0) {
          return {
            ...t,
            flash: 0,
            falling: true,
            vy: 80,
            life: t.life + dt,
          };
        }
        return { ...t, flash, life: t.life + dt };
      }
      if (t.falling) {
        const vy = t.vy + 520 * dt;
        return {
          ...t,
          y: t.y + vy * dt,
          vy,
          vx: t.vx * 0.98,
          x: t.x + t.vx * dt * 0.25,
          life: t.life + dt,
        };
      }
      if (t.stationary) return { ...t, life: t.life + dt };
      if (t.baseY === 0) t.baseY = t.y;
      const life = t.life + dt;
      const bobRate = 2 + Math.max(0, round - 1) * 0.12;
      const y = t.baseY + Math.sin(life * bobRate + t.phase) * t.amp;
      const vy = Math.cos(life * bobRate + t.phase) * t.amp * bobRate;
      return { ...t, x: t.x + t.vx * dt, y, vy, life };
    })
    .filter((t) => {
      if (t.falling) return t.y < playH + 40;
      if (t.flash > 0) return true;
      if (t.stationary) return true;
      return t.x > -80 && t.x < screen[0] + 80;
    });

  if (!stationaryMode) {
    const moving = next.filter(
      (t) => !t.stationary && t.flash <= 0 && !t.falling,
    );
    while (moving.length < 4) {
      const t = spawnMovingTarget(screen, nextId(), round);
      next.push(t);
      moving.push(t);
    }
  } else {
    const alive = next.filter(
      (t) => t.stationary && !t.falling && t.flash <= 0,
    );
    if (alive.length === 0) {
      next = spawnStationaryGrid(screen);
    }
  }

  return next;
}
