import { describe, expect, it } from "vitest";
import {
  duckPoints,
  duckSpeed,
  ducksPerWave,
  flightDuration,
  kindFromRoll,
  passLine,
  perfectBonus,
} from "../src/rules";

describe("passLine", () => {
  it("stays at 6 through round 10, then climbs to 10", () => {
    expect(passLine(1)).toBe(6);
    expect(passLine(10)).toBe(6);
    expect(passLine(11)).toBe(7);
    expect(passLine(12)).toBe(7);
    expect(passLine(13)).toBe(8);
    expect(passLine(14)).toBe(8);
    expect(passLine(15)).toBe(9);
    expect(passLine(19)).toBe(9);
    expect(passLine(20)).toBe(10);
    expect(passLine(99)).toBe(10);
  });
});

describe("duckPoints", () => {
  it("uses color and round bands", () => {
    expect(duckPoints(1, "black")).toBe(500);
    expect(duckPoints(1, "blue")).toBe(1000);
    expect(duckPoints(1, "brown")).toBe(1500);
    expect(duckPoints(6, "black")).toBe(800);
    expect(duckPoints(6, "blue")).toBe(1600);
    expect(duckPoints(6, "brown")).toBe(2400);
    expect(duckPoints(11, "black")).toBe(1000);
    expect(duckPoints(11, "blue")).toBe(2000);
    expect(duckPoints(11, "brown")).toBe(3000);
  });
});

describe("perfectBonus", () => {
  it("steps up with later rounds", () => {
    expect(perfectBonus(1)).toBe(10000);
    expect(perfectBonus(10)).toBe(10000);
    expect(perfectBonus(11)).toBe(15000);
    expect(perfectBonus(16)).toBe(20000);
    expect(perfectBonus(21)).toBe(30000);
  });
});

describe("flightDuration", () => {
  it("shrinks from about 11.5s to 5.1s", () => {
    expect(flightDuration(1)).toBeCloseTo(11.5, 5);
    expect(flightDuration(20)).toBeCloseTo(5.1, 5);
    expect(flightDuration(40)).toBeCloseTo(5.1, 5);
  });
});

describe("duckSpeed", () => {
  it("is faster for blue and brown, and later rounds", () => {
    expect(duckSpeed(1, "black")).toBeCloseTo(55, 5);
    expect(duckSpeed(1, "blue")).toBeGreaterThan(duckSpeed(1, "black"));
    expect(duckSpeed(1, "brown")).toBeGreaterThan(duckSpeed(1, "blue"));
    expect(duckSpeed(27, "black")).toBeCloseTo(165, 5);
    expect(duckSpeed(27, "black")).toBeGreaterThan(duckSpeed(1, "black"));
    expect(duckSpeed(1, "black", "B")).toBeCloseTo(38.5, 5);
    expect(duckSpeed(1, "black", "B")).toBeLessThan(duckSpeed(1, "black", "A"));
  });
});

describe("kindFromRoll", () => {
  it("weights black most, then blue, then brown", () => {
    expect(kindFromRoll(0)).toBe("black");
    expect(kindFromRoll(0.59)).toBe("black");
    expect(kindFromRoll(0.6)).toBe("blue");
    expect(kindFromRoll(0.89)).toBe("blue");
    expect(kindFromRoll(0.9)).toBe("brown");
  });
});

describe("ducksPerWave", () => {
  it("is 1 for Game A and 2 for Game B", () => {
    expect(ducksPerWave("A")).toBe(1);
    expect(ducksPerWave("B")).toBe(2);
  });
});
