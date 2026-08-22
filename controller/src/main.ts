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
import {
  createController,
  isArmed,
  isCalibrating,
} from "./machines/controller";

const statusEl = document.getElementById("status")!;
const hintEl = document.getElementById("hint")!;
const triggerBtn = document.getElementById("trigger") as HTMLButtonElement;
const shareEl = document.getElementById("share-card")!;
const shareImg = document.getElementById("share-card-img") as HTMLImageElement;
const shareSend = document.getElementById("share-card-send") as HTMLButtonElement;
const shareDismiss = document.getElementById("share-card-dismiss") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const pathSession = location.pathname.match(/\/c\/([a-z]{2,4})\/?$/i)?.[1]?.toLowerCase();
const sessionId = pathSession ?? params.get("session");

const USE_TOUCH = "ontouchstart" in window;

let wakeLock: WakeLockSentinel | null = null;
let fireId: number | null = null;
let settleTimer = 0;
let shareBlob: Blob | null = null;
const contacts = new ContactMap();
const actor = createController();

function paintController(): void {
  const ctx = actor.getSnapshot().context;
  statusEl.textContent = ctx.status;
  hintEl.textContent = ctx.hint;
  triggerBtn.textContent = ctx.triggerLabel;
  if (isArmed(actor)) triggerBtn.dataset.state = "ready";
}

actor.subscribe(() => paintController());

if (!sessionId) {
  actor.send({ type: "STATUS", text: "Missing session — scan the host QR code" });
}

const session = new ControllerSession(sendStub, {
  onReady: (playerId) =>
    actor.send({ type: "STATUS", text: `Joined as ${playerId}` }),
  onHostMessage: (msg) => {
    if (msg.type === "calib_prompt") {
      actor.send({ type: "CALIB_PROMPT", seq: msg.seq, total: msg.total });
    }
    if (msg.type === "calib_done") {
      actor.send({ type: "CALIB_DONE", ok: msg.ok, reason: msg.reason });
    }
    if (msg.type === "status") {
      actor.send({ type: "STATUS", text: msg.text });
    }
    if (msg.type === "ammo") {
      actor.send({ type: "AMMO", shots: msg.shots });
    }
    if (msg.type === "share_card") {
      showShareCard(msg.mime, msg.data);
    }
  },
  onError: (m) => actor.send({ type: "STATUS", text: m }),
});

let sendSignalling: (msg: SignallingMessage) => void = () => undefined;

function sendStub(msg: SignallingMessage): void {
  sendSignalling(msg);
}

const { send, ws } = connectSignalling(defaultSignallingUrl(), (msg) => {
  if (msg.type === "joined") {
    session.setPlayerId(msg.playerId);
    actor.send({ type: "STATUS", text: `Connected · ${msg.playerId}` });
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
    actor.send({ type: "STATUS", text: msg.message });
  }
});
sendSignalling = send;

ws.addEventListener("open", () => {
  if (sessionId) send({ type: "join_session", sessionId });
});
ws.addEventListener("close", () => {
  actor.send({ type: "STATUS", text: "Disconnected — reconnecting…" });
  window.setTimeout(() => location.reload(), 1200);
});

const motion = new MotionPipeline(
  {
    onSample: (sample) => {
      if (!isArmed(actor)) return;
      session.sendSample(sample);
    },
  },
  { biasStorageKey: "duckhunt.gyroBias.v1" },
);

window.setInterval(() => {
  if (!isArmed(actor)) return;
  session.sendDiag(motion.getDiagnostics());
  motion.saveBias();
}, 500);

actor.on("trigger_down", (ev) => {
  triggerBtn.dataset.down = "1";
  session.sendEvent({ t: performance.now(), type: "trigger_down", seq: ev.seq });
});
actor.on("trigger_up", (ev) => {
  triggerBtn.removeAttribute("data-down");
  session.sendEvent({ t: performance.now(), type: "trigger_up", seq: ev.seq });
});
actor.on("recalibrate", (ev) => {
  session.sendEvent({ t: performance.now(), type: "recalibrate", seq: ev.seq });
});
actor.on("shot", () => {
  sfx.shot();
});

