import {
  AimSession,
  CALIB_FULL_COUNT,
  CALIB_POINT_COUNT,
  CALIB_REFRESH_COUNT,
  DEFAULT_AIM_SETTINGS,
  MUZZLE_CANDIDATES,
  applyHomography,
  applyReferenceFrame,
  averageQuats,
  calibReferencePose,
  calibTargets,
  crossValidateHomography,
  hitscan,
  orientationToPlane,
  pixelsPerDegree,
  quatAngularSpread,
  quatDriftRate,
  referenceFrameForRecentre,
  sliceCalibWindow,
  solveHomography,
  type AimBasis,
  type AimSettings,
  type AimTarget,
  type Quat,
  type StoredAimMapping,
  type Vec2,
} from "gyro-aim";
import {
  colorForPlayer,
  type ControllerEvent,
  type ControllerSample,
  type TransportKind,
} from "@duckhunt/shared";
import { HUD_MAX_SHOTS } from "./hud";
import { diagEvery, diagLog, round, roundAll } from "./diag";
import {
  PLAY_H,
  STAGE_H,
  STAGE_W,
  duckSpeed,
  pickDuckKind,
  type DuckKind,
  type GameMode,
} from "./rules";

export type DebugSettings = AimSettings;
export const DEFAULT_DEBUG_SETTINGS = DEFAULT_AIM_SETTINGS;
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
  escaping: boolean;
  stationary: boolean;
  turnIn: number;
  kind: DuckKind;
  tag?: "titleA" | "titleB";
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
  lastHostReceive: number;
  session: AimSession;
  missFlash: number;
  score: number;
  shots: number;
  flightHits: number;
  awaitingDog: boolean;
  sensorReady: boolean;
  sensorTiltDeg: number;
  el: HTMLDivElement;
  wedge: HTMLDivElement;
  ghostRaw: HTMLDivElement;
  ghostFilt: HTMLDivElement;
  ghostPred: HTMLDivElement;
};

const SETTINGS_KEY = "duckhunt.debug.v8";

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
    lastHostReceive: 0,
    session: new AimSession({ screen: [w, h], settings }),
    missFlash: 0,
    score: 0,
    shots: HUD_MAX_SHOTS,
    flightHits: 0,
    awaitingDog: false,
    sensorReady: false,
    sensorTiltDeg: 0,
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

export function ingestSample(
  p: PlayerRuntime,
  sample: ControllerSample,
  settings: DebugSettings,
): void {
  p.session.setSettings(settings);
  p.session.ingest(sample);
  p.lastHostReceive = performance.now();
  p.packets += 1;
}

function asAimTargets(targets: Target[]): AimTarget[] {
  return targets.map((t) => ({
    id: t.id,
    x: t.x,
    y: t.y,
    radius: t.radius,
  }));
}

export function handlePlayerEvent(
  p: PlayerRuntime,
  event: ControllerEvent,
  settings: DebugSettings,
  screen: Vec2,
  targets: Target[],
  onCalibPoint: (p: PlayerRuntime, seq: number) => void,
): { hitId: string | null; miss: boolean } {
  p.session.setSettings(settings);
  p.session.setScreen(screen);

  if (event.type === "recentre") {
    p.session.recentre();
    return { hitId: null, miss: false };
  }

  if (event.type === "calib_point") {
    onCalibPoint(p, event.seq);
    return { hitId: null, miss: false };
  }

  if (event.type === "trigger_down") {
    if (p.session.calibrating) {
      onCalibPoint(p, p.session.calibRays.length);
      return { hitId: null, miss: false };
    }
    const hittable = targets.filter(
      (t) => t.flash <= 0 && !t.falling && !t.escaping,
    );
    const fired = p.session.aimAt(
      event.t,
      performance.now(),
      asAimTargets(hittable),
    );
    const hitId = hitscan(
      fired,
      hittable.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        radius: t.radius,
      })),
      settings.aimAssistEnabled ? 10 : 4,
    );
    const frameDelta = Math.hypot(
      fired[0] - p.session.aim[0],
      fired[1] - p.session.aim[1],
    );
    diagLog("trigger", {
      id: p.id,
      eventT: event.t,
      aimPx: roundAll(fired, 1),
      frameAimPx: roundAll(p.session.aim, 1),
      deltaPx: round(frameDelta, 1),
      sampleAgeMs: round(p.session.sampleAge, 1),
      horizonMs: round(p.session.horizonMs, 1),
    });
    const next = p.session.learnDrift(asAimTargets(targets));
    if (next) {
      diagLog("bias", {
        id: p.id,
        shots: p.session.biasShots,
        biasDeg: roundAll(
          [
            (Math.atan(p.session.aimBias[0]) * 180) / Math.PI,
            (Math.atan(p.session.aimBias[1]) * 180) / Math.PI,
          ],
          3,
        ),
      });
    }
    p.session.noteShot(fired, asAimTargets(targets), hitId);
    if (hitId) {
      return { hitId, miss: false };
    }
    p.missFlash = 1;
    return { hitId: null, miss: true };
  }

  return { hitId: null, miss: false };
}

