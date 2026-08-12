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
  createPlayer,
  finishCalibration,
  handlePlayerEvent,
  ingestSample,
  loadSettings,
  averageQuats,
  quatAngularSpread,
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
  setHudShots,
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

let sprites: SpriteBank | null = null;
let dogShow: { mode: "laugh" | "got"; t: number; playerId: string } | null =
  null;
const hud = createHudState();
let hudShotsPlayerId: string | null = null;
const skyClouds = createSkyClouds(8);
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const crossLayer = document.getElementById("crosshairs")!;
const qrCanvas = document.getElementById("qr") as HTMLCanvasElement;
const joinUrlEl = document.getElementById("join-url")!;
const playersEl = document.getElementById("players")!;
const calibBanner = document.getElementById("calib-banner")!;
const debugEl = document.getElementById("debug")!;
const toggleDebug = document.getElementById("toggle-debug")!;

let settings = loadSettings();
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
let calibMarker: HTMLDivElement | null = null;
let calibCapture: {
  playerId: string;
  samples: Vec2[];
  quats: import("@duckhunt/shared").Quat[];
  startedAt: number;
} | null = null;
const CALIB_CAPTURE_MS = 350;
const CALIB_MIN_SAMPLES = 12;
const CALIB_MAX_ANGLE_SPREAD = 0.06;

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

  renderHudDom(hud);
}

function renderPlayers(): void {
  playersEl.innerHTML = [...players.values()]
    .map(
      (p) =>
        `<div style="color:${p.color}">● P${p.index + 1} · ${p.transport} · ${p.shots}/${HUD_MAX_SHOTS}</div>`,
    )
    .join("");
}

function setCalibBanner(text: string | null): void {
  if (!text) {
    calibBanner.classList.add("hidden");
    calibBanner.textContent = "";
    return;
  }
  calibBanner.classList.remove("hidden");
  calibBanner.textContent = text;
}

function showCalibCorner(seq: number): void {
  const c = calibTargets(screenSize())[seq];
  if (!c) return;
  if (!calibMarker) {
    calibMarker = document.createElement("div");
    calibMarker.className = "calib-target";
    document.getElementById("calib-layer")!.appendChild(calibMarker);
  }
  calibMarker.style.left = `${c[0]}px`;
  calibMarker.style.top = `${c[1]}px`;
  calibMarker.classList.remove("hidden");
  setCalibBanner(
    `Target ${seq + 1}/${CALIB_POINT_COUNT} — same grip the whole time; aim, hold still, trigger`,
  );
}

function hideCalibCorner(): void {
  calibMarker?.classList.add("hidden");
  setCalibBanner(null);
}

function sendAmmo(playerId: string): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  peer.send({ type: "ammo", shots: p.shots });
}

function syncHudShotsFrom(playerId: string): void {
  const p = players.get(playerId);
  if (!p) return;
  hudShotsPlayerId = playerId;
  setHudShots(hud, p.shots);
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
  if (hudShotsPlayerId === playerId || players.size === 1) {
    syncHudShotsFrom(playerId);
  }
}

function startCalibration(playerId: string): void {
  const p = players.get(playerId);
  const peer = peers.get(playerId);
  if (!p || !peer) return;
  calibratingPlayerId = playerId;
  calibCapture = null;
  beginCalibration(p);
  showCalibCorner(0);
  peer.send({
    type: "status",
    text: `Hold phone however you like — keep that grip for all ${CALIB_POINT_COUNT} targets`,
  });
  peer.send({
    type: "calib_prompt",
    seq: 0,
    total: CALIB_POINT_COUNT,
    corner: calibTargets(screenSize())[0]!,
  });
}

function startCalibCapture(p: PlayerRuntime): void {
  calibCapture = {
    playerId: p.id,
    samples: [],
    quats: [],
    startedAt: performance.now(),
  };
  setCalibBanner("Hold still — capturing samples…");
}

