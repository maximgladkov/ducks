import type { SignallingMessage } from "@duckhunt/shared";
import { sfx } from "./audio";
import { MotionPipeline, requestWakeLock } from "./sensors";
import {
  ControllerSession,
  connectSignalling,
  defaultSignallingUrl,
} from "./transport";

const statusEl = document.getElementById("status")!;
const warnEl = document.getElementById("warn")!;
const hintEl = document.getElementById("hint")!;
const triggerBtn = document.getElementById("trigger") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const pathSession = location.pathname.match(/\/c\/([a-z]{2,4})\/?$/i)?.[1]?.toLowerCase();
const sessionId = pathSession ?? params.get("session");

const IDLE_HINT = "Hold two fingers to recentre";
const RECENTRE_HOLD_MS = 600;

let wakeLock: WakeLockSentinel | null = null;
let eventSeq = 0;
let armed = false;
let shotsRemaining = 3;
let calibrating = false;
let lockedOrientation = screen.orientation?.type ?? "unknown";
let activePointer: number | null = null;
let recentreTimer: number | null = null;
let baseHint = IDLE_HINT;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setHint(text: string): void {
  baseHint = text;
  hintEl.textContent = text;
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
}

const session = new ControllerSession(sendStub, {
  onReady: (playerId) => setStatus(`Joined as ${playerId}`),
  onHostMessage: (msg) => {
    if (msg.type === "calib_prompt") {
      calibrating = true;
      setStatus(`Calibrate target ${msg.seq + 1}/${msg.total}`);
      setHint(`Same grip for all ${msg.total} dots — aim at the glowing dot and hold FIRE until the countdown ends`);
      if (armed) triggerBtn.textContent = "HOLD";
    }
    if (msg.type === "calib_done") {
      calibrating = false;
      setStatus(msg.ok ? "Calibration OK — aim and shoot" : msg.reason ?? "Calib failed");
      setHint(IDLE_HINT);
      if (armed) triggerBtn.textContent = "FIRE";
    }
    if (msg.type === "status") {
      setStatus(msg.text);
      if (calibrating && armed) {
        const count = msg.text.match(/release in (\d)/);
        if (count) triggerBtn.textContent = `HOLD ${count[1]}`;
        else if (/locking/.test(msg.text)) triggerBtn.textContent = "HOLDING";
      }
    }
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
  onSample: (q, w, t, nq) => {
    if (!armed) return;
    session.sendSample({ t, q, w, nq });
  },
});

// Diagnostics still leave the phone for the host's debug HUD and session log; it
// is only the readout on the phone that is gone, since the player cannot act on
// gyro bias and the screen is meant to be glanced at, not read.
window.setInterval(() => {
  if (!armed) return;
  session.sendDiag(motion.getDiagnostics());
  motion.saveBias();
}, 500);

/**
 * iOS only grants motion access from inside a user gesture, and a gesture it will
 * accept is a tap, which is why this is the trigger's own first tap rather than a
 * separate button: one less thing on screen and one less thing to explain. The
 * permission call has to be reached before this function first awaits, or Safari
 * no longer counts it as coming from the tap.
 */
async function arm(): Promise<void> {
  if (armed) return;
  if (!sessionId) {
    setStatus("Missing session — scan the host QR code");
    return;
  }
  sfx.unlock();
  const granted = await motion.requestPermission();
  if (!granted) {
    setStatus("Motion blocked — allow motion access, then tap again");
    return;
  }
  armed = true;
  motion.start();
  triggerBtn.dataset.state = "ready";
  triggerBtn.textContent = calibrating ? "HOLD" : "FIRE";
  setStatus(`Ready · ${motion.getMode()}`);
  setHint(IDLE_HINT);
  wakeLock = await requestWakeLock();
  try {
    const orient = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
    };
    await orient.lock?.("portrait");
  } catch {
    /* optional */
  }
}

function sendEvent(
  type: "trigger_down" | "trigger_up" | "recentre" | "calib_point",
  seq = 0,
): void {
  session.sendEvent({ t: performance.now(), type, seq });
}

function recentre(): void {
  motion.recentre();
  sendEvent("recentre");
  setStatus("Recentered");
}

function cancelRecentreHold(): void {
  if (recentreTimer === null) return;
  window.clearTimeout(recentreTimer);
  recentreTimer = null;
  hintEl.textContent = baseHint;
}

function fire(): void {
  if (calibrating) {
    triggerBtn.textContent = "HOLDING";
    sendEvent("trigger_down", eventSeq++);
    return;
  }
  if (shotsRemaining <= 0) {
    sfx.empty();
  } else {
    shotsRemaining -= 1;
    sfx.shot();
  }
  sendEvent("trigger_down", eventSeq++);
}

triggerBtn.addEventListener("click", () => {
  if (!armed) void arm();
});

triggerBtn.addEventListener("pointerdown", (ev) => {
  // The arming tap must not also spend a shot, and it must reach the click that
  // follows, which is the gesture the permission prompt hangs off — cancelling
  // this event's default can swallow that click, so it is left alone until armed.
  if (!armed) return;
  ev.preventDefault();
  // Recentring re-anchors where the phone thinks the screen is, so a stray one
  // would undo the calibration's aim and it has to be impossible to reach by
  // accident. Two fingers rules out a thumb on the trigger, and holding them
  // rules out the brief overlap you get from mashing the button with both.
  if (activePointer !== null) {
    if (ev.pointerId !== activePointer && recentreTimer === null) {
      hintEl.textContent = "Keep holding to recentre…";
      recentreTimer = window.setTimeout(() => {
        recentreTimer = null;
        hintEl.textContent = baseHint;
        recentre();
      }, RECENTRE_HOLD_MS);
    }
    return;
  }
  activePointer = ev.pointerId;
  // Aiming means swinging the phone while pressed, and a finger that slides off
  // the button would otherwise read as a release mid-shot.
  triggerBtn.setPointerCapture(ev.pointerId);
  fire();
});

const releasePointer = (ev: PointerEvent) => {
  cancelRecentreHold();
  if (ev.pointerId !== activePointer) return;
  ev.preventDefault();
  activePointer = null;
  if (triggerBtn.hasPointerCapture(ev.pointerId)) {
    triggerBtn.releasePointerCapture(ev.pointerId);
  }
  sendEvent("trigger_up", eventSeq++);
  if (armed) triggerBtn.textContent = calibrating ? "HOLD" : "FIRE";
};

triggerBtn.addEventListener("pointerup", releasePointer);
triggerBtn.addEventListener("pointercancel", releasePointer);

// Long presses, double taps and stray pinches are all normal ways to hold a phone
// while aiming, and every one of them has a browser default that would put a
// selection, a magnifier or a zoom over the trigger.
const swallow = (ev: Event) => ev.preventDefault();
for (const type of [
  "touchmove",
  "contextmenu",
  "selectstart",
  "dragstart",
  "dblclick",
  "gesturestart",
  "gesturechange",
  "gestureend",
]) {
  document.addEventListener(type, swallow, { passive: false });
}

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
