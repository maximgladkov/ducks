import QRCode from "qrcode";
import {
  averageVec2,
  type DebugSettings,
  type SignallingMessage,
  type Vec2,
} from "@duckhunt/shared";
import {
  beginCalibration,
  calibTargets,
  CALIB_POINT_COUNT,
  CALIB_FULL_COUNT,
  CALIB_REFRESH_COUNT,
  applyStoredCalibration,
  createPlayer,
  finishCalibration,
  handlePlayerEvent,
  ingestSample,
  loadSettings,
  averageQuats,
  quatAngularSpread,
  quatDriftRate,
  sliceCalibWindow,
  recordCalibCorner,
  removePlayer,
  sampleCalibQuat,
  samplePlane,
  saveSettings,
  spawnStationaryGrid,
  updatePlayerFrame,
  updateTargets,
  type PlayerRuntime,
  type Target,
} from "./game";
import { loadStoredCalib, saveStoredCalib } from "./calibStore";
import {
  HostPeer,
  connectSignalling,
  defaultSignallingUrl,
} from "./transport";
import { sfx } from "./audio";
import {
  createHudState,
  HUD_MAX_SHOTS,
  HUD_POINTS_PER_HIT,
  registerHudHit,
} from "./hud";
import { renderHudDom } from "./hudDom";
import {
  createSkyClouds,
  drawSkyClouds,
  setCloudScreen,
  updateSkyClouds,
} from "./clouds";
import { loadSpriteBank, duckFrame, type SpriteBank } from "./sprites";
import {
  drawDog,
  drawMeadowBack,
  drawMeadowFg,
  playfieldHeight,
} from "./scene";
import { diagLog, diagStart, roundAll } from "./diag";

let sprites: SpriteBank | null = null;
let dogShow: { mode: "laugh" | "got"; t: number; playerId: string } | null =
  null;
const hud = createHudState();
const skyClouds = createSkyClouds(8);
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const crossLayer = document.getElementById("crosshairs")!;
const qrCanvas = document.getElementById("qr") as HTMLCanvasElement;
const joinUrlEl = document.getElementById("join-url")!;
const playersEl = document.getElementById("players")!;
const calibOverlay = document.getElementById("calib-overlay")!;
const calibSpotlight = document.getElementById("calib-spotlight")!;
const calibDot = document.getElementById("calib-dot")!;
const calibCard = document.getElementById("calib-card")!;
const calibCount = document.getElementById("calib-count")!;
const calibPips = document.getElementById("calib-pips")!;
const calibStatus = document.getElementById("calib-status")!;
const calibResult = document.getElementById("calib-result")!;
const debugEl = document.getElementById("debug")!;
const toggleDebug = document.getElementById("toggle-debug")!;

for (let i = 0; i < CALIB_FULL_COUNT; i++) {
  const pip = document.createElement("div");
  pip.className = "calib-pip";
  calibPips.appendChild(pip);
}

let settings = loadSettings();
diagStart({
  userAgent: navigator.userAgent,
  screen: [window.innerWidth, window.innerHeight],
  devicePixelRatio: window.devicePixelRatio,
  settings,
});
const players = new Map<string, PlayerRuntime>();
const peers = new Map<string, HostPeer>();
let targets: Target[] = [];
let stationaryMode = false;
let targetSeq = 0;
let sessionId = "";
let joinUrl = "";
let lastFrame = performance.now();
let fps = 0;
let frameTime = 0;
let debugOpen = false;
let calibratingPlayerId: string | null = null;
let calibSeq = 0;
let calibCapture: {
  playerId: string;
  samples: Vec2[];
  quats: import("@duckhunt/shared").Quat[];
  times: number[];
  startedAt: number;
} | null = null;
const CALIB_SETTLE_MS = 150;
const CALIB_STABLE_MS = 550;
const CALIB_MIN_HOLD_MS = 400;
const CALIB_RELEASE_TRIM_MS = 80;
const CALIB_MIN_SAMPLES = 12;
const CALIB_MAX_ANGLE_SPREAD = 0.06;
/**
 * A settled estimate drifts well under a degree per second, while one still
 * walking out a bad seed slides an order of magnitude faster.
 */
const CALIB_MAX_DRIFT_DEG_PER_SEC = 3;
const SENSOR_SETTLE_TIMEOUT_MS = 10000;
let lagFlashAt: number | null = null;

