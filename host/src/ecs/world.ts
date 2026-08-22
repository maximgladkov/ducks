import { createWorld, type World } from "koota";
import {
  Hunt,
  Roster,
  Screen,
  Settings,
  Time,
} from "./traits";
import { DEFAULT_DEBUG_SETTINGS } from "../gameSettings";

export function createGameWorld(): World {
  const world = createWorld();
  world.add(
    Time({ dt: 0, now: 0 }),
    Screen({ w: 1920, h: 1080 }),
    Hunt({ mode: "A", stationary: false }),
    Settings(),
    Roster(),
  );
  const settings = world.get(Settings);
  if (settings) settings.aim = { ...DEFAULT_DEBUG_SETTINGS };
  return world;
}
