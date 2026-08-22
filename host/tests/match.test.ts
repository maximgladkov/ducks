import { describe, expect, it } from "vitest";
import {
  DOG_SHOW,
  FLY_AWAY_TIME,
  INTRO_DURATION,
  PASS_INTERLUDE,
  PERFECT_TIME,
  START_JINGLE,
  canShoot,
  chooseMode,
  consumeShot,
  createMatch,
  enterTitle,
  matchContext,
  matchPhase,
  noteSpawned,
  recordHit,
  recordMiss,
  tickMatch,
  type MatchActor,
} from "../src/machines/match";

const none = { flying: 0, flashing: 0, falling: 0, escaping: 0 };
const oneFlying = { flying: 1, flashing: 0, falling: 0, escaping: 0 };

function startIntro(): MatchActor {
  const m = createMatch();
  enterTitle(m);
  chooseMode(m, "A");
  const cues = tickMatch(m, START_JINGLE + 0.01, none);
  expect(matchPhase(m)).toBe("intro");
  expect(cues).toContainEqual({ type: "music", name: "dog" });
  return m;
}

function startWaveA(): MatchActor {
  const m = startIntro();
  const cues = tickMatch(m, INTRO_DURATION + 0.01, none);
  expect(matchPhase(m)).toBe("wave");
  expect(cues.some((c) => c.type === "spawnWave")).toBe(true);
  noteSpawned(m);
  return m;
}

