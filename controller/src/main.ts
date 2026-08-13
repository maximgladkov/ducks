import type { SignallingMessage } from "@duckhunt/shared";
import { sfx } from "./audio";
import {
  ContactMap,
  radiusFromPointer,
  radiusFromTouch,
} from "./contacts";
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

const IDLE_HINT = "Hold two fingers to recalibrate";
const RECALIBRATE_HOLD_MS = 600;
const USE_TOUCH = "ontouchstart" in window;

let wakeLock: WakeLockSentinel | null = null;
let eventSeq = 0;
let armed = false;
let shotsRemaining = 3;
let calibrating = false;
let fireId: number | null = null;
let recalibrateTimer: number | null = null;
let baseHint = IDLE_HINT;
let settleTimer = 0;
const contacts = new ContactMap();

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
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (type: string) => Promise<void>;
  };
  try {
    await orientation.lock?.("portrait");
  } catch {
    try {
      await orientation.lock?.("portrait-primary");
    } catch {}
  }
}

function sendEvent(
  type: "trigger_down" | "trigger_up" | "recalibrate" | "calib_point",
  seq = 0,
): void {
  session.sendEvent({ t: performance.now(), type, seq });
}

function cancelRecalibrateHold(): void {
  if (recalibrateTimer === null) return;
  window.clearTimeout(recalibrateTimer);
  recalibrateTimer = null;
  hintEl.textContent = baseHint;
}

function maybeStartRecalibrate(fingerCount: number): void {
  if (calibrating || fingerCount < 2) {
    cancelRecalibrateHold();
    return;
  }
  if (recalibrateTimer !== null) return;
  hintEl.textContent = "Keep holding to recalibrate…";
  recalibrateTimer = window.setTimeout(() => {
    recalibrateTimer = null;
    hintEl.textContent = baseHint;
    sendEvent("recalibrate");
    setStatus("Recalibrating…");
  }, RECALIBRATE_HOLD_MS);
}

function beginFire(): void {
  triggerBtn.dataset.down = "1";
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

function endFire(): void {
  fireId = null;
  triggerBtn.removeAttribute("data-down");
  sendEvent("trigger_up", eventSeq++);
  if (armed) triggerBtn.textContent = calibrating ? "HOLD" : "FIRE";
}

function syncFingers(): void {
  const fingers = contacts.fingers();
  if (fingers.length >= 2) {
    if (fireId !== null) endFire();
    maybeStartRecalibrate(fingers.length);
    return;
  }
  cancelRecalibrateHold();
  if (fireId !== null) {
    const held = contacts.get(fireId);
    if (!held || held.kind === "palm") endFire();
  }
  if (fireId === null && fingers[0]) {
    fireId = fingers[0].id;
    beginFire();
  }
}

function scheduleSync(wait: boolean): void {
  if (!wait) {
    if (settleTimer) {
      window.clearTimeout(settleTimer);
      settleTimer = 0;
    }
    syncFingers();
    return;
  }
  if (settleTimer) return;
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    contacts.tick();
    syncFingers();
  }, 16);
}

function noteTouch(touch: Touch, now: number): boolean {
  const { radius, minor } = radiusFromTouch(touch);
  const stylus = (touch as Touch & { touchType?: string }).touchType === "stylus";
  return (
    contacts.upsert(
      touch.identifier,
      radius,
      minor,
      now,
      stylus ? "pen" : undefined,
    ).kind === "unknown"
  );
}

function onTouchStart(ev: TouchEvent): void {
  if (!armed) return;
  ev.preventDefault();
  const now = performance.now();
  let wait = false;
  for (const touch of ev.changedTouches) wait = noteTouch(touch, now) || wait;
  scheduleSync(wait);
}

function onTouchMove(ev: TouchEvent): void {
  if (!armed) return;
  ev.preventDefault();
  const now = performance.now();
  for (const touch of ev.changedTouches) noteTouch(touch, now);
  scheduleSync(false);
}

function onTouchEnd(ev: TouchEvent): void {
  if (!armed) return;
  ev.preventDefault();
  for (const touch of ev.changedTouches) contacts.delete(touch.identifier);
  scheduleSync(false);
}

function onPointerDown(ev: PointerEvent): void {
  if (!armed) return;
  if (ev.pointerType === "touch") return;
  ev.preventDefault();
  const { radius, minor } = radiusFromPointer(ev);
  const kind = contacts.upsert(
    ev.pointerId,
    radius,
    minor,
    performance.now(),
    ev.pointerType,
  ).kind;
  triggerBtn.setPointerCapture(ev.pointerId);
  scheduleSync(kind === "unknown");
}

function onPointerMove(ev: PointerEvent): void {
  if (!armed) return;
  if (ev.pointerType === "touch") return;
  if (!contacts.get(ev.pointerId)) return;
  const { radius, minor } = radiusFromPointer(ev);
  contacts.upsert(ev.pointerId, radius, minor, performance.now(), ev.pointerType);
  scheduleSync(false);
}

function onPointerUp(ev: PointerEvent): void {
  if (ev.pointerType === "touch") return;
  if (!contacts.get(ev.pointerId)) return;
  if (triggerBtn.hasPointerCapture(ev.pointerId)) {
    triggerBtn.releasePointerCapture(ev.pointerId);
  }
  contacts.delete(ev.pointerId);
  syncFingers();
}

triggerBtn.addEventListener("click", () => {
  if (!armed) void arm();
});

if (USE_TOUCH) {
  triggerBtn.addEventListener("touchstart", onTouchStart, { passive: false });
  triggerBtn.addEventListener("touchmove", onTouchMove, { passive: false });
  triggerBtn.addEventListener("touchend", onTouchEnd, { passive: false });
  triggerBtn.addEventListener("touchcancel", onTouchEnd, { passive: false });
}

triggerBtn.addEventListener("pointerdown", onPointerDown);
triggerBtn.addEventListener("pointermove", onPointerMove);
triggerBtn.addEventListener("pointerup", onPointerUp);
triggerBtn.addEventListener("pointercancel", onPointerUp);

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

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    wakeLock = await requestWakeLock();
  }
});