function completeCalibCapture(p: PlayerRuntime): void {
  const peer = peers.get(p.id);
  if (!peer || !calibCapture || calibCapture.playerId !== p.id) return;
  const samples = calibCapture.samples;
  const quats = calibCapture.quats;
  calibCapture = null;
  if (quats.length < CALIB_MIN_SAMPLES) {
    peer.send({
      type: "status",
      text: `Too few samples (${quats.length}) — hold longer and retry`,
    });
    setCalibBanner("Capture failed — hold steadier and retry this corner");
    return;
  }
  const angleSpread = quatAngularSpread(quats);
  if (angleSpread > CALIB_MAX_ANGLE_SPREAD) {
    peer.send({
      type: "status",
      text: `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — steady and retry`,
    });
    setCalibBanner(
      `Too shaky (${((angleSpread * 180) / Math.PI).toFixed(1)}°) — hold still and retry`,
    );
    return;
  }
  const meanPlane = averageVec2(samples);
  const meanQuat = averageQuats(quats);
  if (!meanQuat) {
    peer.send({ type: "status", text: "Bad sample — try again" });
    return;
  }
  recordCalibCorner(p, meanQuat, meanPlane ?? [0, 0]);
  const n = p.calibQuats.length;
  peer.send({
    type: "status",
    text: `Target ${n}/${CALIB_POINT_COUNT} locked (${((angleSpread * 180) / Math.PI).toFixed(1)}°)`,
  });
  if (n < CALIB_POINT_COUNT) {
    showCalibCorner(n);
    peer.send({
      type: "calib_prompt",
      seq: n,
      total: CALIB_POINT_COUNT,
      corner: calibTargets(screenSize())[n]!,
    });
    return;
  }
  const result = finishCalibration(p, screenSize());
  hideCalibCorner();
  calibratingPlayerId = null;
  const summary = result.ok
    ? `OK · ${result.gripLabel} · accuracy ±${result.errorPx.toFixed(0)}px`
    : result.reason;
  peer.send({ type: "calib_done", ok: result.ok, reason: summary });
  peer.send({ type: "ammo", shots: p.shots });
  syncHudShotsFrom(p.id);
  setCalibBanner(
    result.ok
      ? `Calibration OK · grip: ${result.gripLabel} · held-out accuracy ±${result.errorPx.toFixed(0)}px`
      : result.reason ?? "Calibration failed",
  );
  window.setTimeout(() => setCalibBanner(null), 5000);
}

function onCalibPoint(p: PlayerRuntime, _seq: number): void {
  if (!p.calibrating) return;
  if (calibCapture) return;
  startCalibCapture(p);
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
    <label>prediction horizon ms <span id="v-predictionHorizonMs"></span>
      <input id="predictionHorizonMs" type="range" min="0" max="120" step="1" />
    </label>
    <label>filter lead (lag cancellation) <span id="v-filterLeadGain"></span>
      <input id="filterLeadGain" type="range" min="0" max="1.5" step="0.05" />
    </label>
    <label>aim assist radius <span id="v-aimAssistRadius"></span>
      <input id="aimAssistRadius" type="range" min="0" max="80" step="1" />
    </label>
    <label>sensitivity <span id="v-sensitivity"></span>
      <input id="sensitivity" type="range" min="100" max="2000" step="10" />
    </label>
    <label><input id="predictionEnabled" type="checkbox" /> prediction</label>
    <label><input id="filteringEnabled" type="checkbox" /> filtering</label>
    <label><input id="aimAssistEnabled" type="checkbox" /> aim assist</label>
    <label><input id="absoluteAiming" type="checkbox" /> absolute aiming (vs gyro mouse)</label>
    <label><input id="invertX" type="checkbox" /> invert X</label>
    <label><input id="invertY" type="checkbox" /> invert Y</label>
    <label><input id="stationaryMode" type="checkbox" /> stationary target mode</label>
    <div class="row">
      <button type="button" id="recalibrate">Recalibrate selected / first</button>
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
    return `P${p.index + 1} ${p.transport} rtt=${p.rtt.toFixed(1)}ms off=${p.clockOffset.toFixed(1)} age=${p.sampleAge.toFixed(1)}ms pkts=${rate} drop~${peer?.dropped ?? 0} ${planeStr}`;
  });
  let calibLine = "";
  if (calibratingPlayerId) {
    const p = players.get(calibratingPlayerId);
    const seq = p?.calibRays.length ?? 0;
    const targets = calibTargets(screenSize());
    const target = targets[Math.min(seq, targets.length - 1)]!;
    if (p) {
      const err = Math.hypot(p.aim[0] - target[0], p.aim[1] - target[1]);
      calibLine = `<div>calib target ${seq + 1}/${CALIB_POINT_COUNT} · crosshair error ${err.toFixed(0)}px · capture ${calibCapture?.samples.length ?? 0}</div>`;
    }
  } else {
    const p0 = [...players.values()][0];
    if (p0?.homography) {
      calibLine = `<div>grip: ${p0.gripLabel}</div>`;
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
      if (plane) calibCapture.samples.push(plane);
      if (quat) calibCapture.quats.push(quat);
      if (now - calibCapture.startedAt >= CALIB_CAPTURE_MS) {
        completeCalibCapture(p);
      } else {
        setCalibBanner(
          `Hold still — capturing ${calibCapture.samples.length} samples…`,
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
    onEvent: ({ event }) => {
      if (p.calibrating) {
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
      syncHudShotsFrom(p.id);

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
    window.setTimeout(() => startCalibration(playerId), 500);
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
