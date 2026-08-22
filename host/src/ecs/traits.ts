import { trait } from "koota";
import type { AimSession } from "gyro-aim";
import type { TransportKind } from "@duckhunt/shared";
import type { DuckKind, GameMode } from "../rules";
import {
  DEFAULT_DEBUG_SETTINGS,
  type DebugSettings,
} from "../gameSettings";

export type TitleTag = "titleA" | "titleB";

export const Time = trait({ dt: 0, now: 0 });
export const Screen = trait({ w: 1920, h: 1080 });
export const Hunt = trait({
  mode: "A" as GameMode,
  stationary: false,
});
export const Settings = trait(() => ({
  aim: { ...DEFAULT_DEBUG_SETTINGS } as DebugSettings,
}));
export const Roster = trait(() => ({
  duckSeq: 0,
  players: new Map<string, import("koota").Entity>(),
}));

export const Position = trait({ x: 0, y: 0 });
export const Velocity = trait({ vx: 0, vy: 0 });
export const Radius = trait({ r: 24 });
export const Life = trait({ t: 0 });

export const Duck = trait({
  id: "",
  kind: "black" as DuckKind,
  turnIn: 0,
  tag: "" as "" | TitleTag,
});

export const Flying = trait();
export const Flashing = trait({ t: 0 });
export const Falling = trait();
export const Escaping = trait();
export const Stationary = trait({ phase: 0, amp: 0, baseY: 0 });

export const FloatScore = trait({ text: "", t: 0 });

export const Player = trait({
  id: "",
  index: 0,
  color: "",
});

export const Aim = trait(() => ({
  session: null as unknown as AimSession,
  packets: 0,
  lastHostReceive: 0,
  missFlash: 0,
}));

export const Score = trait({ value: 0 });
export const Ammo = trait({ shots: 3 });
export const Sensor = trait({ ready: false, tiltDeg: 0 });
export const Link = trait({
  transport: "websocket" as TransportKind,
  clockOffset: 0,
  rtt: 0,
  dropped: 0,
});

export const Crosshair = trait(() => ({
  el: null as unknown as HTMLDivElement,
  wedge: null as unknown as HTMLDivElement,
  ghostRaw: null as unknown as HTMLDivElement,
  ghostFilt: null as unknown as HTMLDivElement,
  ghostPred: null as unknown as HTMLDivElement,
}));
