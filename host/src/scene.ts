import type { SpriteBank } from "./sprites";
import { PLAY_H, STAGE_H, STAGE_W } from "./rules";
import type { DogPose } from "./machines/match";

export { STAGE_W, STAGE_H, PLAY_H };

export const HUD_H = STAGE_H - PLAY_H;

export function playfieldHeight(screenH: number): number {
  return screenH * (PLAY_H / STAGE_H);
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
  pose: Exclude<DogPose, null>,
  t: number,
  opts: { hold?: 0 | 1 | 2; walk?: number } = {},
): void {
  const playH = playfieldHeight(h);
  const scale = (w / STAGE_W) * 1.1;
  let frame: HTMLImageElement;
  if (pose === "sniff") {
    frame = bank.dog.sniff[Math.floor(t * 6) % bank.dog.sniff.length]!;
  } else if (pose === "alert") {
    frame = bank.dog.alert[0]!;
  } else if (pose === "jump") {
    frame = bank.dog.jump[Math.min(bank.dog.jump.length - 1, Math.floor(t * 8))]!;
  } else if (pose === "laugh") {
    frame = bank.dog.laugh[Math.floor(t * 6) % bank.dog.laugh.length]!;
  } else if (opts.hold === 2 && bank.dog.got2) {
    frame = bank.dog.got2;
  } else {
    frame = bank.dog.got[Math.floor(t * 6) % bank.dog.got.length]!;
  }
  const cropTop = 2;
  const srcH = Math.max(1, frame.height - cropTop);
  const dw = Math.round(frame.width * scale);
  const dh = Math.round(srcH * scale);
  let x: number;
  let y: number;
  if (pose === "sniff") {
    const walk = opts.walk ?? 1;
    x = w * (-0.08 + walk * 0.5) - dw / 2;
    y = playH - dh * 0.92;
  } else if (pose === "alert") {
    x = w * 0.42 - dw / 2;
    y = playH - dh * 0.92;
  } else if (pose === "jump") {
    const up = Math.min(1, t * 3);
    x = w * 0.46 - dw / 2;
    y = playH - dh * (0.92 + up * 0.35);
  } else {
    const rise = Math.min(1, t * 2.2);
    x = w * 0.5 - dw / 2;
    y = playH - dh * 0.92 * rise;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    frame,
    0,
    cropTop,
    frame.width,
    srcH,
    Math.round(x),
    Math.round(y),
    dw,
    dh,
  );
}
