import { afterEach, describe, expect, it } from "vitest";
import { universe } from "koota";
import { createGameWorld } from "../src/ecs/world";
import {
  spawnHuntDuck,
  spawnStationaryGrid,
  spawnTitleDucks,
} from "../src/ecs/spawn";
import {
  aliveStationaryCount,
  collectDucks,
  duckCounts,
  hitDuck,
  markEscaping,
  stepDucks,
} from "../src/ecs/systems/ducks";
import {
  Falling,
  Flashing,
  Flying,
  Position,
  Stationary,
  Velocity,
} from "../src/ecs/traits";

const screen: [number, number] = [1920, 1080];

afterEach(() => {
  universe.reset();
});

describe("duck systems", () => {
  it("bobs title ducks in place", () => {
    const world = createGameWorld();
    spawnTitleDucks(world, screen);
    const before = collectDucks(world);
    expect(before).toHaveLength(2);
    expect(before.every((d) => d.stationary)).toBe(true);
    stepDucks(world, screen, 0.16);
    const after = collectDucks(world);
    expect(after).toHaveLength(2);
    expect(after.every((d) => d.tag === "titleA" || d.tag === "titleB")).toBe(
      true,
    );
    expect(after.some((d) => d.y !== before.find((b) => b.id === d.id)?.y)).toBe(
      true,
    );
  });

  it("flashes then falls and lands off the playfield", () => {
    const world = createGameWorld();
    const duck = spawnHuntDuck(world, screen, 1, "A", "hit");
    expect(hitDuck(world, "hit")).toBe(true);
    expect(duck.has(Flashing)).toBe(true);
    expect(duck.has(Flying)).toBe(false);
    for (let i = 0; i < 20; i++) stepDucks(world, screen, 0.05);
    expect(duck.has(Falling) || !duck.isAlive()).toBe(true);
    for (let i = 0; i < 80; i++) stepDucks(world, screen, 0.05);
    expect(collectDucks(world)).toHaveLength(0);
  });

  it("escapes off the top and reports untagged ducks", () => {
    const world = createGameWorld();
    spawnHuntDuck(world, screen, 1, "A", "fly");
    markEscaping(world);
    const flying = collectDucks(world)[0];
    expect(flying?.escaping).toBe(true);
    let escaped = 0;
    for (let i = 0; i < 80; i++) {
      const step = stepDucks(world, screen, 0.08);
      escaped += step.escaped.filter((e) => !e.tag).length;
    }
    expect(escaped).toBe(1);
    expect(collectDucks(world)).toHaveLength(0);
  });

  it("keeps a stationary grid until everything is shot", () => {
    const world = createGameWorld();
    spawnStationaryGrid(world, screen);
    expect(aliveStationaryCount(world)).toBe(12);
    expect(duckCounts(world).flying).toBe(0);
    const first = collectDucks(world)[0]!;
    hitDuck(world, first.id);
    stepDucks(world, screen, 0.02);
    expect(aliveStationaryCount(world)).toBe(11);
  });

  it("turns flying ducks at the screen edge", () => {
    const world = createGameWorld();
    const duck = spawnHuntDuck(world, screen, 1, "A", "edge");
    duck.set(Position, { x: 2, y: 80 });
    duck.set(Velocity, { vx: -400, vy: 0 });
    duck.add(Flying);
    stepDucks(world, screen, 0.016);
    const pos = duck.get(Position)!;
    const vel = duck.get(Velocity)!;
    expect(pos.x).toBeGreaterThan(2);
    expect(vel.vx).toBeGreaterThan(0);
    expect(duck.has(Stationary)).toBe(false);
  });
});