function startLagFlash(): void {
  const el = document.getElementById("lag-flash");
  setCalibResult("Pull the trigger when the screen flashes");
  window.setTimeout(() => {
    lagFlashAt = performance.now();
    el?.classList.remove("hidden");
    window.setTimeout(() => el?.classList.add("hidden"), 70);
  }, 700 + Math.random() * 800);
}

function finishLagFlash(hostNow: number): void {
  if (lagFlashAt === null) return;
  const delay = hostNow - lagFlashAt;
  lagFlashAt = null;
  const lag = Math.max(0, Math.min(120, delay - 180));
  settings.displayLagMs = Math.round(lag);
  saveSettings(settings);
  const input = document.getElementById("displayLagMs") as HTMLInputElement | null;
  const label = document.getElementById("v-displayLagMs");
  if (input) input.value = String(settings.displayLagMs);
  if (label) label.textContent = String(settings.displayLagMs);
  setCalibResult(`Display lag set to ${settings.displayLagMs} ms`);
  window.setTimeout(() => setCalibResult(null), 4000);
}

function screenSize(): [number, number] {
  return [canvas.clientWidth, canvas.clientHeight];
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setCloudScreen(window.innerWidth, window.innerHeight);
  if (calibratingPlayerId !== null && !calibDot.classList.contains("hidden")) {
    showCalibCorner(calibSeq);
  }
}
window.addEventListener("resize", resize);
resize();

function nextTargetId(): string {
  return `t${targetSeq++}`;
}

function renderScoreboard(): void {
  /* score drawn into NES HUD bar on canvas */
}

function draw(): void {
  if (!sprites) {
    ctx.fillStyle = "#3CBCFC";
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    return;
  }
  const [w, h] = screenSize();
  ctx.imageSmoothingEnabled = false;
  drawMeadowBack(ctx, sprites, w, h);
  drawSkyClouds(ctx, sprites, skyClouds);

  for (const t of targets) {
    const frame = duckFrame(sprites, t.kind, {
      vx: t.vx,
      vy: t.vy,
      life: t.life,
      flash: t.flash,
      falling: t.falling,
    });
    const scale = (t.radius * 2.6) / 34;
    const dw = frame.width * scale;
    const dh = frame.height * scale;
    ctx.save();
    ctx.translate(t.x, t.y);
    if (!t.falling && t.flash <= 0 && t.vx < 0) ctx.scale(-1, 1);
    ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  drawMeadowFg(ctx, sprites, w, h);

  const playH = playfieldHeight(h);
  ctx.fillStyle = "#6B6B00";
  ctx.fillRect(0, playH, w, h - playH);

  if (dogShow) {
    drawDog(ctx, sprites, w, h, dogShow.mode, dogShow.t);
  }

  renderHudDom(hud, [...players.values()]);
}

function renderPlayers(): void {
  playersEl.innerHTML = [...players.values()]
    .map(
      (p) =>
        `<div style="color:${p.color}">● ${p.index + 1}P · ${p.transport} · ${p.shots}/${HUD_MAX_SHOTS} · ${String(p.score).padStart(6, "0")}</div>`,
    )
    .join("");
}

function setCalibStatus(text: string | null): void {
  calibStatus.textContent = text ?? "";
}

function setCalibResult(text: string | null): void {
  if (!text) {
    calibResult.classList.add("hidden");
    calibResult.textContent = "";
    return;
  }
  calibResult.classList.remove("hidden");
  calibResult.textContent = text;
}

function showCalibOverlay(): void {
  calibOverlay.classList.remove("hidden");
  calibDot.classList.add("hidden");
  calibCard.classList.remove("dodge");
  calibCount.textContent = "";
  for (const pip of calibPips.children) {
    pip.classList.remove("on", "done");
  }
}

function hideCalibOverlay(): void {
  calibOverlay.classList.add("hidden");
  calibDot.classList.add("hidden");
  setCalibStatus(null);
}

function updateCalibPips(seq: number, total: number): void {
  [...calibPips.children].forEach((pip, i) => {
    (pip as HTMLElement).style.display = i < total ? "" : "none";
    pip.classList.toggle("done", i < seq);
    pip.classList.toggle("on", i === seq && i < total);
  });
}

function updateCalibDodge(x: number, y: number): void {
  calibCard.classList.remove("dodge");
  const rect = calibCard.getBoundingClientRect();
  const pad = 80;
  const inside =
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad;
  calibCard.classList.toggle("dodge", inside);
}

function showCalibCorner(seq: number): void {
  const p = calibratingPlayerId ? players.get(calibratingPlayerId) : undefined;
  const total = p?.calibTotal ?? CALIB_POINT_COUNT;
  const c = calibTargets(screenSize())[seq];
  if (!c) return;
  calibSeq = seq;
  calibOverlay.classList.remove("hidden");
  calibSpotlight.style.setProperty("--calib-x", `${c[0]}px`);
  calibSpotlight.style.setProperty("--calib-y", `${c[1]}px`);
  calibDot.style.left = `${c[0]}px`;
  calibDot.style.top = `${c[1]}px`;
  calibDot.classList.remove("hidden");
  calibCount.textContent = `TARGET ${seq + 1} / ${total}`;
  updateCalibPips(seq, total);
  updateCalibDodge(c[0], c[1]);
  setCalibStatus("Aim at the glowing dot, then hold FIRE still until it locks");
}

function hideCalibCorner(): void {
  hideCalibOverlay();
}

function sendAmmo(playerId: string): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  peer.send({ type: "ammo", shots: p.shots });
}

