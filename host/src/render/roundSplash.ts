import QRCode from "qrcode";
import { HUD_HIT_SLOTS } from "../hud";
import type { SpriteBank } from "../sprites";

const PLAY_HOST = "DUCKS.GAME";
const PLAY_URL = "https://ducks.game";
const SCENE_SIZE = 512;
const MEADOW_W = 256;
const MEADOW_H = 184;

export type RoundSplashPlayer = {
  id: string;
  index: number;
  color: string;
  score: number;
  delta: number;
};

export type RoundSplashRecap = {
  round: number;
  title: string;
  hits: boolean[];
  hitCount: number;
  total: number;
  score: number;
  delta: number;
  players: RoundSplashPlayer[];
};

export type RoundSplashHandlers = {
  onShare: (card: HTMLElement) => void | Promise<void>;
  onContinue: () => void;
};

let sharing = false;
let bound = false;
let paintedRecap: RoundSplashRecap | null = null;
let paintedBank: SpriteBank | null = null;
let paintedMode: "recap" | "howto" = "recap";
let qrImage: HTMLImageElement | null = null;
let qrLoad: Promise<HTMLImageElement> | null = null;

function formatScore(score: number): string {
  return Math.max(0, Math.round(score)).toLocaleString("en-US");
}

function formatDelta(delta: number): string {
  const sign = delta < 0 ? "-" : "+";
  return `${sign}${formatScore(Math.abs(delta))}`;
}

function loadQr(): Promise<HTMLImageElement> {
  if (qrImage) return Promise.resolve(qrImage);
  if (qrLoad) return qrLoad;
  qrLoad = QRCode.toDataURL(PLAY_URL, {
    width: 256,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#fcfcfc" },
  }).then(
    (dataUrl) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          qrImage = img;
          resolve(img);
        };
        img.onerror = reject;
        img.src = dataUrl;
      }),
  );
  return qrLoad;
}

function drawQr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  if (!qrImage) return;
  ctx.fillStyle = "#fcfcfc";
  ctx.fillRect(x - 6, y - 6, size + 12, size + 12);
  ctx.drawImage(qrImage, x, y, size, size);
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  flip = false,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flip) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, w, h);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
}

function fillLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  shadow = 3,
): void {
  ctx.fillStyle = "#000";
  ctx.fillText(text, x + shadow, y + shadow);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  line = 4,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(x + 4, y + 4, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = line;
  ctx.strokeRect(x + line / 2, y + line / 2, w - line, h - line);
}

function paintSunburst(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.save();
  ctx.translate(s / 2, s * 0.32);
  const rays = 16;
  for (let i = 0; i < rays; i++) {
    ctx.rotate((Math.PI * 2) / rays);
    ctx.fillStyle = i % 2 === 0 ? "#ffffff28" : "#fcb40022";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(28, s);
    ctx.lineTo(-28, s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function paintFrame(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, s, 8);
  ctx.fillRect(0, s - 8, s, 8);
  ctx.fillRect(0, 0, 8, s);
  ctx.fillRect(s - 8, 0, 8, s);
  ctx.fillStyle = "#fcfcfc";
  ctx.fillRect(8, 8, s - 16, 4);
  ctx.fillRect(8, s - 12, s - 16, 4);
  ctx.fillRect(8, 8, 4, s - 16);
  ctx.fillRect(s - 12, 8, 4, s - 16);
}

function paintOverlay(
  ctx: CanvasRenderingContext2D,
  bank: SpriteBank,
  recap: RoundSplashRecap,
): void {
  const s = SCENE_SIZE;
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.save();
  ctx.translate(s / 2, 52);
  ctx.rotate((-2 * Math.PI) / 180);
  const bw = 360;
  const bh = 52;
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, "#e40058", "#000", 4);
  ctx.font = "28px \"Press Start 2P\"";
  fillLabel(ctx, recap.title, 0, 2, "#fcfcfc", 3);
  ctx.restore();

  const multi = recap.players.length > 1;
  const pw = 420;
  const ph = multi ? 250 : 210;
  const px = (s - pw) / 2;
  const py = 88;
  roundRect(ctx, px, py, pw, ph, "#000000e6", "#fcfcfc", 4);

  ctx.font = "11px \"Press Start 2P\"";
  fillLabel(ctx, "TARGETS HIT", s / 2, py + 26, "#fcfcfc", 2);
  ctx.font = "32px \"Press Start 2P\"";
  fillLabel(ctx, `${recap.hitCount}/${recap.total}`, s / 2, py + 60, "#fcb400", 4);

  const dw = 18;
  const gap = 6;
  const rowW = HUD_HIT_SLOTS * dw + (HUD_HIT_SLOTS - 1) * gap;
  let dx = Math.round((s - rowW) / 2);
  const dy = py + 80;
  for (let i = 0; i < HUD_HIT_SLOTS; i++) {
    const icon = recap.hits[i] ? bank.hud.duckRed : bank.hud.duckWhite;
    if (icon) drawSprite(ctx, icon, dx, dy, dw, dw);
    dx += dw + gap;
  }

  ctx.font = "11px \"Press Start 2P\"";
  fillLabel(ctx, "SCORE", s / 2, py + 124, "#fcfcfc", 2);
  ctx.font = "32px \"Press Start 2P\"";
  fillLabel(ctx, formatScore(recap.score), s / 2, py + 158, "#fcb400", 4);
  ctx.font = "16px \"Press Start 2P\"";
  fillLabel(ctx, formatDelta(recap.delta), s / 2, py + 186, "#fcb400", 3);

  if (multi) {
    ctx.font = "10px \"Press Start 2P\"";
    recap.players.forEach((p, i) => {
      ctx.fillStyle = p.color;
      ctx.fillText(
        `${i + 1}P  ${formatScore(p.score)}  ${formatDelta(p.delta)}`,
        s / 2,
        py + 214 + i * 16,
      );
    });
  }

  const qr = 88;
  drawQr(ctx, 28, s - qr - 28, qr);
  ctx.textAlign = "left";
  ctx.font = "10px \"Press Start 2P\"";
  fillLabel(ctx, "TRY IT ON", 132, s - 78, "#fcfcfc", 2);
  ctx.font = "16px \"Press Start 2P\"";
  fillLabel(ctx, PLAY_HOST, 132, s - 52, "#fcb400", 3);
}

function paintHowTo(ctx: CanvasRenderingContext2D): void {
  const s = SCENE_SIZE;
  ctx.imageSmoothingEnabled = false;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.save();
  ctx.translate(s / 2, 52);
  ctx.rotate((-2 * Math.PI) / 180);
  roundRect(ctx, -180, -26, 360, 52, "#e40058", "#000", 4);
  ctx.font = "28px \"Press Start 2P\"";
  fillLabel(ctx, "SHARE IT", 0, 2, "#fcfcfc", 3);
  ctx.restore();

  roundRect(ctx, 46, 92, 420, 168, "#000000e6", "#fcfcfc", 4);
  ctx.font = "11px \"Press Start 2P\"";
  fillLabel(ctx, "ON YOUR PHONE", s / 2, 122, "#fcfcfc", 2);
  ctx.font = "14px \"Press Start 2P\"";
  fillLabel(ctx, "1. OPEN THE CARD", s / 2, 158, "#fcb400", 3);
  fillLabel(ctx, "2. TAP SHARE", s / 2, 188, "#fcb400", 3);
  fillLabel(ctx, "3. PICK AN APP", s / 2, 218, "#fcb400", 3);

  const qr = 128;
  drawQr(ctx, (s - qr) / 2, 278, qr);
  ctx.font = "11px \"Press Start 2P\"";
  fillLabel(ctx, "TRY IT YOURSELF", s / 2, 430, "#fcfcfc", 2);
  ctx.font = "18px \"Press Start 2P\"";
  fillLabel(ctx, PLAY_HOST, s / 2, 458, "#fcb400", 3);
}

function paintScene(
  canvas: HTMLCanvasElement,
  bank: SpriteBank,
  recap: RoundSplashRecap,
  mode: "recap" | "howto",
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const s = SCENE_SIZE;
  canvas.width = s;
  canvas.height = s;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#5c94fc";
  ctx.fillRect(0, 0, s, s);
  paintSunburst(ctx, s);

  const meadowH = MEADOW_H * (s / MEADOW_W);
  const meadowY = s - meadowH;
  ctx.drawImage(bank.meadowBack, 0, meadowY, s, meadowH);

  const cloudA = bank.clouds[2];
  const cloudB = bank.clouds[8];
  if (cloudA) drawSprite(ctx, cloudA, 18, 36, cloudA.width * 3.2, cloudA.height * 3.2);
  if (cloudB) drawSprite(ctx, cloudB, 300, 18, cloudB.width * 2.6, cloudB.height * 2.6);

  const fly = recap.hitCount === recap.total ? bank.ducks.brown.horiz[1] : bank.ducks.blue.horiz[0];
  const fly2 = bank.ducks.black.diag[0];
  if (fly) drawSprite(ctx, fly, 318, 64, 128, 128);
  if (fly2) drawSprite(ctx, fly2, 46, 118, 96, 96, true);

  ctx.drawImage(bank.meadowFg, 0, meadowY, s, meadowH);

  const perfect = recap.hitCount === recap.total;
  const dog = perfect ? bank.dog.got2 : bank.dog.got[0];
  if (dog) {
    const cropTop = 2;
    const srcH = Math.max(1, dog.height - cropTop);
    const dh = perfect ? 210 : 176;
    const dw = (dog.width / srcH) * dh;
    const x = Math.round(s * 0.5 - dw / 2);
    const y = Math.round(s - dh * 0.9);
    ctx.drawImage(dog, 0, cropTop, dog.width, srcH, x, y, dw, dh);
  }

  if (mode === "howto") paintHowTo(ctx);
  else paintOverlay(ctx, bank, recap);
  paintFrame(ctx, s);
}

function sceneCanvas(): HTMLCanvasElement | null {
  return document.getElementById("round-splash-scene") as HTMLCanvasElement | null;
}

function refreshScene(): void {
  const scene = sceneCanvas();
  if (scene && paintedBank && paintedRecap) {
    paintScene(scene, paintedBank, paintedRecap, paintedMode);
  }
}

export function bindRoundSplash(handlers: RoundSplashHandlers): void {
  if (bound) return;
  bound = true;
  const card = document.getElementById("round-splash-card");
  const cont = document.getElementById("round-splash-continue");
  card?.addEventListener("click", () => {
    if (sharing || paintedMode === "howto" || !card) return;
    void handlers.onShare(card);
  });
  cont?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handlers.onContinue();
  });
}