describe("match", () => {
  it("starts in lobby and title after enterTitle", () => {
    const m = createMatch();
    expect(matchPhase(m)).toBe("lobby");
    const cues = enterTitle(m);
    expect(matchPhase(m)).toBe("title");
    expect(cues).toEqual([
      { type: "spawnTitle" },
      { type: "music", name: "title" },
    ]);
  });

  it("plays the start jingle before the dog intro", () => {
    const m = createMatch();
    enterTitle(m);
    const start = chooseMode(m, "A");
    expect(matchPhase(m)).toBe("start");
    expect(start).toEqual([{ type: "sfx", name: "start" }]);
    expect(canShoot(m)).toBe(false);
    tickMatch(m, 1, none);
    expect(matchPhase(m)).toBe("start");
    tickMatch(m, START_JINGLE, none);
    expect(matchPhase(m)).toBe("intro");
    expect(matchContext(m).dogPose).toBe("sniff");
  });

  it("runs the dog intro then opens a one-duck wave for Game A", () => {
    const m = startIntro();
    expect(canShoot(m)).toBe(false);
    tickMatch(m, 1, none);
    expect(matchContext(m).dogPose).toBe("sniff");
    tickMatch(m, 1.5, none);
    expect(matchContext(m).dogPose).toBe("alert");
    const cues = tickMatch(m, INTRO_DURATION, none);
    expect(matchPhase(m)).toBe("wave");
    expect(matchContext(m).waveQuota).toBe(1);
    expect(matchContext(m).shots).toBe(3);
    expect(cues).toContainEqual({ type: "spawnWave", count: 1 });
    expect(cues).toContainEqual({ type: "music", name: "duck" });
  });

  it("opens a two-duck wave for Game B", () => {
    const m = createMatch();
    enterTitle(m);
    chooseMode(m, "B");
    tickMatch(m, START_JINGLE + 0.01, none);
    const cues = tickMatch(m, INTRO_DURATION + 0.01, none);
    expect(cues).toContainEqual({ type: "spawnWave", count: 2 });
    expect(matchContext(m).waveQuota).toBe(2);
  });

  it("spends shared wave ammo and fly-away when shots run out", () => {
    const m = startWaveA();
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(false);
    const cues = tickMatch(m, 0.016, oneFlying);
    expect(matchPhase(m)).toBe("resolve");
    expect(matchContext(m).banner).toBe("FLY AWAY");
    expect(matchContext(m).skyTint).toBe(true);
    expect(cues).toContainEqual({ type: "startFlyAway" });
    expect(cues).toContainEqual({ type: "sfx", name: "miss" });
  });

  it("holds fly-away until the miss jingle finishes", () => {
    const m = startWaveA();
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    tickMatch(m, 0.016, oneFlying);
    expect(matchPhase(m)).toBe("resolve");
    tickMatch(m, FLY_AWAY_TIME - 0.1, none);
    expect(matchPhase(m)).toBe("resolve");
    tickMatch(m, 0.2, none);
    expect(matchPhase(m)).toBe("dog");
    expect(matchContext(m).dogPose).toBe("laugh");
  });

  it("does not tint the sky on Game B fly-away", () => {
    const m = createMatch();
    enterTitle(m);
    chooseMode(m, "B");
    tickMatch(m, START_JINGLE + 0.01, none);
    tickMatch(m, INTRO_DURATION + 0.01, none);
    noteSpawned(m);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    expect(consumeShot(m)).toBe(true);
    tickMatch(m, 0.016, { flying: 2, flashing: 0, falling: 0, escaping: 0 });
    expect(matchContext(m).skyTint).toBe(false);
    expect(matchContext(m).banner).toBe("FLY AWAY");
  });

  it("shows the dog after the last duck is gone, then starts the next wave", () => {
    const m = startWaveA();
    recordHit(m, 500);
    const toDog = tickMatch(m, 0.016, none);
    expect(matchPhase(m)).toBe("dog");
    expect(matchContext(m).dogPose).toBe("got");
    expect(toDog).toContainEqual({ type: "sfx", name: "got" });
    const next = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(matchPhase(m)).toBe("wave");
    expect(matchContext(m).waveIndex).toBe(2);
    expect(next).toContainEqual({ type: "spawnWave", count: 1 });
  });

  it("game-overs when the pass line is missed", () => {
    const m = startWaveA();
    for (let i = 0; i < 10; i++) recordMiss(m);
    tickMatch(m, 0.016, none);
    const cues = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(matchPhase(m)).toBe("gameOver");
    expect(matchContext(m).banner).toBe("GAME OVER");
    expect(cues).toContainEqual({ type: "sfx", name: "gameover" });
  });

  it("awards a perfect bonus and advances after a clean round", () => {
    const m = startWaveA();
    for (let i = 0; i < 10; i++) recordHit(m, 500);
    expect(matchContext(m).score).toBe(5000);
    tickMatch(m, 0.016, none);
    const cues = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(matchContext(m).banner).toBe("PERFECT");
    expect(matchPhase(m)).toBe("interlude");
    expect(cues).toContainEqual({ type: "perfect", bonus: 10000 });
    expect(matchContext(m).score).toBe(15000);
    tickMatch(m, PERFECT_TIME + 0.01, none);
    expect(matchPhase(m)).toBe("wave");
    expect(matchContext(m).round).toBe(2);
    expect(matchContext(m).resolved).toBe(0);
  });

  it("plays count and clear when a round is passed without a perfect", () => {
    const m = startWaveA();
    for (let i = 0; i < 6; i++) recordHit(m, 500);
    for (let i = 0; i < 4; i++) recordMiss(m);
    tickMatch(m, 0.016, none);
    const cues = tickMatch(m, DOG_SHOW + 0.01, none);
    expect(matchPhase(m)).toBe("interlude");
    expect(cues).toContainEqual({ type: "sfx", name: "count" });
    expect(cues).toContainEqual({ type: "sfx", name: "clear" });
    tickMatch(m, PASS_INTERLUDE + 0.01, none);
    expect(matchPhase(m)).toBe("wave");
    expect(matchContext(m).round).toBe(2);
  });

  it("allows a title or game-over shot without consuming wave ammo", () => {
    const m = createMatch();
    enterTitle(m);
    expect(canShoot(m)).toBe(true);
    expect(consumeShot(m)).toBe(false);
  });
});
