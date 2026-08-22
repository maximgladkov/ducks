import type { World } from "koota";
import type { Vec2 } from "gyro-aim";
import {
  PLAY_H,
  STAGE_H,
  STAGE_W,
  duckSpeed,
  type DuckKind,
  type GameMode,
} from "../../rules";
import {
  Duck,
  Escaping,
  Falling,
  Flashing,
  Flying,
  Life,
  Position,
  Radius,
  Stationary,
  Velocity,
} from "../traits";

function playHOf(screen: Vec2): number {
  return screen[1] * (PLAY_H / STAGE_H);
}

function skyFloor(playH: number, pad: number): number {
  return playH * 0.62 - pad * 0.15;
}

export type DuckCounts = {
  flying: number;
  flashing: number;
  falling: number;
  escaping: number;
};

export function duckCounts(world: World): DuckCounts {
  let flying = 0;
  let flashing = 0;
  let falling = 0;
  let escaping = 0;
  world.query(Duck).forEach((entity) => {
    if (entity.get(Duck)?.tag) return;
    if (entity.has(Flashing)) flashing += 1;
    else if (entity.has(Falling)) falling += 1;
    else if (entity.has(Escaping)) escaping += 1;
    else if (!entity.has(Stationary)) flying += 1;
  });
  return { flying, flashing, falling, escaping };
}

export function markEscaping(world: World): void {
  for (const entity of [...world.query(Flying, Velocity)]) {
    const vel = entity.get(Velocity)!;
    const speed = Math.max(160, Math.hypot(vel.vx, vel.vy) * 1.25);
    entity.set(Velocity, { vx: vel.vx * 0.25, vy: -speed });
    entity.remove(Flying);
    entity.add(Escaping);
  }
}

export function hitDuck(world: World, id: string): boolean {
  const match = [...world.query(Duck)].find((entity) => entity.get(Duck)?.id === id);
  if (!match) return false;
  if (match.has(Flashing) || match.has(Falling)) return false;
  const vel = match.get(Velocity);
  if (vel) match.set(Velocity, { vx: vel.vx * 0.2, vy: vel.vy });
  match.remove(Flying);
  match.remove(Stationary);
  match.add(Flashing({ t: 1 }));
  return true;
}

export type DuckStepResult = {
  escaped: { tag: string }[];
  landed: number;
};

export function stepDucks(
  world: World,
  screen: Vec2,
  dt: number,
  mode: GameMode = "A",
): DuckStepResult {
  const playH = playHOf(screen);
  const escaped: { tag: string }[] = [];
  let landed = 0;

  world.query(Life).updateEach(([life]) => {
    life.t += dt;
  });

  world.query(Flashing, Velocity).updateEach(([flash, vel], entity) => {
    flash.t = Math.max(0, flash.t - dt * 3.5);
    if (flash.t <= 0) {
      entity.remove(Flashing);
      entity.add(Falling);
      vel.vy = 80;
    }
  });

  world.query(Falling, Position, Velocity).updateEach(([pos, vel]) => {
    vel.vy += 520 * dt;
    pos.y += vel.vy * dt;
    vel.vx *= 0.98;
    pos.x += vel.vx * dt * 0.25;
  });
  for (const entity of [...world.query(Falling, Position)]) {
    const pos = entity.get(Position)!;
    if (pos.y >= playH + 40) {
      entity.destroy();
      landed += 1;
    }
  }

  world.query(Escaping, Position, Velocity).updateEach(([pos, vel]) => {
    pos.y += vel.vy * dt;
    pos.x += vel.vx * dt;
  });
  for (const entity of [...world.query(Escaping, Position, Duck)]) {
    const pos = entity.get(Position)!;
    if (pos.y <= -80) {
      escaped.push({ tag: entity.get(Duck)!.tag });
      entity.destroy();
    }
  }

  world.query(Stationary, Position, Velocity, Life).updateEach(([stat, pos, vel, life]) => {
    if (stat.amp > 0) {
      pos.y = (stat.baseY || pos.y) + Math.sin(life.t * 2.2 + stat.phase) * stat.amp;
      vel.vy = Math.cos(life.t * 2.2 + stat.phase) * stat.amp * 2.2;
    }
  });

  world
    .query(Flying, Position, Velocity, Radius, Duck)
    .updateEach(([pos, vel, radius, duck]) => {
      duck.turnIn -= dt;
      if (duck.turnIn <= 0) {
        const speed =
          Math.hypot(vel.vx, vel.vy) ||
          duckSpeed(1, duck.kind, mode) * (screen[0] / STAGE_W);
        const twitch = duck.kind === "brown" ? 1.5 : duck.kind === "blue" ? 1.1 : 0.75;
        const turnMul = mode === "B" ? 1.7 : 1;
        const spread = mode === "B" ? 0.7 : 1.05;
        const heading =
          Math.atan2(vel.vy, vel.vx) + (Math.random() - 0.5) * Math.PI * spread;
        vel.vx = Math.cos(heading) * speed;
        vel.vy = Math.sin(heading) * speed;
        duck.turnIn = ((0.7 + Math.random() * 1.4) / twitch) * turnMul;
      }
      pos.x += vel.vx * dt;
      pos.y += vel.vy * dt;
      const pad = radius.r;
      if (pos.x < pad) {
        pos.x = pad;
        vel.vx = Math.abs(vel.vx);
      } else if (pos.x > screen[0] - pad) {
        pos.x = screen[0] - pad;
        vel.vx = -Math.abs(vel.vx);
      }
      const floor = skyFloor(playH, pad);
      if (pos.y < pad) {
        pos.y = pad;
        vel.vy = Math.abs(vel.vy);
      } else if (pos.y > floor) {
        pos.y = floor;
        vel.vy = -Math.abs(vel.vy);
      }
    });

  return { escaped, landed };
}

export function aliveStationaryCount(world: World): number {
  let n = 0;
  world.query(Stationary).forEach((entity) => {
    if (!entity.has(Falling) && !entity.has(Flashing)) n += 1;
  });
  return n;
}

export type DuckView = {
  id: string;
  x: number;
  y: number;
  radius: number;
  vx: number;
  vy: number;
  life: number;
  flash: number;
  falling: boolean;
  escaping: boolean;
  stationary: boolean;
  kind: DuckKind;
  tag: "" | "titleA" | "titleB";
};

export function collectDucks(world: World): DuckView[] {
  const out: DuckView[] = [];
  world.query(Duck, Position, Velocity, Radius, Life).readEach(
    ([duck, pos, vel, radius, life], entity) => {
      out.push({
        id: duck.id,
        x: pos.x,
        y: pos.y,
        radius: radius.r,
        vx: vel.vx,
        vy: vel.vy,
        life: life.t,
        flash: entity.get(Flashing)?.t ?? 0,
        falling: entity.has(Falling),
        escaping: entity.has(Escaping),
        stationary: entity.has(Stationary),
        kind: duck.kind,
        tag: duck.tag,
      });
    },
  );
  return out;
}
