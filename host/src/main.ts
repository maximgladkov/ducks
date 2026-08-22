import QRCode from "qrcode";
import { calibTargets } from "gyro-aim";
import { type SignallingMessage } from "@duckhunt/shared";
import {
  CALIB_FULL_COUNT,
  CALIB_POINT_COUNT,
  CALIB_REFRESH_COUNT,
  applyStoredCalibration,
  beginCalibration,
  finishCalibration,
  loadSettings,
  recordCalibCorner,
  sampleCalibQuat,
  samplePlane,
  saveSettings,
  sessionOf,
  type DebugSettings,
} from "./game";
import { loadStoredCalib, saveStoredCalib } from "./calibStore";
import {
  HostPeer,
  connectSignalling,
  defaultSignallingUrl,
} from "./transport";
import { sfx } from "./audio";
import { createHudState, HUD_MAX_SHOTS } from "./hud";
import {
  COUNT_TIME,
  canShoot,
  chooseMode,
  consumeShot,
  createMatch,
  enterTitle,
  matchContext,
  matchPhase,
  noteSpawned,
  recordHit,
  recordMiss,
  tickMatch,
  type MatchCue,
} from "./machines/match";
import { createSession, sessionCalibrating, sessionMode } from "./machines/session";
import {
  createCalibActor,
  calibPhase,
  type CalibActor,
} from "./machines/calibration";
import { WAVE_SHOTS, duckPoints } from "./rules";
import {
  createSkyClouds,
  setCloudScreen,
  updateSkyClouds,
} from "./clouds";
import { loadSpriteBank, type SpriteBank } from "./sprites";
import { diagLog, diagStart, roundAll } from "./diag";
import { createGameWorld } from "./ecs/world";
import {
  Aim,
  Ammo,
  Duck,
  Hunt,
  Link,
  Player,
  Position,
  Score,
  Screen,
  Sensor,
  Settings,
  Time,
} from "./ecs/traits";
import {
  clearDucks,
  despawnPlayer,
  findDuck,
  playerEntity,
  spawnFloatScore,
  spawnPlayer,
  spawnStationaryGrid,
  spawnTitleDucks,
  spawnWave,
} from "./ecs/spawn";
import {
  aliveStationaryCount,
  duckCounts,
  hitDuck,
  markEscaping,
  stepDucks,
} from "./ecs/systems/ducks";
import { handlePlayerEvent, ingestSample, updateAimFrames } from "./ecs/systems/aim";
import { stepFloatScores } from "./ecs/systems/scores";
import { collectPlayerViews, drawFrame } from "./render/draw";
import {
  createCalibDom,
  hideCalibOverlay,
  initCalibPips,
  paintCalibHold,
  setCalibResult,
  setCalibStatus,
  showCalibCorner,
  showCalibSettling,
} from "./render/calibDom";

const DEBUG_UI =
  import.meta.env.DEV ||
  new URLSearchParams(location.search).get("debug") === "1";
document.documentElement.classList.toggle("debug-ui", DEBUG_UI);

let sprites: SpriteBank | null = null;
const world = createGameWorld();
const matchActor = createMatch();
const sessionActor = createSession();
const hud = createHudState();
const skyClouds = createSkyClouds(8);
const skyCanvas = document.getElementById("sky") as HTMLCanvasElement;
const skyCtx = skyCanvas.getContext("2d")!;
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: true })!;
const crossLayer = document.getElementById("crosshairs")!;
const qrCanvas = document.getElementById("qr") as HTMLCanvasElement;
const joinUrlEl = document.getElementById("join-url")!;
const playersEl = document.getElementById("players")!;
const debugEl = document.getElementById("debug")!;
const toggleDebug = document.getElementById("toggle-debug")!;
const gameBanner = document.getElementById("game-banner");
const calibDom = createCalibDom();
initCalibPips(calibDom);