export function updatePlayerFrame(
  p: PlayerRuntime,
  settings: DebugSettings,
  screen: Vec2,
  targets: Target[],
  dt: number,
  showGhosts: boolean,
): void {
  p.session.setSettings(settings);
  p.session.setScreen(screen);
  p.session.update(dt, performance.now(), asAimTargets(targets));
  paintAim(p, dt, showGhosts);
}

function paintAim(p: PlayerRuntime, dt: number, showGhosts: boolean): void {
  if (p.missFlash > 0) {
    p.missFlash = Math.max(0, p.missFlash - dt * 4);
  }

  if (p.session.calibrating) {
    p.el.style.display = "none";
    p.wedge.style.display = "none";
    p.ghostRaw.style.display = "none";
    p.ghostFilt.style.display = "none";
    p.ghostPred.style.display = "none";
    return;
  }

  p.el.style.display = "block";
  p.el.style.transform = `translate3d(${p.session.aim[0]}px, ${p.session.aim[1]}px, 0)`;
  if (p.missFlash > 0) {
    p.el.classList.add("flash");
  } else {
    p.el.classList.remove("flash");
  }

  if (p.session.clamped) {
    p.wedge.style.display = "block";
    const ang =
      (Math.atan2(p.session.edge[1], p.session.edge[0]) * 180) / Math.PI + 90;
    p.wedge.style.transform = `translate(9px, -22px) rotate(${ang}deg)`;
  } else {
    p.wedge.style.display = "none";
  }

  const display = showGhosts ? "block" : "none";
  p.ghostRaw.style.display = display;
  p.ghostFilt.style.display = display;
  p.ghostPred.style.display = display;
  p.ghostRaw.style.transform = `translate3d(${p.session.raw[0]}px, ${p.session.raw[1]}px, 0)`;
  p.ghostFilt.style.transform = `translate3d(${p.session.filtered[0]}px, ${p.session.filtered[1]}px, 0)`;
  p.ghostPred.style.transform = `translate3d(${p.session.predicted[0]}px, ${p.session.predicted[1]}px, 0)`;

  if (diagEvery(`aim:${p.id}`, 100)) {
    const sample = p.session.lastSample;
    const plane = p.session.samplePlane();
    diagLog("aim", {
      id: p.id,
      sensorQ: sample ? roundAll(sample.q) : null,
      sensorW: sample ? roundAll(sample.w) : null,
      sampleAgeMs: round(p.session.sampleAge, 1),
      clockOffset: round(p.session.clockOffset, 1),
      plane: plane ? roundAll(plane) : null,
      rawPx: roundAll(p.session.raw, 1),
      filteredPx: roundAll(p.session.filtered, 1),
      predictedPx: roundAll(p.session.predicted, 1),
      horizonMs: round(p.session.horizonMs, 1),
      rateQuality: round(p.session.rateQuality, 3),
    });
  }
  if (diagEvery(`bench:${p.id}`, 500)) {
    const snap = p.session.bench.snapshot();
    diagLog("bench", {
      id: p.id,
      staticRmsPx: snap.staticRmsPx != null ? round(snap.staticRmsPx, 2) : null,
      movingResidualPx:
        snap.movingResidualPx != null ? round(snap.movingResidualPx, 2) : null,
      yawDriftDegPerMin:
        snap.yawDriftDegPerMin != null ? round(snap.yawDriftDegPerMin, 3) : null,
      sampleAgeMs: round(snap.sampleAgeMs, 1),
      horizonMs: round(snap.horizonMs, 1),
      stillLock: p.session.stillLock.locked(),
    });
  }
}

export function beginCalibration(
  p: PlayerRuntime,
  opts: { total?: number; keepMapping?: boolean } = {},
): void {
  p.session.beginCalibration(opts);
}

