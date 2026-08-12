import type { SpriteBank } from "./sprites";

export const NES_W = 256;
export const NES_H = 240;
export const NES_PLAY_H = 184;
export const NES_HUD_H = NES_H - NES_PLAY_H;

export function playfieldHeight(screenH: number): number {
  return screenH * (NES_PLAY_H / NES_H);
}

export function drawMeadowBack(
  ctx: CanvasRenderingContext2D,
  bank: SpriteBank,
  w: number,
  h: number,
): void {
  const playH = playfieldHeight(h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bank.meadowBack, 0, 0, w, playH);
}

export function drawMeadowFg(
  ctx: CanvasRenderingContext2D,
  bank: SpriteBank,
  w: number,
  h: number,
): void {
  const playH = playfieldHeight(h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bank.meadowFg, 0, 0, w, playH);
}

export function drawDog(
  ctx: CanvasRenderingContext2D,
  bank: SpriteBank,
  w: number,
  h: number,
  mode: "laugh" | "got",
  t: number,
): void {
  const playH = playfieldHeight(h);
  const frames = mode === "laugh" ? bank.dog.laugh : bank.dog.got;
  const frame = frames[Math.floor(t * 6) % frames.length]!;
  const scale = (w / NES_W) * 1.1;
  const dw = frame.width * scale;
  const dh = frame.height * scale;
  const rise = Math.min(1, t * 2.2);
  const x = w * 0.5 - dw / 2;
  const y = playH - dh * 0.92 * rise;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame, x, y, dw, dh);
}