function startDogForPlayer(p: PlayerRuntime): void {
  if (dogShow) {
    p.awaitingDog = true;
    return;
  }
  p.awaitingDog = false;
  const mode = p.flightHits > 0 ? "got" : "laugh";
  dogShow = { mode, t: 0, playerId: p.id };
  if (mode === "got") sfx.got();
  else sfx.laugh();
  p.flightHits = 0;
}

function maybeStartNextDog(): void {
  if (dogShow) return;
  for (const p of players.values()) {
    if (p.awaitingDog) {
      startDogForPlayer(p);
      return;
    }
  }
}

function refillPlayerShots(playerId: string): void {
  const p = players.get(playerId);
  if (!p) return;
  p.shots = HUD_MAX_SHOTS;
  p.awaitingDog = false;
  p.flightHits = 0;
  sendAmmo(playerId);
}

/**
 * Calibrating before the phone's attitude estimate has settled bakes the tail of
 * that transient into the reference pose and the first few captures, which is
 * unrecoverable: every later target is measured against a frame that was still
 * moving.
 */
function waitForSensors(playerId: string, since: number): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  const waited = performance.now() - since;
  if (p.sensorReady || waited > SENSOR_SETTLE_TIMEOUT_MS) {
    diagLog("sensors_ready", {
      id: playerId,
      waitedMs: Math.round(waited),
      converged: p.sensorReady,
      tiltDeg: Number(p.sensorTiltDeg.toFixed(2)),
    });
    const stored = loadStoredCalib(screenSize());
    if (stored) {
      applyStoredCalibration(p, stored);
      setCalibResult(
        `Restored aim · ${stored.label} · ±${stored.maxError.toFixed(0)}px — 4-point refresh`,
      );
      startCalibration(playerId, {
        total: CALIB_REFRESH_COUNT,
        keepMapping: true,
      });
      return;
    }
    startCalibration(playerId);
    return;
  }
  showCalibOverlay();
  setCalibStatus("Hold the phone steady in your aiming grip — sensors settling…");
  peer.send({
    type: "status",
    text: "Hold steady in your aiming grip — settling sensors",
  });
  window.setTimeout(() => waitForSensors(playerId, since), 250);
}

function startCalibration(
  playerId: string,
  opts: { total?: number; keepMapping?: boolean } = {},
): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  calibratingPlayerId = playerId;
  calibCapture = null;
  setCalibResult(null);
  beginCalibration(p, opts);
  const total = p.calibTotal;
  diagLog("calib_start", {
    id: playerId,
    screen: screenSize(),
    targets: calibTargets(screenSize()).slice(0, total),
    refInverse: roundAll(p.refInverse),
    refresh: total < CALIB_POINT_COUNT,
  });
  showCalibCorner(0);
  peer.send({
    type: "status",
    text: `Keep that grip for all ${total} targets — hold FIRE on each until it locks`,
  });
  peer.send({
    type: "calib_prompt",
    seq: 0,
    total,
    corner: calibTargets(screenSize())[0]!,
  });
}

function startCalibCapture(p: PlayerRuntime): void {
  calibCapture = {
    playerId: p.id,
    samples: [],
    quats: [],
    times: [],
    startedAt: performance.now(),
  };
  setCalibStatus("Hold still until it locks…");
  const peer = peers.get(p.id);
  peer?.send({ type: "status", text: "Hold still until it locks" });
}

