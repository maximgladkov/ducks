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
  duckCounts,
  finishCalibration,
  handlePlayerEvent,
  ingestSample,
  loadSettings,
  markEscaping,
  averageQuats,
  quatAngularSpread,
  quatDriftRate,
  sliceCalibWindow,
  recordCalibCorner,
  removePlayer,
  sampleCalibQuat,
  samplePlane,
  saveSettings,
  spawnHuntDuck,
  spawnStationaryGrid,
  spawnTitleDucks,
  stepTargets,
  updatePlayerFrame,
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
import { createHudState, HUD_MAX_SHOTS } from "./hud";
import { renderHudDom } from "./hudDom";
import {
  canShoot,
  chooseMode,
  consumeShot,
  createMatch,
  enterTitle,
  INTRO_ALERT,
  INTRO_SNIFF,
  noteSpawned,
  recordHit,
  recordMiss,
  sniffProgress,
  tickMatch,
  type MatchCue,
} from "./match";
import { WAVE_SHOTS, duckPoints, passLine } from "./rules";
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

const DEBUG_UI =
  import.meta.env.DEV ||
  new URLSearchParams(location.search).get("debug") === "1";
document.documentElement.classList.toggle("debug-ui", DEBUG_UI);

let sprites: SpriteBank | null = null;
const match = createMatch();
const hud = createHudState();
const skyClouds = createSkyClouds(8);
const skyCanvas = document.getElementById("sky") as HTMLCanvasElement;
const skyCtx = skyCanvas.getContext("2d")!;
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: true })!;
const appEl = document.getElementById("app")!;
const crossLayer = document.getElementById("crosshairs")!;
const qrCanvas = document.getElementById("qr") as HTMLCanvasElement;
const joinUrlEl = document.getElementById("join-url")!;
const playersEl = document.getElementById("players")!;
const calibOverlay = document.getElementById("calib-overlay")!;
const calibSpotlight = document.getElementById("calib-spotlight")!;
const calibTarget = document.getElementById("calib-target")!;
const calibCountdown = document.getElementById("calib-countdown")!;
const calibHoldLabel = document.getElementById("calib-hold-label")!;
const calibCard = document.getElementById("calib-card")!;
const calibCount = document.getElementById("calib-count")!;
const calibPips = document.getElementById("calib-pips")!;
const calibStatus = document.getElementById("calib-status")!;
const calibResult = document.getElementById("calib-result")!;
const debugEl = document.getElementById("debug")!;
const toggleDebug = document.getElementById("toggle-debug")!;
const gameBanner = document.getElementById("game-banner");

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

function sessionIdFromPath(): string | undefined {
  const match = location.pathname.match(/^\/([a-z]{2,4})$/i);
  return match?.[1]?.toLowerCase();
}

function rememberHostSession(id: string): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `duckhunt_host=${id}; Path=/; Max-Age=86400; SameSite=Lax${secure}`;
}

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
const CALIB_HOLD_MS = 3000;
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
let lastCalibHoldSec: number | null = null;
let floatScores: { x: number; y: number; text: string; t: number }[] = [];

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
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const bufW = Math.floor(cssW * dpr);
  const bufH = Math.floor(cssH * dpr);
  for (const [el, c] of [
    [canvas, ctx],
    [skyCanvas, skyCtx],
  ] as const) {
    el.width = bufW;
    el.height = bufH;
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setCloudScreen(cssW, cssH);
  if (calibratingPlayerId !== null && !calibTarget.classList.contains("hidden")) {
    showCalibCorner(calibSeq);
  }
}
window.addEventListener("resize", resize);
resize();

function nextTargetId(): string {
  return `t${targetSeq++}`;
}

function syncHud(): void {
  hud.round = match.round;
  hud.shots = match.phase === "wave" ? match.shots : WAVE_SHOTS;
  hud.hits = match.hits;
  hud.resolved = match.resolved;
  hud.score = match.score;
  hud.pass = passLine(match.round);
}

function ammoForPhase(): number {
  if (match.phase === "wave") return match.shots;
  if (match.phase === "title" || match.phase === "gameOver") return WAVE_SHOTS;
  return 0;
}

function syncAmmo(): void {
  const shots = ammoForPhase();
  for (const p of players.values()) {
    p.shots = shots;
    peers.get(p.id)?.send({ type: "ammo", shots });
  }
}

