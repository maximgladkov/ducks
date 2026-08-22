import type { Entity, World } from "koota";
import type { AimTarget, Vec2 } from "gyro-aim";
import { AimSession } from "gyro-aim";
import { colorForPlayer } from "@duckhunt/shared";
import { HUD_MAX_SHOTS } from "../hud";
import type { DuckKind, GameMode } from "../rules";
import { PLAY_H, STAGE_H, STAGE_W, duckSpeed, pickDuckKind } from "../rules";
import type { DebugSettings } from "../gameSettings";
import {
  Aim,
  Ammo,
  Crosshair,
  Duck,
  Escaping,
  Falling,
  Flashing,
  FloatScore,
  Flying,
  Life,
  Link,
  Player,
  Position,
  Radius,
  Roster,
  Score,
  Sensor,
  Stationary,
  Velocity,
  type TitleTag,
} from "./traits";

function playHOf(screen: Vec2): number {
  return screen[1] * (PLAY_H / STAGE_H);
}

function skyFloor(playH: number, pad: number): number {
  return playH * 0.62 - pad * 0.15;
}

function nextDuckId(world: World): string {
  const roster = world.get(Roster)!;
  const id = `t${roster.duckSeq}`;
  roster.duckSeq += 1;
  return id;
}

export function clearDucks(world: World): void {
  for (const entity of [...world.query(Duck)]) {
    entity.destroy();
  }
}

export function spawnHuntDuck(
  world: World,
  screen: Vec2,
  round: number,
  mode: GameMode = "A",
  id = nextDuckId(world),
): Entity {
  const kind = pickDuckKind();
  const playH = playHOf(screen);
  const speed = duckSpeed(round, kind, mode) * (screen[0] / STAGE_W);
  const angle = -Math.PI * (0.28 + Math.random() * 0.44);
  const twitch = kind === "brown" ? 1.5 : kind === "blue" ? 1.1 : 0.75;
  const turnMul = mode === "B" ? 1.7 : 1;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const radius = 22 + Math.random() * 6;
  return world.spawn(
    Duck({
      id,
      kind,
      turnIn: ((0.7 + Math.random() * 1.4) / twitch) * turnMul,
      tag: "",
    }),
    Position({
      x: screen[0] * (0.22 + Math.random() * 0.56),
      y: skyFloor(playH, radius) - 8,
    }),
    Velocity({
      vx: Math.cos(angle) * speed * dir,
      vy: Math.sin(angle) * speed,
    }),
    Radius({ r: radius }),
    Life({ t: 0 }),
    Flying,
  );
}

export function spawnWave(
  world: World,
  screen: Vec2,
  count: number,
  round: number,
  mode: GameMode,
): void {
  clearDucks(world);
  for (let i = 0; i < count; i++) {
    spawnHuntDuck(world, screen, round, mode);
  }
}

function spawnStationaryDuck(
  world: World,
  opts: {
    id: string;
    x: number;
    y: number;
    radius: number;
    kind: DuckKind;
    tag?: TitleTag;
    phase?: number;
    amp?: number;
  },
): Entity {
  const amp = opts.amp ?? 0;
  const phase = opts.phase ?? 0;
  return world.spawn(
    Duck({ id: opts.id, kind: opts.kind, turnIn: 0, tag: opts.tag ?? "" }),
    Position({ x: opts.x, y: opts.y }),
    Velocity({ vx: 0, vy: 0 }),
    Radius({ r: opts.radius }),
    Life({ t: 0 }),
    Stationary({ phase, amp, baseY: opts.y }),
  );
}

export function spawnTitleDucks(world: World, screen: Vec2): void {
  clearDucks(world);
  const playH = playHOf(screen);
  const y = playH * 0.42;
  const radius = 28;
  spawnStationaryDuck(world, {
    id: "titleA",
    x: screen[0] * 0.32,
    y,
    radius,
    kind: "black",
    tag: "titleA",
    phase: 0,
    amp: 10,
  });
  spawnStationaryDuck(world, {
    id: "titleB",
    x: screen[0] * 0.68,
    y,
    radius,
    kind: "blue",
    tag: "titleB",
    phase: Math.PI,
    amp: 10,
  });
}