function calibHoldWindow(
  now: number,
  kind: "auto" | "release",
): { quats: import("@duckhunt/shared").Quat[]; planes: Vec2[]; durationMs: number } | null {
  if (!calibCapture) return null;
  const settleFrom = calibCapture.startedAt + CALIB_SETTLE_MS;
  const to = kind === "release" ? now - CALIB_RELEASE_TRIM_MS : now;
  if (to <= settleFrom) return null;
  const trailingFrom = Math.max(settleFrom, to - CALIB_STABLE_MS);
  const trailing = sliceCalibWindow(
    calibCapture.quats,
    calibCapture.samples,
    calibCapture.times,
    trailingFrom,
    to,
  );
  if (
    trailing &&
    trailing.durationMs >= Math.min(CALIB_STABLE_MS, to - settleFrom) * 0.85 &&
    trailing.quats.length >= CALIB_MIN_SAMPLES
  ) {
    return trailing;
  }
  return sliceCalibWindow(
    calibCapture.quats,
    calibCapture.samples,
    calibCapture.times,
    settleFrom,
    to,
  );
}

function completeCalibCapture(
  p: PlayerRuntime,
  now: number,
  kind: "auto" | "release",
): boolean {
  const peer = peers.get(p.id);
  if (!peer || !calibCapture || calibCapture.playerId !== p.id) return false;
  const held = calibHoldWindow(now, kind);
  const minMs = kind === "auto" ? CALIB_STABLE_MS * 0.9 : CALIB_MIN_HOLD_MS;
  if (
    !held ||
    held.durationMs < minMs ||
    held.quats.length < CALIB_MIN_SAMPLES
  ) {
    if (kind === "auto") return false;
    calibCapture = null;
    peer.send({
      type: "status",
      text: "Hold longer — keep FIRE down until the target locks",
    });
    setCalibStatus("Hold FIRE longer on this target, then release");
    return false;
  }
  const quats = held.quats;
  const samples = held.planes;
  const angleSpread = quatAngularSpread(quats);
  if (angleSpread > CALIB_MAX_ANGLE_SPREAD) {
    if (kind === "auto") return false;
    calibCapture = null;
    peer.send({
      type: "status",
      text: `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — hold still and retry`,
    });
    setCalibStatus(
      `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — hold still and retry`,
    );
    return false;
  }
  const driftRate = quatDriftRate(quats, held.durationMs / 1000);
  if (driftRate > CALIB_MAX_DRIFT_DEG_PER_SEC) {
    if (kind === "auto") return false;
    calibCapture = null;
    diagLog("calib_reject", {
      id: p.id,
      index: p.calibQuats.length,
      driftDegPerSec: Number(driftRate.toFixed(2)),
      spreadDeg: Number(((angleSpread * 180) / Math.PI).toFixed(2)),
    });
    peer.send({
      type: "status",
      text: `Sensors still settling (${driftRate.toFixed(1)}°/s) — hold steady and retry`,
    });
    setCalibStatus(
      `Sensors still settling (${driftRate.toFixed(1)}°/s drift) — hold steady and retry this target`,
    );
    return false;
  }
  calibCapture = null;
  const meanPlane = averageVec2(samples);
  const meanQuat = averageQuats(quats);
  if (!meanQuat) {
    peer.send({ type: "status", text: "Bad sample — try again" });
    return true;
  }
  recordCalibCorner(p, meanQuat, meanPlane ?? [0, 0], screenSize());
  const n = p.calibQuats.length;
  diagLog("calib_capture", {
    id: p.id,
    index: n - 1,
    target: calibTargets(screenSize())[n - 1] ?? null,
    quat: roundAll(meanQuat),
    plane: meanPlane ? roundAll(meanPlane) : null,
    spreadDeg: Number(((angleSpread * 180) / Math.PI).toFixed(2)),
    samples: quats.length,
    holdMs: Math.round(held.durationMs),
    kind,
    aimPx: roundAll(p.aim, 1),
  });
  peer.send({
    type: "status",
    text: `Target ${n}/${p.calibTotal} locked (${((angleSpread * 180) / Math.PI).toFixed(1)}°)`,
  });
  if (n < p.calibTotal) {
    showCalibCorner(n);
    peer.send({
      type: "calib_prompt",
      seq: n,
      total: p.calibTotal,
      corner: calibTargets(screenSize())[n]!,
    });
    return true;
  }
  const result = finishCalibration(p, screenSize());
  diagLog("calib_result", { id: p.id, ...result });
  hideCalibCorner();
  calibratingPlayerId = null;
  if (result.ok && p.homography) {
    saveStoredCalib({
      screen: screenSize(),
      H: p.homography,
      muzzle: p.aimBasis.muzzle,
      label: p.aimBasis.label,
      model: result.model ?? "affine",
      maxError: result.errorPx,
      meanError: result.meanError ?? result.errorPx,
    });
  }
  const quality = result.rough ? "rough — redo for tighter aim" : "OK";
  const summary = result.ok
    ? `${quality} · ${result.gripLabel} · accuracy ±${result.errorPx.toFixed(0)}px`
    : result.reason;
  peer.send({ type: "calib_done", ok: result.ok, reason: summary });
  peer.send({ type: "ammo", shots: p.shots });
  setCalibResult(
    result.ok
      ? `Calibration ${quality} · grip: ${result.gripLabel} · held-out accuracy ±${result.errorPx.toFixed(0)}px`
      : result.reason ?? "Calibration failed",
  );
  window.setTimeout(() => setCalibResult(null), 5000);
  return true;
}

