import type { SpriteBank } from "./sprites";

export type SkyCloud = {
  x: number;
  y: number;
  speed: number;
  sprite: number;
  scale: number;
  bobPhase: number;
  bobSpeed: number;
};

let screenW = 1280;
let screenH = 720;

export function setCloudScreen(w: number, h: number): void {
  screenW = Math.max(1, w);
  screenH = Math.max(1, h);
}

export function createSkyClouds(count = 8): SkyCloud[] {
  return Array.from({ length: count }, () => spawnCloud(true));
}

function spawnCloud(initial: boolean): SkyCloud {
  const playH = screenH * (184 / 240);
  const sprite = Math.floor(Math.random() * 16);
  const scale = 2.2 + Math.random() * 3.5;
  const speed = (8 + Math.random() * 16) * (Math.random() < 0.5 ? 1 : -1);
  return {
    x: initial
      ? Math.random() * (screenW + 80) - 40
      : speed > 0
        ? -80
        : screenW + 40,
    y: 20 + Math.random() * (playH * 0.48),
    speed,
    sprite,
    scale,
    bobPhase: Math.random() * Math.PI * 2,
    bobSpeed: 0.25 + Math.random() * 0.55,
  };
}

export function updateSkyClouds(clouds: SkyCloud[], dt: number): void {
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i]!;
    c.x += c.speed * dt;
    c.bobPhase += dt * c.bobSpeed;
    if (c.speed > 0 && c.x > screenW + 80) {
      clouds[i] = spawnCloud(false);
      clouds[i]!.speed = Math.abs(clouds[i]!.speed);
      clouds[i]!.x = -80;
    } else if (c.speed < 0 && c.x < -80) {
      clouds[i] = spawnCloud(false);
      clouds[i]!.speed = -Math.abs(clouds[i]!.speed);
      clouds[i]!.x = screenW + 40;
    }
  }
}

export function drawSkyClouds(
  ctx: CanvasRenderingContext2D,
  bank: SpriteBank,
  clouds: SkyCloud[],
): void {
  if (!bank.clouds.length) return;
  ctx.imageSmoothingEnabled = false;
  for (const c of clouds) {
    const img = bank.clouds[c.sprite % bank.clouds.length]!;
    const dw = img.width * c.scale;
    const dh = img.height * c.scale;
    const y = c.y + Math.sin(c.bobPhase) * 3;
    ctx.drawImage(img, c.x, y, dw, dh);
  }
}