export function spawnStationaryGrid(world: World, screen: Vec2): void {
  clearDucks(world);
  const cols = 4;
  const rows = 3;
  const kinds: DuckKind[] = ["black", "brown", "blue"];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      spawnStationaryDuck(world, {
        id: `s${n}`,
        x: ((c + 1) / (cols + 1)) * screen[0],
        y: ((r + 1) / (rows + 1)) * playHOf(screen) * 0.85,
        radius: 24,
        kind: kinds[n % kinds.length]!,
      });
      n += 1;
    }
  }
}

function ghost(color: string, opacity: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ghost";
  el.style.background = color;
  el.style.opacity = String(opacity);
  return el;
}

export function spawnPlayer(
  world: World,
  id: string,
  index: number,
  layer: HTMLElement,
  settings: DebugSettings,
): Entity {
  const color = colorForPlayer(index);
  const el = document.createElement("div");
  el.className = "crosshair";
  el.style.color = color;
  el.innerHTML =
    '<div class="crosshair-outer"></div><div class="crosshair-ring"></div><div class="crosshair-h"></div><div class="crosshair-v"></div><div class="crosshair-dot"></div>';
  const wedge = document.createElement("div");
  wedge.className = "wedge";
  wedge.style.color = color;
  wedge.style.display = "none";
  el.appendChild(wedge);
  const ghostRaw = ghost(color, 0.35);
  const ghostFilt = ghost(color, 0.55);
  const ghostPred = ghost("#ffffff", 0.45);
  layer.appendChild(ghostRaw);
  layer.appendChild(ghostFilt);
  layer.appendChild(ghostPred);
  layer.appendChild(el);
  const session = new AimSession({
    screen: [window.innerWidth, window.innerHeight],
    settings,
  });
  const entity = world.spawn(
    Player({ id, index, color }),
    Aim({
      session,
      packets: 0,
      lastHostReceive: 0,
      missFlash: 0,
    }),
    Score({ value: 0 }),
    Ammo({ shots: HUD_MAX_SHOTS }),
    Sensor({ ready: false, tiltDeg: 0 }),
    Link({
      transport: "websocket",
      clockOffset: 0,
      rtt: 0,
      dropped: 0,
    }),
    Crosshair({ el, wedge, ghostRaw, ghostFilt, ghostPred }),
  );
  world.get(Roster)!.players.set(id, entity);
  return entity;
}

export function despawnPlayer(world: World, id: string): void {
  const roster = world.get(Roster);
  const entity = roster?.players.get(id);
  if (!roster || !entity) return;
  const cross = entity.get(Crosshair);
  cross?.el.remove();
  cross?.ghostRaw.remove();
  cross?.ghostFilt.remove();
  cross?.ghostPred.remove();
  entity.destroy();
  roster.players.delete(id);
}

export function playerEntity(world: World, id: string): Entity | undefined {
  return world.get(Roster)?.players.get(id);
}

export function spawnFloatScore(
  world: World,
  x: number,
  y: number,
  text: string,
): Entity {
  return world.spawn(Position({ x, y }), FloatScore({ text, t: 0 }));
}

export function hittableTargets(world: World): AimTarget[] {
  const out: AimTarget[] = [];
  world.query(Duck, Position, Radius).readEach(([duck, pos, radius], entity) => {
    if (entity.has(Flashing) || entity.has(Falling) || entity.has(Escaping)) {
      return;
    }
    out.push({ id: duck.id, x: pos.x, y: pos.y, radius: radius.r });
  });
  return out;
}

export function allAimTargets(world: World): AimTarget[] {
  const out: AimTarget[] = [];
  world.query(Duck, Position, Radius).readEach(([duck, pos, radius]) => {
    out.push({ id: duck.id, x: pos.x, y: pos.y, radius: radius.r });
  });
  return out;
}

export function findDuck(world: World, id: string): Entity | undefined {
  let found: Entity | undefined;
  world.query(Duck).forEach((entity) => {
    if (entity.get(Duck)?.id === id) found = entity;
  });
  return found;
}