async function arm(): Promise<void> {
  if (isArmed(actor)) return;
  if (!sessionId) {
    actor.send({ type: "STATUS", text: "Missing session — scan the host QR code" });
    return;
  }
  sfx.unlock();
  const granted = await motion.requestPermission();
  if (!granted) {
    actor.send({ type: "PERMISSION_DENIED" });
    return;
  }
  motion.start();
  actor.send({ type: "ARM", mode: motion.getMode() });
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

function syncFingers(): void {
  if (!isArmed(actor)) return;
  const fingers = contacts.fingers();
  if (fingers.length >= 2) {
    if (fireId !== null) {
      fireId = null;
      actor.send({ type: "FIRE_END" });
    }
    if (!isCalibrating(actor)) actor.send({ type: "TWO_FINGERS" });
    return;
  }
  actor.send({ type: "TWO_FINGERS_END" });
  if (fireId !== null) {
    const held = contacts.get(fireId);
    if (!held || held.kind === "palm") {
      fireId = null;
      actor.send({ type: "FIRE_END" });
    }
  }
  if (fireId === null && fingers[0]) {
    fireId = fingers[0].id;
    actor.send({ type: "FIRE_START" });
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
  if (!isArmed(actor)) return;
  ev.preventDefault();
  const now = performance.now();
  let wait = false;
  for (const touch of ev.changedTouches) wait = noteTouch(touch, now) || wait;
  scheduleSync(wait);
}

function onTouchMove(ev: TouchEvent): void {
  if (!isArmed(actor)) return;
  ev.preventDefault();
  const now = performance.now();
  for (const touch of ev.changedTouches) noteTouch(touch, now);
  scheduleSync(false);
}

function onTouchEnd(ev: TouchEvent): void {
  if (!isArmed(actor)) return;
  ev.preventDefault();
  for (const touch of ev.changedTouches) contacts.delete(touch.identifier);
  scheduleSync(false);
}

function onPointerDown(ev: PointerEvent): void {
  if (!isArmed(actor)) return;
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
  if (!isArmed(actor)) return;
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
  if (!isArmed(actor)) void arm();
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

function decodeBase64(data: string): ArrayBuffer {
  const bin = atob(data);
  const out = new ArrayBuffer(bin.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return out;
}

function showShareCard(mime: string, data: string): void {
  const blob = new Blob([decodeBase64(data)], { type: mime || "image/png" });
  const prev = shareImg.dataset.url;
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  shareImg.dataset.url = url;
  shareImg.src = url;
  shareBlob = blob;
  shareEl.classList.remove("hidden");
}

function hideShareCard(): void {
  shareEl.classList.add("hidden");
}

const SHARE_TITLE = "Think you can beat my Ducks Game score?";
const SHARE_TEXT =
  "I just played Ducks Game on the TV. Grab a phone, scan the QR, and try to top this — ducks.game";
const SHARE_URL = "https://ducks.game";

async function shareToSocial(): Promise<void> {
  if (!shareBlob || !navigator.share) return;
  const ext = shareBlob.type.includes("jpeg") ? "jpg" : "png";
  const file = new File([shareBlob], `ducks-game-round.${ext}`, {
    type: shareBlob.type,
  });
  const payloads: ShareData[] = [
    { files: [file], title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL },
    { files: [file], title: SHARE_TITLE, text: SHARE_TEXT },
    { files: [file], title: SHARE_TITLE },
  ];
  for (const data of payloads) {
    if (navigator.canShare && !navigator.canShare(data)) continue;
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
}

shareImg.addEventListener("click", () => void shareToSocial());
shareSend.addEventListener("click", () => void shareToSocial());
shareDismiss.addEventListener("click", () => hideShareCard());

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
