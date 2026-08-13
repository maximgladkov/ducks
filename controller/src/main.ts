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
const gripEl = document.getElementById("grip")!;
const triggers = [
  ...document.querySelectorAll<HTMLButtonElement>(".trigger"),
];

const params = new URLSearchParams(location.search);
const pathSession = location.pathname.match(/\/c\/([a-z]{2,4})\/?$/i)?.[1]?.toLowerCase();
const sessionId = pathSession ?? params.get("session");

const IDLE_HINT = "Thumb the red pad · two fingers on the grip to recentre";
const RECENTRE_HOLD_MS = 600;
const PALM_CONTACT_PX = 56;

let wakeLock: WakeLockSentinel | null = null;
let eventSeq = 0;
let armed = false;
let shotsRemaining = 3;
let calibrating = false;
let lockedOrientation = screen.orientation?.type ?? "unknown";
let firePointer: number | null = null;
let fireEl: HTMLButtonElement | null = null;
const gripPointers = new Set<number>();
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

function setTriggerLabel(text: string): void {
  for (const btn of triggers) btn.textContent = text;
}

function isPalmContact(ev: PointerEvent): boolean {
  const size = Math.max(ev.width || 0, ev.height || 0);
  return size >= PALM_CONTACT_PX;
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
      if (armed) setTriggerLabel("HOLD");
    }
    if (msg.type === "calib_done") {
      calibrating = false;
      setStatus(msg.ok ? "Calibration OK — aim and shoot" : msg.reason ?? "Calib failed");
      setHint(IDLE_HINT);
      if (armed) setTriggerLabel("FIRE");
    }
    if (msg.type === "status") {
      setStatus(msg.text);
      if (calibrating && armed) {
        const count = msg.text.match(/release in (\d)/);
        if (count) setTriggerLabel(`HOLD ${count[1]}`);
        else if (/locking/.test(msg.text)) setTriggerLabel("HOLDING");
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
  for (const btn of triggers) btn.dataset.state = "ready";
  setTriggerLabel(calibrating ? "HOLD" : "FIRE");
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

function maybeStartRecentre(): void {
  if (gripPointers.size < 2 || recentreTimer !== null) return;
  hintEl.textContent = "Keep holding to recentre…";
  recentreTimer = window.setTimeout(() => {
    recentreTimer = null;
    hintEl.textContent = baseHint;
    recentre();
  }, RECENTRE_HOLD_MS);
}

function fire(): void {
  if (calibrating) {
    setTriggerLabel("HOLDING");
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

for (const btn of triggers) {
  btn.addEventListener("click", () => {
    if (!armed) void arm();
  });

  btn.addEventListener("pointerdown", (ev) => {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isPalmContact(ev)) return;
    if (firePointer !== null) return;
    firePointer = ev.pointerId;
    fireEl = btn;
    btn.dataset.down = "1";
    btn.setPointerCapture(ev.pointerId);
    fire();
  });
}

function releaseFire(ev: PointerEvent): void {
  if (ev.pointerId !== firePointer) return;
  ev.preventDefault();
  if (fireEl?.hasPointerCapture(ev.pointerId)) {
    fireEl.releasePointerCapture(ev.pointerId);
  }
  fireEl?.removeAttribute("data-down");
  firePointer = null;
  fireEl = null;
  sendEvent("trigger_up", eventSeq++);
  if (armed) setTriggerLabel(calibrating ? "HOLD" : "FIRE");
}

gripEl.addEventListener("pointerdown", (ev) => {
  if ((ev.target as Element | null)?.closest?.(".trigger")) return;
  if (!armed) return;
  ev.preventDefault();
  gripPointers.add(ev.pointerId);
  gripEl.setPointerCapture(ev.pointerId);
  maybeStartRecentre();
});

const releaseGrip = (ev: PointerEvent) => {
  if (!gripPointers.has(ev.pointerId)) return;
  gripPointers.delete(ev.pointerId);
  if (gripEl.hasPointerCapture(ev.pointerId)) {
    gripEl.releasePointerCapture(ev.pointerId);
  }
  if (gripPointers.size < 2) cancelRecentreHold();
};

document.addEventListener("pointerup", (ev) => {
  releaseFire(ev);
  releaseGrip(ev);
});
document.addEventListener("pointercancel", (ev) => {
  releaseFire(ev);
  releaseGrip(ev);
});

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
