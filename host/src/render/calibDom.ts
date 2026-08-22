import { CALIB_FULL_COUNT, calibTargets, type Vec2 } from "gyro-aim";
import { CALIB_HOLD_MS, type CalibCapture } from "../machines/calibration";

export type CalibDom = {
  appEl: HTMLElement;
  overlay: HTMLElement;
  spotlight: HTMLElement;
  target: HTMLElement;
  countdown: HTMLElement;
  holdLabel: HTMLElement;
  card: HTMLElement;
  count: HTMLElement;
  pips: HTMLElement;
  status: HTMLElement;
  result: HTMLElement;
};

export function createCalibDom(): CalibDom {
  return {
    appEl: document.getElementById("app")!,
    overlay: document.getElementById("calib-overlay")!,
    spotlight: document.getElementById("calib-spotlight")!,
    target: document.getElementById("calib-target")!,
    countdown: document.getElementById("calib-countdown")!,
    holdLabel: document.getElementById("calib-hold-label")!,
    card: document.getElementById("calib-card")!,
    count: document.getElementById("calib-count")!,
    pips: document.getElementById("calib-pips")!,
    status: document.getElementById("calib-status")!,
    result: document.getElementById("calib-result")!,
  };
}

export function initCalibPips(dom: CalibDom): void {
  for (let i = 0; i < CALIB_FULL_COUNT; i++) {
    const pip = document.createElement("div");
    pip.className = "calib-pip";
    dom.pips.appendChild(pip);
  }
}

export function setCalibStatus(dom: CalibDom, text: string | null): void {
  dom.status.textContent = text ?? "";
}

export function setCalibResult(
  dom: CalibDom,
  text: string | null,
  opts: { player?: boolean; debug?: boolean } = {},
): void {
  if (text && !opts.debug && !opts.player) {
    dom.result.classList.add("hidden");
    dom.result.textContent = "";
    return;
  }
  if (!text) {
    dom.result.classList.add("hidden");
    dom.result.textContent = "";
    return;
  }
  dom.result.classList.remove("hidden");
  dom.result.textContent = text;
}

function clearPark(dom: CalibDom): void {
  dom.card.classList.remove("park-tl", "park-tr", "park-bl", "park-br", "dodge");
}

function parkCard(dom: CalibDom, x: number, y: number): void {
  clearPark(dom);
  const col = x < window.innerWidth / 2 ? "r" : "l";
  const row = y < window.innerHeight / 2 ? "b" : "t";
  dom.card.classList.add(`park-${row}${col}`);
}

export function resetCalibHoldUi(dom: CalibDom): void {
  dom.target.style.setProperty("--hold", "0%");
  dom.countdown.textContent = "";
  dom.holdLabel.textContent = "HOLD FIRE";
}

export function showCalibSettling(dom: CalibDom): void {
  dom.appEl.classList.add("calibrating");
  dom.overlay.classList.remove("hidden", "targeting");
  dom.target.classList.add("hidden");
  clearPark(dom);
  resetCalibHoldUi(dom);
  dom.count.textContent = "";
  for (const pip of dom.pips.children) {
    pip.classList.remove("on", "done");
  }
  setCalibStatus(
    dom,
    "Hold the phone steady in your aiming grip — sensors settling…",
  );
}

export function hideCalibOverlay(dom: CalibDom): void {
  dom.appEl.classList.remove("calibrating");
  dom.overlay.classList.add("hidden");
  dom.overlay.classList.remove("targeting");
  dom.target.classList.add("hidden");
  clearPark(dom);
  resetCalibHoldUi(dom);
  setCalibStatus(dom, null);
}

function updatePips(dom: CalibDom, seq: number, total: number): void {
  [...dom.pips.children].forEach((pip, i) => {
    (pip as HTMLElement).style.display = i < total ? "" : "none";
    pip.classList.toggle("done", i < seq);
    pip.classList.toggle("on", i === seq && i < total);
  });
}

export function showCalibCorner(
  dom: CalibDom,
  seq: number,
  total: number,
  screen: Vec2,
): void {
  const c = calibTargets(screen)[seq];
  if (!c) return;
  dom.appEl.classList.add("calibrating");
  dom.overlay.classList.remove("hidden");
  dom.overlay.classList.add("targeting");
  dom.spotlight.style.setProperty("--calib-x", `${c[0]}px`);
  dom.spotlight.style.setProperty("--calib-y", `${c[1]}px`);
  dom.target.style.left = `${c[0]}px`;
  dom.target.style.top = `${c[1]}px`;
  dom.target.dataset.v = c[1] < window.innerHeight / 2 ? "top" : "bottom";
  dom.target.dataset.h = c[0] < window.innerWidth / 2 ? "left" : "right";
  dom.target.classList.remove("hidden");
  resetCalibHoldUi(dom);
  dom.count.textContent = `TARGET ${seq + 1} / ${total}`;
  updatePips(dom, seq, total);
  parkCard(dom, c[0], c[1]);
  setCalibStatus(dom, "Point at the glowing dot, then hold FIRE");
}

export function paintCalibHold(
  dom: CalibDom,
  capture: CalibCapture | null,
  now: number,
): { sec: number; text: string } | null {
  if (!capture) {
    resetCalibHoldUi(dom);
    return null;
  }
  const held = now - capture.startedAt;
  const remain = Math.max(0, CALIB_HOLD_MS - held);
  const progress = Math.max(0, Math.min(1, held / CALIB_HOLD_MS));
  dom.target.style.setProperty("--hold", `${Math.round(progress * 100)}%`);
  const sec = remain > 0 ? Math.ceil(remain / 1000) : 0;
  if (sec > 0) {
    dom.countdown.textContent = String(sec);
    dom.holdLabel.textContent = "KEEP HOLDING";
    setCalibStatus(dom, "Keep holding FIRE still");
  } else {
    dom.countdown.textContent = "";
    dom.holdLabel.textContent = "HOLD STILL";
    setCalibStatus(dom, "Keep holding still until it locks");
  }
  return {
    sec,
    text: sec > 0 ? `HOLD STILL — release in ${sec}` : "HOLD STILL — locking…",
  };
}