function applyCues(cues: MatchCue[]): void {
  for (const cue of cues) {
    if (cue.type === "spawnTitle") {
      targets = spawnTitleDucks(screenSize());
    } else if (cue.type === "spawnWave") {
      const next: Target[] = [];
      for (let i = 0; i < cue.count; i++) {
        next.push(spawnHuntDuck(screenSize(), nextTargetId(), match.round, match.mode ?? "A"));
      }
      targets = next;
      noteSpawned(match);
    } else if (cue.type === "startFlyAway") {
      targets = markEscaping(targets);
    } else if (cue.type === "ammo") {
      syncAmmo();
    } else if (cue.type === "sfx") {
      if (cue.name === "got") sfx.got();
      else sfx.laugh();
    } else if (cue.type === "perfect") {
      for (const p of players.values()) p.score += cue.bonus;
    }
  }
  syncHud();
  syncAmmo();
  renderPlayers();
}

function paintBanner(): void {
  if (!gameBanner) return;
  if (match.banner) {
    gameBanner.textContent = match.banner;
    gameBanner.classList.remove("hidden");
  } else {
    gameBanner.textContent = "";
    gameBanner.classList.add("hidden");
  }
}

function renderScoreboard(): void {
}

function draw(): void {
  const [w, h] = screenSize();
  if (!sprites) {
    skyCtx.fillStyle = "#3CBCFC";
    skyCtx.fillRect(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    return;
  }
  skyCtx.imageSmoothingEnabled = false;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  drawMeadowBack(skyCtx, sprites, w, h);
  drawSkyClouds(skyCtx, sprites, skyClouds);

  const playH = playfieldHeight(h);
  if (match.skyTint) {
    skyCtx.fillStyle = "rgba(252, 116, 180, 0.45)";
    skyCtx.fillRect(0, 0, w, playH);
  }

  const dogT =
    match.dogPose === "jump"
      ? Math.max(0, match.phaseT - INTRO_SNIFF - INTRO_ALERT)
      : match.phaseT;
  const dogOpts = { hold: match.dogHold, walk: sniffProgress(match) };
  if (match.dogPose === "jump") {
    drawDog(skyCtx, sprites, w, h, "jump", dogT, dogOpts);
  }

  drawMeadowFg(skyCtx, sprites, w, h);
  skyCtx.fillStyle = "#6B6B00";
  skyCtx.fillRect(0, playH, w, h - playH);

  if (match.dogPose === "sniff" || match.dogPose === "alert") {
    drawDog(skyCtx, sprites, w, h, match.dogPose, dogT, dogOpts);
  }

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

  if (match.dogPose === "got" || match.dogPose === "laugh") {
    drawDog(ctx, sprites, w, h, match.dogPose, dogT, dogOpts);
  }

  if (match.phase === "title") {
    const titleSize = Math.max(14, Math.round(w * 0.024));
    const subSize = Math.max(9, Math.round(w * 0.014));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.imageSmoothingEnabled = false;
    for (const t of targets) {
      const title = t.tag === "titleA" ? "GAME A" : t.tag === "titleB" ? "GAME B" : null;
      const sub = t.tag === "titleA" ? "1 DUCK" : t.tag === "titleB" ? "2 DUCKS" : null;
      if (!title || !sub) continue;
      const top = t.y + t.radius + 12;
      ctx.font = `${titleSize}px "Press Start 2P"`;
      ctx.fillStyle = "#fcfcfc";
      ctx.fillText(title, t.x, top);
      ctx.font = `${subSize}px "Press Start 2P"`;
      ctx.fillStyle = "#fcb400";
      ctx.fillText(sub, t.x, top + titleSize + 10);
      ctx.fillStyle = "#bcbcbc";
      ctx.fillText("3 SHOTS", t.x, top + titleSize + subSize + 20);
    }
  }

  ctx.font = `${Math.max(10, Math.round(w * 0.018))}px "Press Start 2P"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const f of floatScores) {
    ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9);
    ctx.fillStyle = "#fcfcfc";
    ctx.fillText(f.text, f.x, f.y - f.t * 48);
  }
  ctx.globalAlpha = 1;

  syncHud();
  renderHudDom(hud, [...players.values()]);
}

function renderPlayers(): void {
  playersEl.innerHTML = [...players.values()]
    .map(
      (p) =>
        `<div style="color:${p.color}">● ${p.index + 1}P${DEBUG_UI ? ` · ${p.transport}` : ""} · ${p.shots}/${HUD_MAX_SHOTS} · ${String(p.score).padStart(6, "0")}</div>`,
    )
    .join("");
}

function setCalibStatus(text: string | null): void {
  calibStatus.textContent = text ?? "";
}

function setCalibResult(text: string | null, opts: { player?: boolean } = {}): void {
  if (text && !DEBUG_UI && !opts.player) {
    calibResult.classList.add("hidden");
    calibResult.textContent = "";
    return;
  }
  if (!text) {
    calibResult.classList.add("hidden");
    calibResult.textContent = "";
    return;
  }
  calibResult.classList.remove("hidden");
  calibResult.textContent = text;
}

function clearCalibPark(): void {
  calibCard.classList.remove("park-tl", "park-tr", "park-bl", "park-br", "dodge");
}

function parkCalibCard(x: number, y: number): void {
  clearCalibPark();
  const col = x < window.innerWidth / 2 ? "r" : "l";
  const row = y < window.innerHeight / 2 ? "b" : "t";
  calibCard.classList.add(`park-${row}${col}`);
}

function resetCalibHoldUi(): void {
  lastCalibHoldSec = null;
  calibTarget.style.setProperty("--hold", "0%");
  calibCountdown.textContent = "";
  calibHoldLabel.textContent = "HOLD FIRE";
}

function paintCalibHold(now: number): void {
  if (!calibCapture) {
    resetCalibHoldUi();
    return;
  }
  const held = now - calibCapture.startedAt;
  const remain = Math.max(0, CALIB_HOLD_MS - held);
  const progress = Math.max(0, Math.min(1, held / CALIB_HOLD_MS));
  calibTarget.style.setProperty("--hold", `${Math.round(progress * 100)}%`);
  const sec = remain > 0 ? Math.ceil(remain / 1000) : 0;
  if (sec > 0) {
    calibCountdown.textContent = String(sec);
    calibHoldLabel.textContent = "KEEP HOLDING";
    setCalibStatus("Keep holding FIRE still");
  } else {
    calibCountdown.textContent = "";
    calibHoldLabel.textContent = "HOLD STILL";
    setCalibStatus("Keep holding still until it locks");
  }
  if (sec !== lastCalibHoldSec) {
    lastCalibHoldSec = sec;
    const peer = peers.get(calibCapture.playerId);
    peer?.send({
      type: "status",
      text:
        sec > 0
          ? `HOLD STILL — release in ${sec}`
          : "HOLD STILL — locking…",
    });
  }
}

function showCalibOverlay(): void {
  appEl.classList.add("calibrating");
  calibOverlay.classList.remove("hidden", "targeting");
  calibTarget.classList.add("hidden");
  clearCalibPark();
  resetCalibHoldUi();
  calibCount.textContent = "";
  for (const pip of calibPips.children) {
    pip.classList.remove("on", "done");
  }
}

function hideCalibOverlay(): void {
  appEl.classList.remove("calibrating");
  calibOverlay.classList.add("hidden");
  calibOverlay.classList.remove("targeting");
  calibTarget.classList.add("hidden");
  clearCalibPark();
  resetCalibHoldUi();
  setCalibStatus(null);
}

function updateCalibPips(seq: number, total: number): void {
  [...calibPips.children].forEach((pip, i) => {
    (pip as HTMLElement).style.display = i < total ? "" : "none";
    pip.classList.toggle("done", i < seq);
    pip.classList.toggle("on", i === seq && i < total);
  });
}

function showCalibCorner(seq: number): void {
  const p = calibratingPlayerId ? players.get(calibratingPlayerId) : undefined;
  const total = p?.calibTotal ?? CALIB_POINT_COUNT;
  const c = calibTargets(screenSize())[seq];
  if (!c) return;
  calibSeq = seq;
  appEl.classList.add("calibrating");
  calibOverlay.classList.remove("hidden");
  calibOverlay.classList.add("targeting");
  calibSpotlight.style.setProperty("--calib-x", `${c[0]}px`);
  calibSpotlight.style.setProperty("--calib-y", `${c[1]}px`);
  calibTarget.style.left = `${c[0]}px`;
  calibTarget.style.top = `${c[1]}px`;
  calibTarget.dataset.v = c[1] < window.innerHeight / 2 ? "top" : "bottom";
  calibTarget.dataset.h = c[0] < window.innerWidth / 2 ? "left" : "right";
  calibTarget.classList.remove("hidden");
  resetCalibHoldUi();
  calibCount.textContent = `TARGET ${seq + 1} / ${total}`;
  updateCalibPips(seq, total);
  parkCalibCard(c[0], c[1]);
  setCalibStatus("Point at the glowing dot, then hold FIRE");
}

function hideCalibCorner(): void {
  hideCalibOverlay();
}

function sendAmmo(playerId: string): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  peer.send({ type: "ammo", shots: ammoForPhase() });
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
    text: `Point at each glowing dot and hold FIRE until the countdown ends (${total} targets)`,
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
  lastCalibHoldSec = null;
  paintCalibHold(performance.now());
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
  const heldMs = now - calibCapture.startedAt;
  if (heldMs < CALIB_HOLD_MS) {
    if (kind === "auto") return false;
    calibCapture = null;
    resetCalibHoldUi();
    peer.send({
      type: "status",
      text: "Keep holding until the countdown ends",
    });
    setCalibStatus("Keep holding FIRE until the countdown ends");
    return false;
  }
  const held = calibHoldWindow(now, kind);
  const minMs = kind === "auto" ? CALIB_STABLE_MS * 0.9 : CALIB_MIN_HOLD_MS;
  if (
    !held ||
    held.durationMs < minMs ||
    held.quats.length < CALIB_MIN_SAMPLES
  ) {
    if (kind === "auto") return false;
    calibCapture = null;
    resetCalibHoldUi();
    peer.send({
      type: "status",
      text: "Hold longer — keep FIRE down until the countdown ends",
    });
    setCalibStatus("Keep holding FIRE until the countdown ends");
    return false;
  }
  const quats = held.quats;
  const samples = held.planes;
  const angleSpread = quatAngularSpread(quats);
  if (angleSpread > CALIB_MAX_ANGLE_SPREAD) {
    if (kind === "auto") return false;
    calibCapture = null;
    resetCalibHoldUi();
    peer.send({
      type: "status",
      text: DEBUG_UI
        ? `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — hold still and retry`
        : "Too shaky — hold still and try again",
    });
    setCalibStatus(
      DEBUG_UI
        ? `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — hold still and retry`
        : "Too shaky — hold still and try again",
    );
    return false;
  }
  const driftRate = quatDriftRate(quats, held.durationMs / 1000);
  if (driftRate > CALIB_MAX_DRIFT_DEG_PER_SEC) {
    if (kind === "auto") return false;
    calibCapture = null;
    resetCalibHoldUi();
    diagLog("calib_reject", {
      id: p.id,
      index: p.calibQuats.length,
      driftDegPerSec: Number(driftRate.toFixed(2)),
      spreadDeg: Number(((angleSpread * 180) / Math.PI).toFixed(2)),
    });
    peer.send({
      type: "status",
      text: DEBUG_UI
        ? `Sensors still settling (${driftRate.toFixed(1)}°/s) — hold steady and retry`
        : "Sensors still settling — hold steady and try again",
    });
    setCalibStatus(
      DEBUG_UI
        ? `Sensors still settling (${driftRate.toFixed(1)}°/s drift) — hold steady and retry this target`
        : "Sensors still settling — hold steady and try again",
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
  peer.send({
    type: "calib_done",
    ok: result.ok,
    reason: DEBUG_UI
      ? summary
      : result.ok
        ? "Calibration OK — aim and shoot"
        : "Calibration failed — try again",
  });
  peer.send({ type: "ammo", shots: ammoForPhase() });
  if (result.ok && match.phase === "lobby") {
    applyCues(enterTitle(match));
  }
  if (DEBUG_UI) {
    setCalibResult(
      result.ok
        ? `Calibration ${quality} · grip: ${result.gripLabel} · held-out accuracy ±${result.errorPx.toFixed(0)}px`
        : result.reason ?? "Calibration failed",
    );
  } else {
    setCalibResult(
      result.ok ? "Ready — aim and shoot" : "Calibration failed — try again",
      { player: true },
    );
  }
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
    if (stationaryMode) {
      targets = spawnStationaryGrid(screenSize());
    } else if (match.phase === "title") {
      applyCues(enterTitle(match));
    } else {
      targets = [];
    }
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

toggleDebug.onclick = DEBUG_UI
  ? () => {
      debugOpen = !debugOpen;
      debugEl.classList.toggle("hidden", !debugOpen);
      if (debugOpen) buildDebugHud();
    }
  : null;

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
  const paused = calibratingPlayerId !== null;

  updateSkyClouds(skyClouds, paused ? 0 : dt);

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
        paintCalibHold(now);
      }
    }
  }

  if (!paused) {
    if (stationaryMode) {
      const stepped = stepTargets(targets, screenSize(), dt);
      targets = stepped.next;
      const alive = targets.filter(
        (t) => t.stationary && !t.falling && t.flash <= 0,
      );
      if (alive.length === 0) targets = spawnStationaryGrid(screenSize());
    } else {
      const huntMode = match.mode ?? "A";
      const stepped = stepTargets(targets, screenSize(), dt, huntMode);
      for (const left of stepped.escaped) {
        if (left.escaping && !left.tag) recordMiss(match);
      }
      targets = stepped.next;
      const cues = tickMatch(match, dt, duckCounts(targets));
      if (cues.length) applyCues(cues);
      else syncHud();
    }

    floatScores = floatScores
      .map((f) => ({ ...f, t: f.t + dt }))
      .filter((f) => f.t < 0.9);
  }

  paintBanner();

  for (const p of players.values()) {
    updatePlayerFrame(p, settings, screenSize(), targets, dt, DEBUG_UI && debugOpen);
    if (p.needsRecal && !p.calibrating && calibratingPlayerId === null) {
      setCalibResult("Aim drifted — hold two fingers on the phone to recalibrate");
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
      if (event.type === "recalibrate") {
        if (calibratingPlayerId !== null || p.calibrating) return;
        startCalibration(
          p.id,
          p.homography
            ? { total: CALIB_REFRESH_COUNT, keepMapping: true }
            : {},
        );
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

      if (calibratingPlayerId !== null) return;

      if (event.type !== "trigger_down") {
        handlePlayerEvent(
          p,
          event,
          settings,
          screenSize(),
          targets,
          onCalibPoint,
        );
        return;
      }

      if (match.phase === "gameOver") {
        for (const pl of players.values()) pl.score = 0;
        applyCues(enterTitle(match));
        syncAmmo();
        return;
      }

      if (!stationaryMode && !canShoot(match)) return;

      const result = handlePlayerEvent(
        p,
        event,
        settings,
        screenSize(),
        targets,
        onCalibPoint,
      );

      if (match.phase === "title") {
        const hit = targets.find((t) => t.id === result.hitId);
        if (hit?.tag === "titleA" || hit?.tag === "titleB") {
          for (const pl of players.values()) pl.score = 0;
          chooseMode(match, hit.tag === "titleA" ? "A" : "B");
          targets = [];
          syncHud();
          syncAmmo();
        }
        renderPlayers();
        return;
      }

      if (!stationaryMode && !consumeShot(match)) return;
      if (stationaryMode) {
        p.shots = Math.max(0, p.shots - 1);
        sendAmmo(p.id);
      } else {
        syncAmmo();
      }

      if (result.hitId) {
        const hitId = result.hitId;
        const duck = targets.find((t) => t.id === hitId);
        if (duck && duck.flash <= 0 && !duck.falling) {
          const pts = stationaryMode ? 1000 : duckPoints(match.round, duck.kind);
          if (!stationaryMode) recordHit(match, pts);
          p.score += pts;
          sfx.duckHit();
          sfx.fall();
          floatScores.push({ x: duck.x, y: duck.y, text: String(pts), t: 0 });
          targets = targets.map((t) =>
            t.id === hitId ? { ...t, flash: 1, vx: t.vx * 0.2 } : t,
          );
        }
      }
      syncHud();
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
    rememberHostSession(sessionId);
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

const resumeSessionId = sessionIdFromPath();
if (resumeSessionId) rememberHostSession(resumeSessionId);
send({ type: "create_session", sessionId: resumeSessionId });

const soundGate = document.getElementById("sound-gate");

async function enableTvSound(): Promise<void> {
  const ok = await sfx.unlock();
  if (ok) soundGate?.classList.add("hidden");
}

void enableTvSound();
window.addEventListener("pointerdown", () => void enableTvSound());
window.addEventListener("keydown", () => void enableTvSound());

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
