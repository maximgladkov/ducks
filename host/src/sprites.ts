import type { DuckKind } from "./rules";

export type { DuckKind };

export type DuckFrames = {
  diag: HTMLImageElement[];
  horiz: HTMLImageElement[];
  hit: HTMLImageElement;
  fall: HTMLImageElement[];
};

export type SpriteBank = {
  meadowBack: HTMLImageElement;
  meadowFg: HTMLImageElement;
  meadowHud: HTMLImageElement;
  clouds: HTMLImageElement[];
  hud: {
    base: HTMLImageElement;
    bullet: HTMLImageElement;
    duckWhite: HTMLImageElement;
    duckRed: HTMLImageElement;
    digits: HTMLImageElement[];
  };
  ducks: Record<DuckKind, DuckFrames>;
  dog: {
    sniff: HTMLImageElement[];
    alert: HTMLImageElement[];
    jump: HTMLImageElement[];
    laugh: HTMLImageElement[];
    got: HTMLImageElement[];
    got2: HTMLImageElement;
  };
  ready: boolean;
};

const FRAME_NAMES = {
  diag: ["diag0", "diag1", "diag2"],
  horiz: ["horiz0", "horiz1", "horiz2"],
  fall: ["fall0", "fall1"],
} as const;

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}sprites/${path}`;
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${path}`));
    img.src = assetUrl(path);
  });
}

async function loadDuck(kind: DuckKind): Promise<DuckFrames> {
  const [diag, horiz, hit, fall] = await Promise.all([
    Promise.all(FRAME_NAMES.diag.map((n) => loadImage(`ducks/${kind}_${n}.png`))),
    Promise.all(FRAME_NAMES.horiz.map((n) => loadImage(`ducks/${kind}_${n}.png`))),
    loadImage(`ducks/${kind}_hit.png`),
    Promise.all(FRAME_NAMES.fall.map((n) => loadImage(`ducks/${kind}_${n}.png`))),
  ]);
  return { diag, horiz, hit, fall };
}

export async function loadSpriteBank(): Promise<SpriteBank> {
  const digitPaths = Array.from({ length: 10 }, (_, i) => `hud/digits/${i}.png`);
  const cloudPaths = [
    ...Array.from({ length: 4 }, (_, i) => `clouds/fluff${i}.png`),
    ...Array.from({ length: 6 }, (_, i) => `clouds/cloud${i + 2}.png`),
    ...Array.from({ length: 4 }, (_, i) => `clouds/c${i + 2}.png`),
  ];
  const [
    meadowBack,
    meadowFg,
    meadowHud,
    clouds,
    hudBase,
    bullet,
    duckWhite,
    duckRed,
    digits,
    black,
    brown,
    blue,
    sniff0,
    sniff1,
    sniff2,
    sniff3,
    alert0,
    jump0,
    jump1,
    laugh0,
    laugh1,
    got0,
    got1,
    got2,
  ] = await Promise.all([
    loadImage("meadow_back.png"),
    loadImage("meadow_fg.png"),
    loadImage("meadow_hud.png"),
    Promise.all(cloudPaths.map(loadImage)),
    loadImage("hud/base.png"),
    loadImage("hud/bullet.png"),
    loadImage("hud/duck_white.png"),
    loadImage("hud/duck_red.png"),
    Promise.all(digitPaths.map(loadImage)),
    loadDuck("black"),
    loadDuck("brown"),
    loadDuck("blue"),
    loadImage("dog/sniff0.png"),
    loadImage("dog/sniff1.png"),
    loadImage("dog/sniff2.png"),
    loadImage("dog/sniff3.png"),
    loadImage("dog/alert0.png"),
    loadImage("dog/jump0.png"),
    loadImage("dog/jump1.png"),
    loadImage("dog/laugh0.png"),
    loadImage("dog/laugh1.png"),
    loadImage("dog/got0.png"),
    loadImage("dog/got1.png"),
    loadImage("dog/got2.png"),
  ]);

  return {
    meadowBack,
    meadowFg,
    meadowHud,
    clouds,
    hud: {
      base: hudBase,
      bullet,
      duckWhite,
      duckRed,
      digits,
    },
    ducks: { black, brown, blue },
    dog: {
      sniff: [sniff0, sniff1, sniff2, sniff3],
      alert: [alert0],
      jump: [jump0, jump1],
      laugh: [laugh0, laugh1],
      got: [got0, got1],
      got2,
    },
    ready: true,
  };
}

export function duckFrame(
  bank: SpriteBank,
  kind: DuckKind,
  opts: {
    vx: number;
    vy: number;
    life: number;
    flash: number;
    falling: boolean;
  },
): HTMLImageElement {
  const frames = bank.ducks[kind];
  if (opts.flash > 0) return frames.hit;
  if (opts.falling) {
    return frames.fall[Math.floor(opts.life * 10) % frames.fall.length]!;
  }
  const flap = Math.floor(opts.life * 12) % 3;
  const diag = Math.abs(opts.vy) > Math.abs(opts.vx) * 0.35;
  return (diag ? frames.diag : frames.horiz)[flap]!;
}