export function samplePlane(p: PlayerRuntime): Vec2 | null {
  return p.session.samplePlane();
}

export function sampleCalibQuat(p: PlayerRuntime): Quat | null {
  return p.session.sampleCalibQuat();
}

export function recordCalibCorner(
  p: PlayerRuntime,
  quat: Quat,
  plane: Vec2,
  screen: Vec2,
): void {
  p.session.setScreen(screen);
  p.session.recordPoint(quat, plane);
}

export function finishCalibration(
  p: PlayerRuntime,
  screen: Vec2,
): ReturnType<AimSession["finishCalibration"]> {
  p.session.setScreen(screen);
  const needed = p.session.calibTotal;
  const quats = p.session.calibQuats.slice();
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
  const result = p.session.finishCalibration();
  if (posed.length) logCalibrationReport(p, posed, screen, result.ok, quats);
  return result;
}

export function applyStoredCalibration(
  p: PlayerRuntime,
  stored: StoredAimMapping,
): void {
  p.session.applyStoredMapping(stored);
}

export function logCalibrationReport(
  p: PlayerRuntime,
  recentred: Quat[],
  screen: Vec2,
  accepted: boolean,
  rawQuats: Quat[] = recentred,
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

  const chosenPlanes = recentred.map((q) =>
    orientationToPlane(q, p.session.aimBasis),
  );
  diagLog("calib_report", {
    id: p.id,
    accepted,
    screen,
    chosen: p.session.aimBasis.label,
    muzzle: p.session.aimBasis.muzzle,
    homography: p.session.homography
      ? roundAll(p.session.homography, 6)
      : null,
    targets,
    quats: recentred.map((q) => roundAll(q)),
    rawQuats: rawQuats.map((q) => roundAll(q)),
    chosenPlanes: chosenPlanes.map((s) => (s ? roundAll(s) : null)),
    mappedPx: p.session.homography
      ? chosenPlanes.map((s) =>
          s ? roundAll(applyHomography(p.session.homography!, s), 1) : null,
        )
      : null,
    pxPerDegCentre: roundAll(
      pixelsPerDegree(p.session.homography, [0, 0], screen),
      2,
    ),
    candidates,
  });
}

function playHOf(screen: Vec2): number {
  return screen[1] * (PLAY_H / STAGE_H);
}

function blankTarget(
  partial: Partial<Target> & Pick<Target, "id" | "x" | "y" | "kind">,
): Target {
  return {
    radius: 24,
    vx: 0,
    vy: 0,
    phase: 0,
    amp: 0,
    baseY: 0,
    life: 0,
    flash: 0,
    falling: false,
    escaping: false,
    stationary: false,
    turnIn: 0,
    ...partial,
  };
}

function skyFloor(playH: number, pad: number): number {
  return playH * 0.62 - pad * 0.15;
}

export function spawnHuntDuck(
  screen: Vec2,
  id: string,
  round: number,
  mode: GameMode = "A",
): Target {
  const kind = pickDuckKind();
  const playH = playHOf(screen);
  const speed = duckSpeed(round, kind, mode) * (screen[0] / STAGE_W);
  const angle = -Math.PI * (0.28 + Math.random() * 0.44);
  const twitch = kind === "brown" ? 1.5 : kind === "blue" ? 1.1 : 0.75;
  const turnMul = mode === "B" ? 1.7 : 1;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const radius = 22 + Math.random() * 6;
  return blankTarget({
    id,
    x: screen[0] * (0.22 + Math.random() * 0.56),
    y: skyFloor(playH, radius) - 8,
    radius,
    vx: Math.cos(angle) * speed * dir,
    vy: Math.sin(angle) * speed,
    turnIn: ((0.7 + Math.random() * 1.4) / twitch) * turnMul,
    kind,
  });
}

export function spawnTitleDucks(screen: Vec2): Target[] {
  const playH = playHOf(screen);
  const y = playH * 0.42;
  const radius = 28;
  return [
    blankTarget({
      id: "titleA",
      x: screen[0] * 0.32,
      y,
      radius,
      baseY: y,
      amp: 10,
      phase: 0,
      stationary: true,
      kind: "black",
      tag: "titleA",
    }),
    blankTarget({
      id: "titleB",
      x: screen[0] * 0.68,
      y,
      radius,
      baseY: y,
      amp: 10,
      phase: Math.PI,
      stationary: true,
      kind: "blue",
      tag: "titleB",
    }),
  ];
}

