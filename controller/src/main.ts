import type { SignallingMessage } from "@duckhunt/shared";
import { sfx } from "./audio";
import { MotionPipeline, requestWakeLock } from "./sensors";
import {
  ControllerSession,
  connectSignalling,
  defaultSignallingUrl,
} from "./transport";

const statusEl = document.getElementById("status")!;
const transportEl = document.getElementById("transport")!;
const sensorEl = document.getElementById("sensors")!;
const warnEl = document.getElementById("warn")!;
const enableBtn = document.getElementById("enable") as HTMLButtonElement;
const recentreBtn = document.getElementById("recentre") as HTMLButtonElement;
const triggerBtn = document.getElementById("trigger") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const pathSession = location.pathname.match(/\/c\/([a-z]{2,4})\/?$/i)?.[1]?.toLowerCase();
const sessionId = pathSession ?? params.get("session");

let wakeLock: WakeLockSentinel | null = null;
let eventSeq = 0;
let motionEnabled = false;
let shotsRemaining = 3;
let lockedOrientation = screen.orientation?.type ?? "unknown";

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setWarn(text: string | null): void {
  if (!text) {
    warnEl.classList.add("hidden");
    warnEl.textContent = "";
    return;
  }
  warnEl.classList.remove("hidden");
  warnEl.textContent = text;
}

if (!sessionId) {
  setStatus("Missing session — scan the host QR code");
  enableBtn.disabled = true;
}

const session = new ControllerSession(sendStub, {
  onReady: (playerId) => setStatus(`Joined as ${playerId}`),
  onTransport: (kind) => {
    transportEl.textContent = `Transport: ${kind}`;
  },
  onHostMessage: (msg) => {
    if (msg.type === "calib_prompt") {
      setStatus(`Calibrate target ${msg.seq + 1}/${msg.total}`);
    }
    if (msg.type === "calib_done") {
      setStatus(msg.ok ? "Calibration OK — aim and shoot" : msg.reason ?? "Calib failed");
    }
    if (msg.type === "status") setStatus(msg.text);
    if (msg.type === "ammo") {
      shotsRemaining = Math.max(0, msg.shots);
    }
  },
  onError: (m) => setStatus(m),
});

let sendSignalling: (msg: SignallingMessage) => void = () => undefined;

function sendStub(msg: SignallingMessage): void {
  sendSignalling(msg);
}

const { send, ws } = connectSignalling(defaultSignallingUrl(), (msg) => {
  if (msg.type === "joined") {
    session.setPlayerId(msg.playerId);
    setStatus(`Connected · ${msg.playerId}`);
    return;
  }
  if (msg.type === "sdp" && msg.from === "host") {
    void session.handleOffer(msg.sdp as RTCSessionDescriptionInit);
    return;
  }
  if (msg.type === "ice" && msg.from === "host") {
    void session.handleIce(msg.candidate as RTCIceCandidateInit | null);
    return;
  }
  if (msg.type === "ws_relay" && msg.from === "host") {
    session.handleRelay(msg.payload);
    return;
  }
  if (msg.type === "use_ws_fallback") {
    session.enableFallback();
    return;
  }
  if (msg.type === "error") {
    setStatus(msg.message);
  }
});
sendSignalling = send;

ws.addEventListener("open", () => {
  if (sessionId) send({ type: "join_session", sessionId });
});
ws.addEventListener("close", () => {
  setStatus("Disconnected — reconnecting…");
  window.setTimeout(() => location.reload(), 1200);
});

const motion = new MotionPipeline({
  onSample: (q, w, t) => {
    if (!motionEnabled) return;
    session.sendSample({ t, q, w });
  },
  onMode: (mode) => {
    transportEl.textContent = `${transportEl.textContent.split(" · ")[0]} · sensors: ${mode}`;
  },
});

// Gyro bias only settles while the phone is held still, so surfacing it makes an
// otherwise invisible part of aim quality debuggable from the phone itself.
window.setInterval(() => {
  if (!motionEnabled) return;
  const d = motion.getDiagnostics();
  const sign = d.accelSign === 0 ? "?" : d.accelSign > 0 ? "spec" : "inverted";
  sensorEl.textContent = `${d.mode} · ${d.emitHz.toFixed(0)}Hz · ${
    d.converged ? "ready" : `settling ${d.tiltResidualDeg.toFixed(0)}°`
  } · gyro ${d.gyroConvention} · bias ${d.biasDegPerSec.toFixed(2)}°/s · ${
    d.stationary ? "still" : "moving"
  } · accel ${sign}`;
  session.sendDiag(d);
}, 500);

enableBtn.addEventListener("click", async () => {
  sfx.unlock();
  const ok = await motion.requestPermission();
  if (!ok) {
    setStatus("Motion permission denied");
    return;
  }
  motionEnabled = true;
  motion.start();
  enableBtn.disabled = true;
  recentreBtn.disabled = false;
  triggerBtn.disabled = false;
  setStatus(`Motion enabled · ${motion.getMode()}`);
  wakeLock = await requestWakeLock();
  try {
    const orient = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
    };
    await orient.lock?.("portrait");
  } catch {
    /* optional */
  }
});

function sendEvent(
  type: "trigger_down" | "trigger_up" | "recentre" | "calib_point",
  seq = 0,
): void {
  session.sendEvent({ t: performance.now(), type, seq });
}

recentreBtn.addEventListener("click", () => {
  motion.recentre();
  sendEvent("recentre");
  setStatus("Recentered");
});

const triggerDown = (ev: Event) => {
  ev.preventDefault();
  if (shotsRemaining <= 0) {
    sfx.empty();
  } else {
    shotsRemaining -= 1;
    sfx.shot();
  }
  sendEvent("trigger_down", eventSeq++);
};
const triggerUp = (ev: Event) => {
  ev.preventDefault();
  sendEvent("trigger_up", eventSeq++);
};

triggerBtn.addEventListener("pointerdown", triggerDown);
triggerBtn.addEventListener("pointerup", triggerUp);
triggerBtn.addEventListener("pointercancel", triggerUp);
triggerBtn.addEventListener("pointerleave", triggerUp);

document.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
  },
  { passive: false },
);

// Screen rotation is compensated for in the sample stream, so calibration stays
// valid; it is only worth mentioning when the platform will not tell us the angle.
window.addEventListener("orientationchange", () => {
  const next = screen.orientation?.type ?? "unknown";
  if (next === lockedOrientation) return;
  lockedOrientation = next;
  if (screen.orientation?.angle == null && window.orientation == null) {
    setWarn("Orientation changed — recalibrate on host");
  } else {
    setWarn(null);
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    wakeLock = await requestWakeLock();
  }
});