let settings = loadSettings();
world.get(Settings)!.aim = settings;
diagStart({
  userAgent: navigator.userAgent,
  screen: [window.innerWidth, window.innerHeight],
  devicePixelRatio: window.devicePixelRatio,
  settings,
});
const peers = new Map<string, HostPeer>();
let sessionId = "";
let joinUrl = "";
let lastFrame = performance.now();
let fps = 0;
let frameTime = 0;
let debugOpen = false;
let huntAudioPaused = false;
let lagFlashAt: number | null = null;
let calibActor: CalibActor | null = null;
let calibBegun = false;
let appliedLockSeq = -1;
let lastPromptSeq = -1;
let lastHoldSec: number | null = null;
let lastSettleStatusAt = 0;
let lastRejectKey = "";
let calibFinished = false;

function sessionIdFromPath(): string | undefined {
  const match = location.pathname.match(/^\/([a-z]{2,4})$/i);
  return match?.[1]?.toLowerCase();
}

function rememberHostSession(id: string): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `duckhunt_host=${id}; Path=/; Max-Age=86400; SameSite=Lax${secure}`;
}

function startLagFlash(): void {
  const el = document.getElementById("lag-flash");
  setCalibResult(calibDom, "Pull the trigger when the screen flashes", {
    debug: DEBUG_UI,
    player: true,
  });
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
  persistSettings();
  const input = document.getElementById("displayLagMs") as HTMLInputElement | null;
  const label = document.getElementById("v-displayLagMs");
  if (input) input.value = String(settings.displayLagMs);
  if (label) label.textContent = String(settings.displayLagMs);
  setCalibResult(calibDom, `Display lag set to ${settings.displayLagMs} ms`, {
    debug: DEBUG_UI,
    player: true,
  });
  window.setTimeout(() => setCalibResult(calibDom, null), 4000);
}

function persistSettings(): void {
  saveSettings(settings);
  world.get(Settings)!.aim = settings;
  diagLog("settings", { ...settings });
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
  world.set(Screen, { w: cssW, h: cssH });
  if (calibActor && calibPhase(calibActor) === "targeting") {
    const ctxCalib = calibActor.getSnapshot().context;
    showCalibCorner(calibDom, ctxCalib.seq, ctxCalib.total, screenSize());
  }
}
window.addEventListener("resize", resize);
resize();

function ammoForPhase(): number {
  const phase = matchPhase(matchActor);
  if (phase === "wave") return matchContext(matchActor).shots;
  if (phase === "title" || phase === "gameOver") return WAVE_SHOTS;
  return 0;
}

function syncAmmo(): void {
  const shots = ammoForPhase();
  world.query(Player, Ammo).updateEach(([player, ammo]) => {
    ammo.shots = shots;
    peers.get(player.id)?.send({ type: "ammo", shots });
  });
}

function renderPlayers(): void {
  playersEl.innerHTML = collectPlayerViews(world)
    .map((p) => {
      const entity = playerEntity(world, p.id);
      const link = entity?.get(Link);
      return `<div style="color:${p.color}">● ${p.index + 1}P${DEBUG_UI ? ` · ${link?.transport ?? ""}` : ""} · ${p.shots}/${HUD_MAX_SHOTS} · ${String(p.score).padStart(6, "0")}</div>`;
    })
    .join("");
}

function applyCues(cues: MatchCue[]): void {
  const hunt = world.get(Hunt)!;
  for (const cue of cues) {
    if (cue.type === "spawnTitle") {
      spawnTitleDucks(world, screenSize());
    } else if (cue.type === "spawnWave") {
      spawnWave(
        world,
        screenSize(),
        cue.count,
        matchContext(matchActor).round,
        matchContext(matchActor).mode ?? "A",
      );
      noteSpawned(matchActor);
    } else if (cue.type === "startFlyAway") {
      markEscaping(world);
    } else if (cue.type === "ammo") {
      syncAmmo();
    } else if (cue.type === "music") {
      if (cue.name === "stop") sfx.stopBgm();
      else sfx.loop(cue.name);
    } else if (cue.type === "sfx") {
      if (cue.name === "start") {
        sfx.stopBgm();
        sfx.play("start");
      } else if (cue.name === "clear") {
        sfx.play("clear", { at: COUNT_TIME });
      } else {
        sfx.play(cue.name);
      }
    } else if (cue.type === "perfect") {
      sfx.stopBgm();
      sfx.play("perfect");
      world.query(Score).updateEach(([score]) => {
        score.value += cue.bonus;
      });
    }
  }
  hunt.mode = matchContext(matchActor).mode ?? hunt.mode;
  syncAmmo();
  renderPlayers();
}