export function spawnStationaryGrid(screen: Vec2): Target[] {
  const targets: Target[] = [];
  const cols = 4;
  const rows = 3;
  const kinds: DuckKind[] = ["black", "brown", "blue"];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      targets.push(
        blankTarget({
          id: `s${n}`,
          x: ((c + 1) / (cols + 1)) * screen[0],
          y: ((r + 1) / (rows + 1)) * playHOf(screen) * 0.85,
          radius: 24,
          stationary: true,
          kind: kinds[n % kinds.length]!,
        }),
      );
      n += 1;
    }
  }
  return targets;
}

export function markEscaping(targets: Target[]): Target[] {
  return targets.map((t) => {
    if (t.flash > 0 || t.falling || t.stationary || t.escaping) return t;
    const speed = Math.max(160, Math.hypot(t.vx, t.vy) * 1.25);
    return { ...t, escaping: true, vy: -speed, vx: t.vx * 0.25 };
  });
}

export function duckCounts(targets: Target[]): {
  flying: number;
  flashing: number;
  falling: number;
  escaping: number;
} {
  let flying = 0;
  let flashing = 0;
  let falling = 0;
  let escaping = 0;
  for (const t of targets) {
    if (t.tag) continue;
    if (t.flash > 0) flashing += 1;
    else if (t.falling) falling += 1;
    else if (t.escaping) escaping += 1;
    else if (!t.stationary) flying += 1;
  }
  return { flying, flashing, falling, escaping };
}

export function stepTargets(
  targets: Target[],
  screen: Vec2,
  dt: number,
  mode: GameMode = "A",
): { next: Target[]; escaped: Target[]; landed: Target[] } {
  const playH = playHOf(screen);
  const escaped: Target[] = [];
  const landed: Target[] = [];
  const next: Target[] = [];
  for (const src of targets) {
    const t = { ...src, life: src.life + dt };
    if (t.flash > 0) {
      t.flash = Math.max(0, t.flash - dt * 3.5);
      if (t.flash <= 0) {
        t.falling = true;
        t.vy = 80;
      }
      next.push(t);
      continue;
    }
    if (t.falling) {
      t.vy += 520 * dt;
      t.y += t.vy * dt;
      t.vx *= 0.98;
      t.x += t.vx * dt * 0.25;
      if (t.y < playH + 40) next.push(t);
      else landed.push(t);
      continue;
    }
    if (t.escaping) {
      t.y += t.vy * dt;
      t.x += t.vx * dt;
      if (t.y > -80) next.push(t);
      else escaped.push(t);
      continue;
    }
    if (t.stationary) {
      if (t.amp > 0) {
        const y = (t.baseY || t.y) + Math.sin(t.life * 2.2 + t.phase) * t.amp;
        t.y = y;
        t.vy = Math.cos(t.life * 2.2 + t.phase) * t.amp * 2.2;
      }
      next.push(t);
      continue;
    }
    t.turnIn -= dt;
    if (t.turnIn <= 0) {
      const speed =
        Math.hypot(t.vx, t.vy) ||
        duckSpeed(1, t.kind, mode) * (screen[0] / STAGE_W);
      const twitch = t.kind === "brown" ? 1.5 : t.kind === "blue" ? 1.1 : 0.75;
      const turnMul = mode === "B" ? 1.7 : 1;
      const spread = mode === "B" ? 0.7 : 1.05;
      const heading =
        Math.atan2(t.vy, t.vx) + (Math.random() - 0.5) * Math.PI * spread;
      t.vx = Math.cos(heading) * speed;
      t.vy = Math.sin(heading) * speed;
      t.turnIn = ((0.7 + Math.random() * 1.4) / twitch) * turnMul;
    }
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    const pad = t.radius;
    if (t.x < pad) {
      t.x = pad;
      t.vx = Math.abs(t.vx);
    } else if (t.x > screen[0] - pad) {
      t.x = screen[0] - pad;
      t.vx = -Math.abs(t.vx);
    }
    const floor = skyFloor(playH, pad);
    if (t.y < pad) {
      t.y = pad;
      t.vy = Math.abs(t.vy);
    } else if (t.y > floor) {
      t.y = floor;
      t.vy = -Math.abs(t.vy);
    }
    next.push(t);
  }
  return { next, escaped, landed };
}