export function setRoundSplashSharing(value: boolean): void {
  sharing = value;
}

export function isRoundSplashSharing(): boolean {
  return sharing;
}

export function isRoundSplashHowTo(): boolean {
  const root = document.getElementById("round-splash");
  return !!root && !root.classList.contains("hidden") && paintedMode === "howto";
}

export function roundSplashCardEl(): HTMLElement | null {
  const root = document.getElementById("round-splash");
  if (!root || root.classList.contains("hidden")) return null;
  return document.getElementById("round-splash-card");
}

function hitRect(
  el: HTMLElement | null,
  x: number,
  y: number,
  pad = 0,
): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return (
    x >= r.left - pad &&
    x <= r.right + pad &&
    y >= r.top - pad &&
    y <= r.bottom + pad
  );
}

export function roundSplashContains(x: number, y: number): boolean {
  return hitRect(roundSplashCardEl(), x, y);
}

export function roundSplashContinueContains(x: number, y: number): boolean {
  const root = document.getElementById("round-splash");
  if (!root || root.classList.contains("hidden")) return false;
  return hitRect(document.getElementById("round-splash-continue"), x, y, 10);
}

export function paintRoundSplashHover(points: ReadonlyArray<readonly [number, number]>): void {
  const card = roundSplashCardEl();
  const cont = document.getElementById("round-splash-continue");
  const root = document.getElementById("round-splash");
  if (!root || root.classList.contains("hidden")) {
    card?.classList.remove("hot");
    cont?.classList.remove("hot");
    return;
  }
  let overCard = false;
  let overCont = false;
  for (const [x, y] of points) {
    if (roundSplashContains(x, y)) overCard = true;
    if (roundSplashContinueContains(x, y)) overCont = true;
  }
  card?.classList.toggle("hot", overCard);
  cont?.classList.toggle("hot", overCont);
}

export function showRoundSplash(
  recap: RoundSplashRecap,
  bank: SpriteBank | null,
): void {
  const root = document.getElementById("round-splash");
  if (!root) return;
  paintedRecap = recap;
  paintedBank = bank;
  paintedMode = "recap";
  sharing = false;
  refreshScene();
  root.classList.remove("hidden");
  void Promise.all([document.fonts.ready, loadQr()]).then(() => refreshScene());
}

export function markRoundSplashShared(): void {
  paintedMode = "howto";
  refreshScene();
}

export function hideRoundSplash(): void {
  sharing = false;
  paintedRecap = null;
  paintedMode = "recap";
  const root = document.getElementById("round-splash");
  root?.classList.add("hidden");
  document.getElementById("round-splash-card")?.classList.remove("hot");
  document.getElementById("round-splash-continue")?.classList.remove("hot");
}

function payloadFromDataUrl(dataUrl: string): { mime: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match?.[1] || !match[2]) return { mime: "image/png", data: dataUrl };
  return { mime: match[1], data: match[2] };
}

export async function captureRoundSplashCard(): Promise<{ mime: string; data: string } | null> {
  await loadQr();
  await document.fonts.ready;
  paintedMode = "recap";
  refreshScene();
  const canvas = sceneCanvas();
  if (!canvas) return null;
  const png = canvas.toDataURL("image/png");
  paintedMode = "howto";
  refreshScene();
  return payloadFromDataUrl(png);
}