function syncHuntLoops(): void {
  const flying =
    matchPhase(matchActor) === "wave" && duckCounts(world).flying > 0;
  if (flying) sfx.loopSfx("flap");
  else sfx.stop("flap");
  if (!flying && matchPhase(matchActor) === "wave") sfx.stop("duck");
}

function restoreHuntMusic(): void {
  const phase = matchPhase(matchActor);
  if (phase === "title") sfx.loop("title");
  else if (phase === "intro") sfx.loop("dog");
  else if (phase === "wave") {
    const c = duckCounts(world);
    if (c.flying + c.flashing > 0) sfx.loop("duck");
  }
}

function sendAmmo(playerId: string): void {
  const peer = peers.get(playerId);
  const entity = playerEntity(world, playerId);
  if (!peer || !entity) return;
  peer.send({ type: "ammo", shots: ammoForPhase() });
}

function rejectMessage(reason: string, spread?: number, drift?: number): string {
  if (!DEBUG_UI) {
    if (reason === "shaky") return "Too shaky — hold still and try again";
    if (reason === "drift") return "Sensors still settling — hold steady and try again";
    return "Keep holding FIRE until the countdown ends";
  }
  if (reason === "shaky") {
    return `Too shaky (${(((spread ?? 0) * 180) / Math.PI).toFixed(1)}°) — hold still and retry`;
  }
  if (reason === "drift") {
    return `Sensors still settling (${(drift ?? 0).toFixed(1)}°/s) — hold steady and retry`;
  }
  return "Keep holding FIRE until the countdown ends";
}

function beginCalibFlow(
  playerId: string,
  opts: { total?: number; keepMapping?: boolean; settle?: boolean } = {},
): void {
  const entity = playerEntity(world, playerId);
  const peer = peers.get(playerId);
  if (!entity || !peer) return;
  calibActor?.stop();
  sessionActor.send({ type: "CALIB_START", playerId });
  const settle = opts.settle ?? false;
  const stored = settle ? loadStoredCalib(screenSize()) : null;
  const restore = Boolean(stored);
  const total =
    opts.total ?? (restore ? CALIB_REFRESH_COUNT : CALIB_POINT_COUNT);
  const keepMapping = opts.keepMapping ?? restore;
  if (restore && stored) {
    applyStoredCalibration(entity, stored);
    setCalibResult(
      calibDom,
      `Restored aim · ${stored.label} · ±${stored.maxError.toFixed(0)}px — 4-point refresh`,
      { debug: DEBUG_UI },
    );
  } else {
    setCalibResult(calibDom, null);
  }
  calibActor = createCalibActor({
    playerId,
    total,
    keepMapping,
    restore,
    settle,
    now: performance.now(),
  });
  calibBegun = false;
  appliedLockSeq = -1;
  lastPromptSeq = -1;
  lastHoldSec = null;
  lastSettleStatusAt = 0;
  lastRejectKey = "";
  calibFinished = false;
}