function onCalibPoint(p: PlayerRuntime, _seq: number): void {
  if (!p.calibrating) return;
  if (calibCapture) return;
  startCalibCapture(p);
}

function onCalibHoldEnd(p: PlayerRuntime): void {
  if (!p.calibrating) return;
  if (!calibCapture || calibCapture.playerId !== p.id) return;
  completeCalibCapture(p, performance.now(), "release");
}

function buildDebugHud(): void {
  debugEl.innerHTML = `
    <h2>Debug HUD</h2>
    <div id="dbg-stats"></div>
    <label>minCutoff Hz (hold steadiness) <span id="v-minCutoff"></span>
      <input id="minCutoff" type="range" min="0.2" max="8" step="0.1" />
    </label>
    <label>beta Hz per deg/s (flick responsiveness) <span id="v-beta"></span>
      <input id="beta" type="range" min="0" max="0.3" step="0.005" />
    </label>
    <label>display lag ms <span id="v-displayLagMs"></span>
      <input id="displayLagMs" type="range" min="0" max="120" step="1" />
    </label>
    <label>prediction extra ms <span id="v-predictionHorizonMs"></span>
      <input id="predictionHorizonMs" type="range" min="0" max="80" step="1" />
    </label>
    <label>filter lead (lag cancellation) <span id="v-filterLeadGain"></span>
      <input id="filterLeadGain" type="range" min="0" max="1.5" step="0.05" />
    </label>
    <label>aim assist radius <span id="v-aimAssistRadius"></span>
      <input id="aimAssistRadius" type="range" min="0" max="220" step="1" />
    </label>
    <label>sensitivity <span id="v-sensitivity"></span>
      <input id="sensitivity" type="range" min="100" max="2000" step="10" />
    </label>
    <label><input id="predictionEnabled" type="checkbox" /> prediction</label>
    <label><input id="filteringEnabled" type="checkbox" /> filtering</label>
    <label><input id="aimAssistEnabled" type="checkbox" /> aim assist</label>
    <label><input id="absoluteAiming" type="checkbox" /> absolute aiming (vs gyro mouse)</label>
    <label><input id="driftLearningEnabled" type="checkbox" /> learn drift from shots</label>
    <label><input id="stillLockEnabled" type="checkbox" /> still-lock when holding</label>
    <label><input id="invertX" type="checkbox" /> invert X</label>
    <label><input id="invertY" type="checkbox" /> invert Y</label>
    <label><input id="stationaryMode" type="checkbox" /> stationary target mode</label>
    <div class="row">
      <button type="button" id="recalibrate">Recalibrate (4 corners)</button>
      <button type="button" id="refresh-aim">Refresh 4 corners</button>
      <button type="button" id="full-calib">9-point (thorough)</button>
    </div>
    <div class="row">
      <button type="button" id="lag-late">Aim feels late</button>
      <button type="button" id="lag-early">Aim feels early</button>
      <button type="button" id="lag-flash">Flash lag test</button>
    </div>
  `;

  const bindRange = (key: keyof DebugSettings) => {
    const input = document.getElementById(key) as HTMLInputElement;
    const label = document.getElementById(`v-${key}`)!;
    input.value = String(settings[key]);
    label.textContent = String(settings[key]);
    input.oninput = () => {
      const n = Number(input.value);
      (settings as Record<string, number | boolean>)[key] = n;
      label.textContent = String(n);
      saveSettings(settings);
    };
  };

  bindRange("minCutoff");
  bindRange("beta");
  bindRange("displayLagMs");
  bindRange("predictionHorizonMs");
  bindRange("filterLeadGain");
  bindRange("aimAssistRadius");
  bindRange("sensitivity");

  const bindCheck = (key: keyof DebugSettings) => {
    const input = document.getElementById(key) as HTMLInputElement;
    input.checked = Boolean(settings[key]);
    input.onchange = () => {
      (settings as Record<string, number | boolean>)[key] = input.checked;
      saveSettings(settings);
    };
  };
  bindCheck("predictionEnabled");
  bindCheck("filteringEnabled");
  bindCheck("aimAssistEnabled");
  bindCheck("absoluteAiming");
  bindCheck("driftLearningEnabled");
  bindCheck("stillLockEnabled");
  bindCheck("invertX");
  bindCheck("invertY");

  const stationary = document.getElementById("stationaryMode") as HTMLInputElement;
  stationary.checked = stationaryMode;
  stationary.onchange = () => {
    stationaryMode = stationary.checked;
    targets = stationaryMode ? spawnStationaryGrid(screenSize()) : [];
  };

  document.getElementById("recalibrate")!.onclick = () => {
    const id = calibratingPlayerId ?? [...players.keys()][0];
    if (id) startCalibration(id);
  };
  document.getElementById("refresh-aim")!.onclick = () => {
    const id = calibratingPlayerId ?? [...players.keys()][0];
    if (id) {
      startCalibration(id, { total: CALIB_REFRESH_COUNT, keepMapping: true });
    }
  };
  document.getElementById("full-calib")!.onclick = () => {
    const id = calibratingPlayerId ?? [...players.keys()][0];
    if (id) startCalibration(id, { total: CALIB_FULL_COUNT });
  };
  document.getElementById("lag-late")!.onclick = () => {
    settings.displayLagMs = Math.min(120, settings.displayLagMs + 8);
    saveSettings(settings);
    const input = document.getElementById("displayLagMs") as HTMLInputElement | null;
    const label = document.getElementById("v-displayLagMs");
    if (input) input.value = String(settings.displayLagMs);
    if (label) label.textContent = String(settings.displayLagMs);
  };
  document.getElementById("lag-early")!.onclick = () => {
    settings.displayLagMs = Math.max(0, settings.displayLagMs - 8);
    saveSettings(settings);
    const input = document.getElementById("displayLagMs") as HTMLInputElement | null;
    const label = document.getElementById("v-displayLagMs");
    if (input) input.value = String(settings.displayLagMs);
    if (label) label.textContent = String(settings.displayLagMs);
  };
  document.getElementById("lag-flash")!.onclick = () => startLagFlash();
}

