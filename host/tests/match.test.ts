import { describe, expect, it } from "vitest";
import {
  BANNER_TIME,
  DOG_SHOW,
  INTRO_DURATION,
  canShoot,
  chooseMode,
  consumeShot,
  createMatch,
  enterTitle,
  noteSpawned,
  recordHit,
  recordMiss,
  tickMatch,
} from "../src/match";

const none = { flying: 0, flashing: 0, falling: 0, escaping: 0 };
const oneFlying = { flying: 1, flashing: 0, falling: 0, escaping: 0 };

function startWaveA() {
  const m = createMatch();
  enterTitle(m);
  chooseMode(m, "A");
  const cues = tickMatch(m, INTRO_DURATION + 0.01, none);
  expect(m.phase).toBe("wave");
  expect(cues.some((c) => c.type === "spawnWave")).toBe(true);
  noteSpawned(m);
  return m;
}

describe("match", () => {
  it("starts in lobby and title after enterTitle", () => {
    const m = createMatch();
    expect(m.phase).toBe("lobby");
    const cues = enterTitle(m);
    expect(m.phase).toBe("title");
    expect(cues).toEqual([{ type: "spawnTitle" }]);
  });

  it("runs the dog intro then opens a one-duck wave for Game A", () => {
    const m = createMatch();
    enterTitle(m);
    chooseMode(m, "A");
    expect(m.phase).toBe("intro");
    expect(canShoot(m)).toBe(false);
    tickMatch(m, 1, none);
    expect(m.dogPose).toBe("sniff");
    tickMatch(m, 1.5, none);
    expect(m.dogPose).toBe("alert");
    const cues = tickMatch(m, INTRO_DURATION, none);
    expect(m.phase).toBe("wave");
    expect(m.waveQuota).toBe(1);
    expect(m.shots).toBe(3);
    expect(cues).toContainEqual({ type: "spawnWave", count: 1 });
  });

  it("opens a two-duck wave for Game B", () => {
    const m = createMatch();
    enterTitle(m);
    chooseMode(m, "B");
    const cues = tickMatch(m, INTRO_DURATION + 0.01, none);
    expect(cues).toContainEqual({ type: "spawnWave", count: 2 });
    expect(m.waveQuota).toBe(2);
  });

  it("spends shared wave ammo and fly-away when shots run out", () => {
    const m = startWaveA();
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(false);
    const cues = tickMatch(m, 0.016, oneFlying);
    expect(m.phase).toBe("resolve");
    expect(m.banner).toBe("FLY AWAY");
    expect(m.skyTint).toBe(true);
    expect(cues).toContainEqual({ type: "startFlyAway" });
  });

  it("does not tint the sky on Game B fly-away", () => {
    const m = createMatch();
    enterTitle(m);
    chooseMode(m, "B");
    tickMatch(m, INTRO_DURATION + 0.01, none);
    noteSpawned(m);
    m.shots = 0;
    tickMatch(m, 0.016, { flying: 2, flashing: 0, falling: 0, escaping: 0 });
    expect(m.skyTint).toBe(false);
    expect(m.banner).toBe("FLY AWAY");
  });

  it("shows the dog after the last duck is gone, then starts the next wave", () => {
    const m = startWaveA();
    recordHit(m, 500);
    const toDog = tickMatch(m, 0.016, none);
    expect(m.phase).toBe("dog");
    expect(m.dogPose).toBe("got");
    expect(toDog).toContainEqual({ type: "sfx", name: "got" });
    const next = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(m.phase).toBe("wave");
    expect(m.waveIndex).toBe(2);
    expect(next).toContainEqual({ type: "spawnWave", count: 1 });
  });

  it("game-overs when the pass line is missed", () => {
    const m = startWaveA();
    for (let i = 0; i < 10; i++) recordMiss(m);
    tickMatch(m, 0.016, none);
    tickMatch(m, DOG_SHOW + 0.01, none);
    expect(m.phase).toBe("gameOver");
    expect(m.banner).toBe("GAME OVER");
  });

  it("awards a perfect bonus and advances after a clean round", () => {
    const m = startWaveA();
    for (let i = 0; i < 10; i++) recordHit(m, 500);
    expect(m.score).toBe(5000);
    tickMatch(m, 0.016, none);
    const cues = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(m.banner).toBe("PERFECT");
    expect(m.phase).toBe("interlude");
    expect(cues).toContainEqual({ type: "perfect", bonus: 10000 });
    expect(m.score).toBe(15000);
    tickMatch(m, BANNER_TIME + 0.01, none);
    expect(m.phase).toBe("wave");
    expect(m.round).toBe(2);
    expect(m.resolved).toBe(0);
  });

  it("allows a title or game-over shot without consuming wave ammo", () => {
    const m = createMatch();
    enterTitle(m);
    expect(canShoot(m)).toBe(true);
    expect(consumeShot(m)).toBe(false);
  });
});