function finishCalibSession(): void {
  if (!calibActor || calibFinished) return;
  const ctxCalib = calibActor.getSnapshot().context;
  const entity = playerEntity(world, ctxCalib.playerId);
  const peer = peers.get(ctxCalib.playerId);
  if (!entity || !peer) return;
  calibFinished = true;
  const result = finishCalibration(entity, screenSize());
  const session = sessionOf(entity);
  diagLog("calib_result", { id: ctxCalib.playerId, ...result });
  hideCalibOverlay(calibDom);
  if (result.ok && session.homography) {
    saveStoredCalib({
      screen: screenSize(),
      H: session.homography,
      muzzle: session.aimBasis.muzzle,
      label: session.aimBasis.label,
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
  sessionActor.send({ type: "CALIB_DONE", ok: result.ok });
  if (result.ok && matchPhase(matchActor) === "lobby") {
    applyCues(enterTitle(matchActor));
  }
  if (DEBUG_UI) {
    setCalibResult(
      calibDom,
      result.ok
        ? `Calibration ${quality} · grip: ${result.gripLabel} · held-out accuracy ±${result.errorPx.toFixed(0)}px`
        : result.reason ?? "Calibration failed",
      { debug: true },
    );
  } else {
    setCalibResult(
      calibDom,
      result.ok ? "Ready — aim and shoot" : "Calibration failed — try again",
      { player: true },
    );
  }
  window.setTimeout(() => setCalibResult(calibDom, null), 5000);
  calibActor.stop();
  calibActor = null;
}

function tickCalibration(now: number): void {
  if (!calibActor) return;
  const ctxCalib = calibActor.getSnapshot().context;
  const entity = playerEntity(world, ctxCalib.playerId);
  const peer = peers.get(ctxCalib.playerId);
  if (!entity || !peer) return;
  const sensor = entity.get(Sensor);
  calibActor.send({
    type: "TICK",
    now,
    sensorReady: sensor?.ready ?? false,
  });
  const phase = calibPhase(calibActor);
  const next = calibActor.getSnapshot().context;
  if (phase === "settling") {
    showCalibSettling(calibDom);
    if (now - lastSettleStatusAt > 250) {
      lastSettleStatusAt = now;
      peer.send({
        type: "status",
        text: "Hold steady in your aiming grip — settling sensors",
      });
    }
    return;
  }
  if (!calibBegun) {
    beginCalibration(entity, {
      total: next.total,
      keepMapping: next.keepMapping,
    });
    calibBegun = true;
    diagLog("calib_start", {
      id: next.playerId,
      screen: screenSize(),
      targets: calibTargets(screenSize()).slice(0, next.total),
      refInverse: roundAll(sessionOf(entity).refInverse),
      refresh: next.total < CALIB_POINT_COUNT,
    });
    peer.send({
      type: "status",
      text: `Point at each glowing dot and hold FIRE until the countdown ends (${next.total} targets)`,
    });
  }
  if (phase === "holding" || calibPhase(calibActor) === "targeting") {
    const plane = samplePlane(entity);
    const quat = sampleCalibQuat(entity);
    if (plane && quat && calibPhase(calibActor) === "holding") {
      calibActor.send({ type: "SAMPLE", plane, quat, now });
    }
  }
  const after = calibActor.getSnapshot();
  const afterPhase = calibPhase(calibActor);
  const afterCtx = after.context;
  if (afterCtx.lockSeq !== appliedLockSeq && afterCtx.lastLock?.ok) {
    appliedLockSeq = afterCtx.lockSeq;
    recordCalibCorner(
      entity,
      afterCtx.lastLock.quat,
      afterCtx.lastLock.plane,
      screenSize(),
    );
    const n = sessionOf(entity).calibQuats.length;
    diagLog("calib_capture", {
      id: afterCtx.playerId,
      index: n - 1,
      target: calibTargets(screenSize())[n - 1] ?? null,
      quat: roundAll(afterCtx.lastLock.quat),
      plane: roundAll(afterCtx.lastLock.plane),
      spreadDeg: Number(((afterCtx.lastLock.spread * 180) / Math.PI).toFixed(2)),
      samples: afterCtx.lastLock.durationMs,
      holdMs: Math.round(afterCtx.lastLock.durationMs),
      kind: afterCtx.kind,
      aimPx: roundAll(sessionOf(entity).aim, 1),
    });
    peer.send({
      type: "status",
      text: `Target ${n}/${afterCtx.total} locked (${((afterCtx.lastLock.spread * 180) / Math.PI).toFixed(1)}°)`,
    });
  }
  if (afterPhase === "done") {
    finishCalibSession();
    return;
  }
  if (afterPhase === "targeting") {
    showCalibCorner(calibDom, afterCtx.seq, afterCtx.total, screenSize());
    if (lastPromptSeq !== afterCtx.seq) {
      lastPromptSeq = afterCtx.seq;
      const corner = calibTargets(screenSize())[afterCtx.seq];
      if (corner) {
        peer.send({
          type: "calib_prompt",
          seq: afterCtx.seq,
          total: afterCtx.total,
          corner,
        });
      }
    }
    const verdict = afterCtx.verdict;
    if (verdict && !verdict.ok) {
      const text = rejectMessage(
        verdict.reason,
        verdict.spread,
        verdict.drift,
      );
      const key = `${afterCtx.seq}:${verdict.reason}`;
      if (key !== lastRejectKey) {
        lastRejectKey = key;
        setCalibStatus(calibDom, text);
        peer.send({ type: "status", text });
      }
    }
  }
  if (afterPhase === "holding") {
    const painted = paintCalibHold(calibDom, afterCtx.capture, now);
    if (painted && painted.sec !== lastHoldSec) {
      lastHoldSec = painted.sec;
      peer.send({ type: "status", text: painted.text });
    }
  }
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
      persistSettings();
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
      persistSettings();
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
  stationary.checked = sessionMode(sessionActor) === "stationary";
  stationary.onchange = () => {
    sessionActor.send({ type: "STATIONARY", on: stationary.checked });
    world.get(Hunt)!.stationary = stationary.checked;
    if (stationary.checked) {
      spawnStationaryGrid(world, screenSize());
    } else if (matchPhase(matchActor) === "title") {
      applyCues(enterTitle(matchActor));
    } else {
      clearDucks(world);
    }
  };

  const firstId = () =>
    calibActor?.getSnapshot().context.playerId ??
    collectPlayerViews(world)[0]?.id;
  document.getElementById("recalibrate")!.onclick = () => {
    const id = firstId();
    if (id) beginCalibFlow(id);
  };
  document.getElementById("refresh-aim")!.onclick = () => {
    const id = firstId();
    if (id) beginCalibFlow(id, { total: CALIB_REFRESH_COUNT, keepMapping: true });
  };
  document.getElementById("full-calib")!.onclick = () => {
    const id = firstId();
    if (id) beginCalibFlow(id, { total: CALIB_FULL_COUNT });
  };
  document.getElementById("lag-late")!.onclick = () => {
    settings.displayLagMs = Math.min(120, settings.displayLagMs + 8);
    persistSettings();
    const input = document.getElementById("displayLagMs") as HTMLInputElement | null;
    const label = document.getElementById("v-displayLagMs");
    if (input) input.value = String(settings.displayLagMs);
    if (label) label.textContent = String(settings.displayLagMs);
  };
  document.getElementById("lag-early")!.onclick = () => {
    settings.displayLagMs = Math.max(0, settings.displayLagMs - 8);
    persistSettings();
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
  const lines: string[] = [];
  world.query(Player, Aim, Link, Sensor).readEach(([player, aim, link]) => {
    const peer = peers.get(player.id);
    const plane = aim.session.samplePlane();
    const planeStr = plane
      ? `plane=(${plane[0].toFixed(3)},${plane[1].toFixed(3)})`
      : "plane=—";
    const w = aim.session.lastSample?.w;
    const rateDeg = w
      ? ((Math.hypot(w[0], w[1], w[2]) * 180) / Math.PI).toFixed(1)
      : "—";
    const lock = aim.session.stillLock.locked() ? "on" : "off";
    lines.push(
      `P${player.index + 1} ${link.transport} rtt=${link.rtt.toFixed(1)}ms off=${link.clockOffset.toFixed(1)} age=${aim.session.sampleAge.toFixed(1)}ms hor=${aim.session.horizonMs.toFixed(0)}ms nq=${aim.session.rateQuality.toFixed(2)} ω=${rateDeg}°/s lock=${lock} pkts=${aim.packets} drop~${peer?.dropped ?? 0} ${planeStr}`,
    );
  });
  let calibLine = "";
  if (calibActor) {
    const c = calibActor.getSnapshot().context;
    const entity = playerEntity(world, c.playerId);
    if (entity) {
      const session = sessionOf(entity);
      const targets = calibTargets(screenSize());
      const target = targets[Math.min(c.seq, targets.length - 1)]!;
      const err = Math.hypot(session.aim[0] - target[0], session.aim[1] - target[1]);
      calibLine = `<div>calib target ${c.seq + 1}/${c.total} · crosshair error ${err.toFixed(0)}px · capture ${c.capture?.samples.length ?? 0}</div>`;
    }
  } else {
    const first = collectPlayerViews(world)[0];
    const entity = first ? playerEntity(world, first.id) : undefined;
    const session = entity ? sessionOf(entity) : undefined;
    if (session?.homography) {
      const bench = session.bench.snapshot();
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
      const warn = session.needsRecal ? " · recalibrate" : "";
      calibLine = `<div>grip: ${session.gripLabel} · lag ${settings.displayLagMs}ms ${jitter} ${move} ${drift}${warn}</div>`;
    }
  }
  el.innerHTML = `<div>FPS ${fps.toFixed(0)} · frame ${frameTime.toFixed(1)}ms</div>${lines.map((l) => `<div>${l}</div>`).join("")}${calibLine}<div>ghosts: raw / filtered / predicted</div>`;
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  frameTime = now - lastFrame;
  fps = fps * 0.9 + (1000 / Math.max(1, frameTime)) * 0.1;
  lastFrame = now;
  world.set(Time, { dt, now });
  const [w, h] = screenSize();
  world.set(Screen, { w, h });
  const paused = sessionCalibrating(sessionActor);

  if (paused) {
    if (!huntAudioPaused) {
      huntAudioPaused = true;
      sfx.stopAll();
      sfx.play("pause");
    }
  } else if (huntAudioPaused) {
    huntAudioPaused = false;
    restoreHuntMusic();
  }

  updateSkyClouds(skyClouds, paused ? 0 : dt);
  tickCalibration(now);

  const stationary = sessionMode(sessionActor) === "stationary";
  if (!paused) {
    if (stationary) {
      const stepped = stepDucks(world, screenSize(), dt);
      for (let i = 0; i < stepped.landed; i++) sfx.play("land");
      if (aliveStationaryCount(world) === 0) {
        spawnStationaryGrid(world, screenSize());
      }
    } else {
      const huntMode = matchContext(matchActor).mode ?? "A";
      const stepped = stepDucks(world, screenSize(), dt, huntMode);
      for (let i = 0; i < stepped.landed; i++) sfx.play("land");
      for (const left of stepped.escaped) {
        if (!left.tag) recordMiss(matchActor);
      }
      const cues = tickMatch(matchActor, dt, duckCounts(world));
      if (cues.length) applyCues(cues);
      syncHuntLoops();
    }
    stepFloatScores(world, dt);
  }

  updateAimFrames(world, settings, screenSize(), dt, DEBUG_UI && debugOpen);
  world.query(Player, Aim).readEach(([_player, aim]) => {
    if (
      aim.session.needsRecal &&
      !aim.session.calibrating &&
      !sessionCalibrating(sessionActor)
    ) {
      setCalibResult(
        calibDom,
        "Aim drifted — hold two fingers on the phone to recalibrate",
        { player: true },
      );
    }
  });

  drawFrame({
    sprites,
    skyCtx,
    ctx,
    w,
    h,
    clouds: skyClouds,
    world,
    match: matchActor,
    hud,
    bannerEl: gameBanner,
  });
  if (debugOpen) updateDebugStats();
  requestAnimationFrame(frame);
}

function addPlayer(playerId: string): void {
  if (playerEntity(world, playerId)) return;
  const index = collectPlayerViews(world).length;
  const entity = spawnPlayer(world, playerId, index, crossLayer, settings);
  const peer = new HostPeer(playerId, send, {
    onSample: ({ sample }) => ingestSample(world, playerId, sample, settings),
    onDiag: ({ diag }) => {
      const sensor = entity.get(Sensor);
      if (sensor) {
        sensor.ready = diag.converged;
        sensor.tiltDeg = diag.tiltResidualDeg;
      }
      diagLog("controller", { id: playerId, ...diag });
    },
    onEvent: ({ event }) => {
      const aim = entity.get(Aim)!;
      diagLog("input", {
        id: playerId,
        event: event.type,
        seq: event.seq,
        calibrating: aim.session.calibrating,
        aimPx: roundAll(aim.session.aim, 1),
      });
      if (event.type === "trigger_down" && lagFlashAt !== null) {
        finishLagFlash(performance.now());
        return;
      }
      if (event.type === "recalibrate") {
        if (sessionCalibrating(sessionActor) || aim.session.calibrating) return;
        beginCalibFlow(
          playerId,
          aim.session.homography
            ? { total: CALIB_REFRESH_COUNT, keepMapping: true }
            : {},
        );
        return;
      }
      if (calibActor && calibActor.getSnapshot().context.playerId === playerId) {
        if (event.type === "trigger_down") {
          calibActor.send({ type: "TRIGGER_DOWN" });
        }
        if (event.type === "trigger_up") {
          calibActor.send({ type: "TRIGGER_UP", now: performance.now() });
        }
        return;
      }
      if (sessionCalibrating(sessionActor)) return;
      if (event.type !== "trigger_down") {
        handlePlayerEvent(
          world,
          playerId,
          event,
          settings,
          screenSize(),
          () => undefined,
        );
        return;
      }
      if (matchPhase(matchActor) === "gameOver") {
        sfx.play("gunshot");
        world.query(Score).updateEach(([score]) => {
          score.value = 0;
        });
        applyCues(enterTitle(matchActor));
        syncAmmo();
        return;
      }
      const stationary = sessionMode(sessionActor) === "stationary";
      if (!stationary && !canShoot(matchActor)) return;
      const result = handlePlayerEvent(
        world,
        playerId,
        event,
        settings,
        screenSize(),
        () => undefined,
      );
      if (matchPhase(matchActor) === "title") {
        sfx.play("gunshot");
        const found = result.hitId ? findDuck(world, result.hitId) : undefined;
        const info = found?.get(Duck);
        if (info?.tag === "titleA" || info?.tag === "titleB") {
          world.query(Score).updateEach(([score]) => {
            score.value = 0;
          });
          applyCues(chooseMode(matchActor, info.tag === "titleA" ? "A" : "B"));
          clearDucks(world);
          syncAmmo();
        }
        renderPlayers();
        return;
      }
      if (!stationary && !consumeShot(matchActor)) return;
      sfx.play("gunshot");
      if (stationary) {
        const ammo = entity.get(Ammo);
        if (ammo) ammo.shots = Math.max(0, ammo.shots - 1);
        sendAmmo(playerId);
      } else {
        syncAmmo();
      }
      if (result.hitId) {
        const duck = findDuck(world, result.hitId);
        const duckInfo = duck?.get(Duck);
        const pos = duck?.get(Position);
        if (duck && duckInfo && hitDuck(world, result.hitId)) {
          const pts = stationary
            ? 1000
            : duckPoints(matchContext(matchActor).round, duckInfo.kind);
          if (!stationary) recordHit(matchActor, pts);
          const score = entity.get(Score);
          if (score) score.value += pts;
          sfx.play("fall");
          if (pos) spawnFloatScore(world, pos.x, pos.y, String(pts));
        }
      }
      renderPlayers();
    },
    onTransport: (kind) => {
      const link = entity.get(Link);
      if (link) link.transport = kind;
      renderPlayers();
    },
    onClock: (offset, rtt) => {
      const link = entity.get(Link);
      const aim = entity.get(Aim);
      if (link) {
        link.clockOffset = offset;
        link.rtt = rtt;
      }
      aim?.session.setClockOffset(offset);
    },
  });
  peers.set(playerId, peer);
  void peer.startOffer().then(() => {
    beginCalibFlow(playerId, { settle: true });
  });
  renderPlayers();
}

function removePlayerId(playerId: string): void {
  despawnPlayer(world, playerId);
  peers.get(playerId)?.close();
  peers.delete(playerId);
  renderPlayers();
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
    const entity = playerEntity(world, msg.playerId);
    const link = entity?.get(Link);
    if (link) link.transport = "websocket";
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
  const id = playerId ?? collectPlayerViews(world)[0]?.id;
  if (id) beginCalibFlow(id);
};