toggleDebug.onclick = () => {
  debugOpen = !debugOpen;
  debugEl.classList.toggle("hidden", !debugOpen);
  if (debugOpen) buildDebugHud();
};

function updateDebugStats(): void {
  const el = document.getElementById("dbg-stats");
  if (!el) return;
  const lines = [...players.values()].map((p) => {
    const peer = peers.get(p.id);
    const rate = p.packets;
    const plane = samplePlane(p);
    const planeStr = plane
      ? `plane=(${plane[0].toFixed(3)},${plane[1].toFixed(3)})`
      : "plane=—";
    const w = p.lastSample?.w;
    const rateDeg = w
      ? ((Math.hypot(w[0], w[1], w[2]) * 180) / Math.PI).toFixed(1)
      : "—";
    const lock = p.stillLock.locked() ? "on" : "off";
    return `P${p.index + 1} ${p.transport} rtt=${p.rtt.toFixed(1)}ms off=${p.clockOffset.toFixed(1)} age=${p.sampleAge.toFixed(1)}ms hor=${p.horizonMs.toFixed(0)}ms nq=${p.rateQuality.toFixed(2)} ω=${rateDeg}°/s lock=${lock} pkts=${rate} drop~${peer?.dropped ?? 0} ${planeStr}`;
  });
  let calibLine = "";
  if (calibratingPlayerId) {
    const p = players.get(calibratingPlayerId);
    const seq = p?.calibRays.length ?? 0;
    const targets = calibTargets(screenSize());
    const target = targets[Math.min(seq, targets.length - 1)]!;
    if (p) {
      const err = Math.hypot(p.aim[0] - target[0], p.aim[1] - target[1]);
      calibLine = `<div>calib target ${seq + 1}/${p.calibTotal} · crosshair error ${err.toFixed(0)}px · capture ${calibCapture?.samples.length ?? 0}</div>`;
    }
  } else {
    const p0 = [...players.values()][0];
    if (p0?.homography) {
      const bench = p0.bench.snapshot();
      const jitter =
        bench.staticRmsPx != null ? `jitter ${bench.staticRmsPx.toFixed(1)}px` : "";
      const move =
        bench.movingResidualPx != null
          ? `path ${bench.movingResidualPx.toFixed(1)}px`
          : "";
      const drift =
        bench.yawDriftDegPerMin != null
          ? `drift ${bench.yawDriftDegPerMin.toFixed(2)}°/min`
          : "";
      const warn = p0.needsRecal ? " · recalibrate" : "";
      calibLine = `<div>grip: ${p0.gripLabel} · lag ${settings.displayLagMs}ms ${jitter} ${move} ${drift}${warn}</div>`;
    }
  }
  el.innerHTML = `<div>FPS ${fps.toFixed(0)} · frame ${frameTime.toFixed(1)}ms</div>${lines.map((l) => `<div>${l}</div>`).join("")}${calibLine}<div>ghosts: raw / filtered / predicted</div>`;
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  frameTime = now - lastFrame;
  fps = fps * 0.9 + (1000 / Math.max(1, frameTime)) * 0.1;
  lastFrame = now;
  if (dogShow) {
    dogShow = { ...dogShow, t: dogShow.t + dt };
    if (dogShow.t > 1.6) {
      const finishedId = dogShow.playerId;
      dogShow = null;
      refillPlayerShots(finishedId);
      maybeStartNextDog();
    }
  }

  updateSkyClouds(skyClouds, dt);

  if (calibCapture) {
    const p = players.get(calibCapture.playerId);
    if (p) {
      const plane = samplePlane(p);
      const quat = sampleCalibQuat(p);
      if (plane && quat) {
        calibCapture.samples.push(plane);
        calibCapture.quats.push(quat);
        calibCapture.times.push(now);
      }
      if (!completeCalibCapture(p, now, "auto") && calibCapture) {
        const held = now - calibCapture.startedAt;
        const progress = Math.max(
          0,
          Math.min(1, (held - CALIB_SETTLE_MS) / CALIB_STABLE_MS),
        );
        setCalibStatus(
          progress >= 1
            ? "Keep holding still — waiting for a steady window"
            : `Hold still until it locks… ${Math.round(progress * 100)}%`,
        );
      }
    }
  }

  targets = updateTargets(
    targets,
    screenSize(),
    dt,
    stationaryMode,
    nextTargetId,
    hud.round,
  );

  for (const p of players.values()) {
    updatePlayerFrame(p, settings, screenSize(), targets, dt, debugOpen);
    if (p.needsRecal && !p.calibrating && calibratingPlayerId === null) {
      setCalibResult("Aim drifted — recalibrate (DBG → Recalibrate)");
    }
  }

  draw();
  renderScoreboard();
  if (debugOpen) updateDebugStats();
  requestAnimationFrame(frame);
}

