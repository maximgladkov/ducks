import {
  DEFAULT_AIM_BASIS,
  DEFAULT_DEBUG_SETTINGS,
  OneEuroFilter2D,
  aimAssistPull,
  applyHomography,
  applyReferenceFrame,
  averageVec2,
  calibrationCorners,
  clampAim,
  colorForPlayer,
  detectAimBasis,
  hitscan,
  hostTimeFromController,
  lerp2,
  orientationToPlane,
  predictOrientationSafe,
  quatConjugate,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  referenceFrameForRecentre,
  relativeAimDelta,
  sampleAgeMs,
  spreadVec2,
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
  gripLabel: string;
  el: HTMLDivElement;
  wedge: HTMLDivElement;
  ghostRaw: HTMLDivElement;
  ghostFilt: HTMLDivElement;
  ghostPred: HTMLDivElement;
};

export function loadSettings(): DebugSettings {
  try {
    const raw = localStorage.getItem("duckhunt.debug.v4");
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
  localStorage.setItem("duckhunt.debug.v4", JSON.stringify(s));
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
    const q0 = applyReferenceFrame(p.lastSample.q, p.refInverse);
    const q1 = applyReferenceFrame(sample.q, p.refInverse);
    const d = relativeAimDelta(q0, q1, settings.sensitivity, p.aimBasis);
    const sx = settings.invertX ? -1 : 1;
    const sy = settings.invertY ? -1 : 1;
    p.relativePos = [
      p.relativePos[0] + d.dx * sx,
      p.relativePos[1] + d.dy * sy,
    ];
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
    if (hitId) {
      return { hitId, miss: false };
    }
    p.missFlash = 1;
    return { hitId: null, miss: true };
  }

  return { hitId: null, miss: false };
}

export function mapOrientationToScreen(
  p: PlayerRuntime,
  sample: ControllerSample,
  settings: DebugSettings,
  screen: Vec2,
  predictMs: number,
): { raw: Vec2; predicted: Vec2 } {
  const age = sampleAgeMs(sample.t, p.clockOffset, performance.now());
  p.sampleAge = age;
  const horizon = settings.predictionEnabled ? (age + predictMs) / 1000 : 0;
  const qBase = applyReferenceFrame(sample.q, p.refInverse);
  const qPredWorld = settings.predictionEnabled
    ? predictOrientationSafe(sample.q, sample.w, horizon)
    : sample.q;
  const qPred = applyReferenceFrame(qPredWorld, p.refInverse);

  if (!settings.absoluteAiming) {
    return {
      raw: [...p.relativePos] as Vec2,
      predicted: [...p.relativePos] as Vec2,
    };
  }

  p.prevQ = qBase;
  const raw = project(qBase, p, screen, settings);
  const predicted = project(qPred, p, screen, settings);
  return { raw, predicted };
}

function project(
  q: Quat,
  p: PlayerRuntime,
  screen: Vec2,
  settings: DebugSettings,
): Vec2 {
  const plane = orientationToPlane(q, p.aimBasis);
  if (!plane) return [...p.aim] as Vec2;
  const clampedPlane: Vec2 = [
    Math.max(-3, Math.min(3, plane[0])),
    Math.max(-3, Math.min(3, plane[1])),
  ];
  let mapped: Vec2;
  if (p.homography) {
    mapped = applyHomography(p.homography, clampedPlane);
  } else {
    const cx = screen[0] / 2;
    const cy = screen[1] / 2;
    const scale = Math.min(screen[0], screen[1]) * 0.55;
    mapped = [cx + clampedPlane[0] * scale, cy + clampedPlane[1] * scale];
  }
  const x = settings.invertX ? screen[0] - mapped[0] : mapped[0];
  const y = settings.invertY ? screen[1] - mapped[1] : mapped[1];
  return [x, y];
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

  if (!p.lastSample) return;

  const mapped = mapOrientationToScreen(
    p,
    p.lastSample,
    settings,
    screen,
    settings.predictionHorizonMs + 1000 / 60,
  );

  let raw = mapped.raw;
  let predicted = mapped.predicted;

  if (p.prevSample && p.lastSample) {
    const t0 = p.prevSample.t;
    const t1 = p.lastSample.t;
    const span = Math.max(1, t1 - t0);
    const hostNow = performance.now();
    const hostOfT0 = hostTimeFromController(t0, p.clockOffset);
    const alpha = Math.min(1, Math.max(0, (hostNow - hostOfT0) / span));
    const mappedPrev = mapOrientationToScreen(
      p,
      p.prevSample,
      settings,
      screen,
      settings.predictionHorizonMs,
    );
    raw = lerp2(mappedPrev.raw, mapped.raw, alpha);
    predicted = lerp2(mappedPrev.predicted, mapped.predicted, alpha);
  }

  p.raw = raw;
  p.predicted = predicted;

  let filtered = settings.filteringEnabled
    ? p.filter.filter(predicted[0], predicted[1], performance.now() / 1000)
    : predicted;
  p.filtered = filtered;

  if (settings.aimAssistEnabled) {
    filtered = aimAssistPull(
      filtered,
      targets.map((t) => ({ x: t.x, y: t.y, radius: t.radius })),
      settings.aimAssistRadius,
    );
  }

  const clamped = clampAim(filtered[0], filtered[1], screen[0], screen[1]);
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

export function sampleCalibQuat(p: PlayerRuntime): Quat | null {
  if (!p.lastSample) return null;
  return applyReferenceFrame(p.lastSample.q, p.refInverse);
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
): void {
  p.calibQuats.push(quat);
  p.calibRays.push(plane);
}

export function finishCalibration(
  p: PlayerRuntime,
  screen: Vec2,
): { ok: boolean; reason?: string; maxError: number; gripLabel?: string } {
  const corners = calibrationCorners(screen[0], screen[1]);
  if (p.calibQuats.length < 4) {
    return { ok: false, reason: "Need 4 corners", maxError: 1 };
  }
  const fit = detectAimBasis(p.calibQuats.slice(0, 4), corners, screen);
  if (!fit) {
    p.calibRays = [];
    p.calibQuats = [];
    return {
      ok: false,
      reason: "Could not detect grip — hold one consistent pose and redo",
      maxError: 1,
    };
  }
  if (fit.maxError > 0.05) {
    p.calibRays = [];
    p.calibQuats = [];
    return {
      ok: false,
      reason: `Bad mapping (${(fit.maxError * 100).toFixed(1)}% error) — redo`,
      maxError: fit.maxError,
    };
  }
  p.aimBasis = fit.basis;
  p.gripLabel = fit.basis.label;
  p.homography = fit.H;
  p.calibrating = false;
  p.filter.reset();
  return {
    ok: true,
    maxError: fit.maxError,
    gripLabel: fit.basis.label,
  };
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