function addPlayer(playerId: string): void {
  if (players.has(playerId)) return;
  const index = players.size;
  const p = createPlayer(playerId, index, crossLayer, settings);
  players.set(playerId, p);

  const peer = new HostPeer(playerId, send, {
    onSample: ({ sample }) => ingestSample(p, sample, settings),
    onDiag: ({ diag }) => {
      p.sensorReady = diag.converged;
      p.sensorTiltDeg = diag.tiltResidualDeg;
      diagLog("controller", { id: playerId, ...diag });
    },
    onEvent: ({ event }) => {
      diagLog("input", {
        id: playerId,
        event: event.type,
        seq: event.seq,
        calibrating: p.calibrating,
        aimPx: roundAll(p.aim, 1),
      });
      if (event.type === "trigger_down" && lagFlashAt !== null) {
        finishLagFlash(performance.now());
        return;
      }
      if (p.calibrating) {
        handlePlayerEvent(
          p,
          event,
          settings,
          screenSize(),
          targets,
          onCalibPoint,
        );
        if (event.type === "trigger_up") onCalibHoldEnd(p);
        return;
      }

      if (event.type === "trigger_down" && p.shots <= 0) {
        return;
      }

      const result = handlePlayerEvent(
        p,
        event,
        settings,
        screenSize(),
        targets,
        onCalibPoint,
      );

      if (event.type !== "trigger_down") return;

      p.shots = Math.max(0, p.shots - 1);
      sendAmmo(p.id);

      if (result.hitId) {
        const hitId = result.hitId;
        registerHudHit(hud);
        p.flightHits += 1;
        p.score += HUD_POINTS_PER_HIT;
        sfx.duckHit();
        targets = targets.map((t) =>
          t.id === hitId ? { ...t, flash: 1, vx: t.vx * 0.2 } : t,
        );
      }

      if (p.shots <= 0) {
        startDogForPlayer(p);
      }
      renderPlayers();
      renderScoreboard();
    },
    onTransport: (kind) => {
      p.transport = kind;
      renderPlayers();
    },
    onClock: (offset, rtt) => {
      p.clockOffset = offset;
      p.rtt = rtt;
    },
  });
  peers.set(playerId, peer);
  void peer.startOffer().then(() => {
    waitForSensors(playerId, performance.now());
  });
  renderPlayers();
  renderScoreboard();
}

function removePlayerId(playerId: string): void {
  const p = players.get(playerId);
  if (p) {
    removePlayer(p);
    players.delete(playerId);
  }
  peers.get(playerId)?.close();
  peers.delete(playerId);
  renderPlayers();
  renderScoreboard();
}

const sigUrl = defaultSignallingUrl();
const { send } = connectSignalling(sigUrl, (msg: SignallingMessage) => {
  if (msg.type === "session_created") {
    sessionId = msg.sessionId;
    const params = new URLSearchParams(location.search);
    const sig = params.get("sig") ?? defaultSignallingUrl();
    history.replaceState(null, "", `/${sessionId}${location.search}`);
    const join = new URL(msg.joinUrl, location.origin);
    if (params.get("sig") && !join.searchParams.get("sig")) {
      join.searchParams.set("sig", sig);
    }
    joinUrl = join.toString();
    joinUrlEl.textContent = joinUrl.replace(/^https?:\/\//, "");
    void QRCode.toCanvas(qrCanvas, joinUrl, { width: 180, margin: 1 });
    return;
  }
  if (msg.type === "player_joined") {
    addPlayer(msg.playerId);
    return;
  }
  if (msg.type === "player_left") {
    removePlayerId(msg.playerId);
    return;
  }
  if (msg.type === "sdp") {
    const peer = peers.get(msg.playerId);
    void peer?.handleAnswer(msg.sdp as RTCSessionDescriptionInit);
    return;
  }
  if (msg.type === "ice") {
    const peer = peers.get(msg.playerId);
    void peer?.handleIce(msg.candidate as RTCIceCandidateInit | null);
    return;
  }
  if (msg.type === "ws_relay" && msg.from === "controller") {
    peers.get(msg.playerId)?.handleRelay(msg.payload);
    return;
  }
  if (msg.type === "use_ws_fallback") {
    const p = players.get(msg.playerId);
    if (p) p.transport = "websocket";
    renderPlayers();
  }
});

send({ type: "create_session" });

window.addEventListener("pointerdown", () => sfx.unlock(), { once: false });
window.addEventListener("keydown", () => sfx.unlock(), { once: false });

const enableSoundBtn = document.getElementById("enable-sound");
enableSoundBtn?.addEventListener("click", () => {
  sfx.unlock();
  sfx.duckHit();
  enableSoundBtn.textContent = "TV SOUND ON";
  enableSoundBtn.setAttribute("disabled", "true");
});

void loadSpriteBank()
  .then((bank) => {
    sprites = bank;
  })
  .catch((err) => {
    console.error(err);
  })
  .finally(() => {
    requestAnimationFrame(frame);
  });

declare global {
  interface Window {
    duckhuntStartCalib?: (playerId?: string) => void;
  }
}
window.duckhuntStartCalib = (playerId?: string) => {
  const id = playerId ?? [...players.keys()][0];
  if (id) startCalibration(id);
};
