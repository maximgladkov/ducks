import { assign, createActor, setup, type ActorRefFrom } from "xstate";
import {
  HIT_SLOTS,
  WAVE_SHOTS,
  ducksPerWave,
  flightDuration,
  passLine,
  perfectBonus,
  type GameMode,
} from "../rules";

export type MatchPhase =
  | "lobby"
  | "title"
  | "start"
  | "intro"
  | "wave"
  | "resolve"
  | "dog"
  | "interlude"
  | "gameOver";

export type DogPose = "sniff" | "alert" | "jump" | "got" | "laugh" | null;

export type DuckCounts = {
  flying: number;
  flashing: number;
  falling: number;
  escaping: number;
};

export type SfxName =
  | "got"
  | "laugh"
  | "miss"
  | "clear"
  | "gameover"
  | "count"
  | "start";

export type MusicName = "title" | "dog" | "duck" | "stop";

export type MatchCue =
  | { type: "spawnTitle" }
  | { type: "spawnWave"; count: number }
  | { type: "startFlyAway" }
  | { type: "ammo" }
  | { type: "sfx"; name: SfxName }
  | { type: "music"; name: MusicName }
  | { type: "perfect"; bonus: number }
  | { type: "roundSplash" };

export type MatchContext = {
  mode: GameMode | null;
  round: number;
  waveIndex: number;
  shots: number;
  hits: boolean[];
  resolved: number;
  score: number;
  roundStartScore: number;
  waveHits: number;
  waveMisses: number;
  waveQuota: number;
  phaseT: number;
  flightT: number;
  flightLimit: number;
  awaitingDucks: boolean;
  skyTint: boolean;
  banner: string | null;
  dogPose: DogPose;
  dogHold: 0 | 1 | 2;
  emitted: MatchCue[];
};

export type MatchEvent =
  | { type: "ENTER_TITLE" }
  | { type: "CHOOSE_MODE"; mode: GameMode }
  | { type: "TICK"; dt: number; counts: DuckCounts }
  | { type: "SHOT" }
  | { type: "HIT"; points: number }
  | { type: "MISS" }
  | { type: "NOTE_SPAWNED" }
  | { type: "CONTINUE" };

export const INTRO_SNIFF = 2.4;
export const INTRO_ALERT = 0.55;
export const INTRO_JUMP = 0.45;
export const INTRO_DURATION = INTRO_SNIFF + INTRO_ALERT + INTRO_JUMP;
export const START_JINGLE = 6.5;
export const DOG_SHOW = 2.5;
export const COUNT_TIME = 1.27;
export const CLEAR_TIME = 4.51;
export const PASS_INTERLUDE = COUNT_TIME + CLEAR_TIME;
export const PERFECT_TIME = 2.45;
export const FLY_AWAY_TIME = 4.51;

function emptyHits(): boolean[] {
  return Array.from({ length: HIT_SLOTS }, () => false);
}

function none(): DuckCounts {
  return { flying: 0, flashing: 0, falling: 0, escaping: 0 };
}

function activeDucks(c: DuckCounts): number {
  return c.flying + c.flashing + c.falling + c.escaping;
}

function tickDt(event: MatchEvent): number {
  return event.type === "TICK" ? event.dt : 0;
}

function tickCounts(event: MatchEvent): DuckCounts {
  return event.type === "TICK" ? event.counts : none();
}

const initialContext: MatchContext = {
  mode: null,
  round: 1,
  waveIndex: 0,
  shots: WAVE_SHOTS,
  hits: emptyHits(),
  resolved: 0,
  score: 0,
  roundStartScore: 0,
  waveHits: 0,
  waveMisses: 0,
  waveQuota: 1,
  phaseT: 0,
  flightT: 0,
  flightLimit: flightDuration(1),
  awaitingDucks: false,
  skyTint: false,
  banner: null,
  dogPose: null,
  dogHold: 0,
  emitted: [],
};

export const matchMachine = setup({
  types: {
    context: {} as MatchContext,
    events: {} as MatchEvent,
  },
  guards: {
    startDone: ({ context, event }) =>
      context.phaseT + tickDt(event) >= START_JINGLE,
    introSniffDone: ({ context }) => context.phaseT >= INTRO_SNIFF,
    introAlertDone: ({ context }) =>
      context.phaseT >= INTRO_SNIFF + INTRO_ALERT,
    introDone: ({ context, event }) =>
      context.phaseT + tickDt(event) >= INTRO_DURATION,
    flyAway: ({ context, event }) => {
      const counts = tickCounts(event);
      return (
        !context.awaitingDucks &&
        counts.flying > 0 &&
        (context.shots <= 0 || context.flightT + tickDt(event) >= context.flightLimit)
      );
    },
    waveClear: ({ context, event }) =>
      !context.awaitingDucks && activeDucks(tickCounts(event)) === 0,
    resolveDone: ({ context, event }) =>
      activeDucks(tickCounts(event)) === 0 &&
      context.phaseT + tickDt(event) >= FLY_AWAY_TIME,
    dogDone: ({ context, event }) => context.phaseT + tickDt(event) >= DOG_SHOW,
    roundOver: ({ context }) => context.resolved >= HIT_SLOTS,
    failedPass: ({ context }) =>
      context.hits.filter(Boolean).length < passLine(context.round),
    isPerfect: ({ context }) =>
      context.hits.filter(Boolean).length === HIT_SLOTS,
    canSpendShot: ({ context }) => context.shots > 0,
  },
  actions: {
    clearEmitted: assign({ emitted: [] }),
    addPhaseT: assign({
      phaseT: ({ context, event }) => context.phaseT + tickDt(event),
      emitted: [],
    }),
    addFlightT: assign({
      flightT: ({ context, event }) =>
        context.awaitingDucks ? context.flightT : context.flightT + tickDt(event),
    }),
    enterTitle: assign({
      mode: null,
      phaseT: 0,
      waveIndex: 0,
      shots: WAVE_SHOTS,
      skyTint: false,
      banner: null,
      dogPose: null,
      dogHold: 0,
      awaitingDucks: false,
      emitted: [
        { type: "spawnTitle" },
        { type: "music", name: "title" },
      ] as MatchCue[],
    }),
    chooseMode: assign({
      mode: ({ event }) => (event.type === "CHOOSE_MODE" ? event.mode : null),
      round: 1,
      score: 0,
      roundStartScore: 0,
      hits: () => emptyHits(),
      resolved: 0,
      waveIndex: 0,
      skyTint: false,
      banner: null,
      phaseT: 0,
      dogPose: null,
      dogHold: 0,
      shots: 0,
      awaitingDucks: false,
      emitted: [{ type: "sfx", name: "start" }] as MatchCue[],
    }),
    beginIntro: assign({
      phaseT: 0,
      dogPose: "sniff" as const,
      dogHold: 0,
      shots: 0,
      emitted: [{ type: "music", name: "dog" }] as MatchCue[],
    }),
    setSniff: assign({ dogPose: "sniff" as const }),
    setAlert: assign({ dogPose: "alert" as const }),
    setJump: assign({ dogPose: "jump" as const }),
    beginWave: assign({
      phaseT: 0,
      flightT: 0,
      flightLimit: ({ context }) => flightDuration(context.round),
      shots: WAVE_SHOTS,
      waveHits: 0,
      waveMisses: 0,
      waveQuota: ({ context }) => ducksPerWave(context.mode ?? "A"),
      waveIndex: ({ context }) => context.waveIndex + 1,
      awaitingDucks: true,
      skyTint: false,
      banner: null,
      dogPose: null,
      dogHold: 0,
      emitted: ({ context }) =>
        [
          { type: "spawnWave", count: ducksPerWave(context.mode ?? "A") },
          { type: "ammo" },
          { type: "music", name: "duck" },
        ] as MatchCue[],
    }),
    startFlyAway: assign({
      phaseT: 0,
      skyTint: ({ context }) => context.mode === "A",
      banner: "FLY AWAY",
      emitted: [
        { type: "startFlyAway" },
        { type: "music", name: "stop" },
        { type: "sfx", name: "miss" },
      ] as MatchCue[],
    }),
    goDog: assign({
      phaseT: 0,
      banner: null,
      skyTint: false,
      dogPose: ({ context }) => (context.waveHits > 0 ? "got" : "laugh"),
      dogHold: ({ context }) =>
        context.waveHits > 0 ? (context.waveHits >= 2 ? 2 : 1) : 0,
      emitted: ({ context }) =>
        [
          { type: "music", name: "stop" },
          { type: "sfx", name: context.waveHits > 0 ? "got" : "laugh" },
        ] as MatchCue[],
    }),
    clearDog: assign({
      dogPose: null,
      dogHold: 0,
    }),
    setGameOver: assign({
      phaseT: 0,
      banner: "GAME OVER",
      dogPose: "laugh" as const,
      dogHold: 0,
      emitted: [
        { type: "music", name: "stop" },
        { type: "sfx", name: "gameover" },
      ] as MatchCue[],
    }),
    setPerfect: assign({
      score: ({ context }) => context.score + perfectBonus(context.round),
      banner: "PERFECT",
      phaseT: 0,
      emitted: ({ context }) =>
        [
          { type: "perfect", bonus: perfectBonus(context.round) },
          { type: "roundSplash" },
        ] as MatchCue[],
    }),
    setPassInterlude: assign({
      banner: ({ context }) => (context.round % 10 === 0 ? "GOOD!!" : null),
      phaseT: 0,
      emitted: [
        { type: "sfx", name: "count" },
        { type: "sfx", name: "clear" },
        { type: "roundSplash" },
      ] as MatchCue[],
    }),
    nextRound: assign({
      round: ({ context }) => context.round + 1,
      roundStartScore: ({ context }) => context.score,
      hits: () => emptyHits(),
      resolved: 0,
      waveIndex: 0,
      banner: null,
      dogPose: null,
    }),
    noteSpawned: assign({ awaitingDucks: false, emitted: [] }),
    spendShot: assign({
      shots: ({ context }) => context.shots - 1,
      emitted: [],
    }),
    recordHit: assign({
      hits: ({ context }) => {
        if (context.resolved >= HIT_SLOTS) return context.hits;
        const hits = context.hits.slice();
        hits[context.resolved] = true;
        return hits;
      },
      resolved: ({ context }) =>
        context.resolved >= HIT_SLOTS ? context.resolved : context.resolved + 1,
      waveHits: ({ context }) =>
        context.resolved >= HIT_SLOTS ? context.waveHits : context.waveHits + 1,
      score: ({ context, event }) =>
        context.resolved >= HIT_SLOTS
          ? context.score
          : context.score + (event.type === "HIT" ? event.points : 0),
      emitted: [],
    }),
    recordMiss: assign({
      hits: ({ context }) => {
        if (context.resolved >= HIT_SLOTS) return context.hits;
        const hits = context.hits.slice();
        hits[context.resolved] = false;
        return hits;
      },
      resolved: ({ context }) =>
        context.resolved >= HIT_SLOTS ? context.resolved : context.resolved + 1,
      waveMisses: ({ context }) =>
        context.resolved >= HIT_SLOTS
          ? context.waveMisses
          : context.waveMisses + 1,
      emitted: [],
    }),
  },
}).createMachine({
  id: "match",
  initial: "lobby",
  context: initialContext,
  on: {
    NOTE_SPAWNED: { actions: "noteSpawned" },
    HIT: { actions: "recordHit" },
    MISS: { actions: "recordMiss" },
  },
  states: {
    lobby: {
      on: {
        ENTER_TITLE: { target: "title", actions: "enterTitle" },
        TICK: { actions: "addPhaseT" },
      },
    },
    title: {
      on: {
        ENTER_TITLE: { actions: "enterTitle" },
        CHOOSE_MODE: { target: "start", actions: "chooseMode" },
        TICK: { actions: "addPhaseT" },
      },
    },
    start: {
      on: {
        TICK: [
          { guard: "startDone", target: "intro", actions: "beginIntro" },
          { actions: "addPhaseT" },
        ],
      },
    },
    intro: {
      initial: "sniff",
      on: {
        TICK: [
          { guard: "introDone", target: "wave", actions: "beginWave" },
          { actions: "addPhaseT" },
        ],
      },
      states: {
        sniff: {
          entry: "setSniff",
          always: { guard: "introSniffDone", target: "alert" },
        },
        alert: {
          entry: "setAlert",
          always: { guard: "introAlertDone", target: "jump" },
        },
        jump: {
          entry: "setJump",
        },
      },
    },
    wave: {
      on: {
        SHOT: { guard: "canSpendShot", actions: "spendShot" },
        TICK: [
          {
            guard: "flyAway",
            target: "resolve",
            actions: ["addFlightT", "startFlyAway"],
          },
          { guard: "waveClear", target: "dog", actions: "goDog" },
          { actions: ["addFlightT", "addPhaseT"] },
        ],
      },
    },
    resolve: {
      on: {
        TICK: [
          { guard: "resolveDone", target: "dog", actions: "goDog" },
          { actions: "addPhaseT" },
        ],
      },
    },
    dog: {
      on: {
        TICK: [
          {
            guard: "dogDone",
            target: "afterDog",
            actions: "clearDog",
          },
          { actions: "addPhaseT" },
        ],
      },
    },
    afterDog: {
      always: [
        { guard: "roundOver", target: "roundEnd" },
        { target: "wave", actions: "beginWave" },
      ],
    },
    roundEnd: {
      always: [
        { guard: "failedPass", target: "gameOver", actions: "setGameOver" },
        { guard: "isPerfect", target: "interlude", actions: "setPerfect" },
        { target: "interlude", actions: "setPassInterlude" },
      ],
    },
    interlude: {
      on: {
        CONTINUE: { target: "wave", actions: ["nextRound", "beginWave"] },
        TICK: { actions: "addPhaseT" },
      },
    },
    gameOver: {
      on: {
        ENTER_TITLE: { target: "title", actions: "enterTitle" },
        TICK: { actions: "addPhaseT" },
      },
    },
  },
});

export type MatchActor = ActorRefFrom<typeof matchMachine>;

export function createMatch(): MatchActor {
  return createActor(matchMachine).start();
}

export function matchPhase(actor: MatchActor): MatchPhase {
  const value = actor.getSnapshot().value;
  if (typeof value === "string") return value as MatchPhase;
  const key = Object.keys(value)[0];
  return (key as MatchPhase) ?? "lobby";
}

export function matchContext(actor: MatchActor): MatchContext {
  return actor.getSnapshot().context;
}

export function enterTitle(actor: MatchActor): MatchCue[] {
  actor.send({ type: "ENTER_TITLE" });
  return actor.getSnapshot().context.emitted;
}

export function chooseMode(actor: MatchActor, mode: GameMode): MatchCue[] {
  actor.send({ type: "CHOOSE_MODE", mode });
  return actor.getSnapshot().context.emitted;
}

export function tickMatch(
  actor: MatchActor,
  dt: number,
  counts: DuckCounts,
): MatchCue[] {
  actor.send({ type: "TICK", dt, counts });
  return actor.getSnapshot().context.emitted;
}

export function noteSpawned(actor: MatchActor): void {
  actor.send({ type: "NOTE_SPAWNED" });
}

export function continueMatch(actor: MatchActor): MatchCue[] {
  actor.send({ type: "CONTINUE" });
  return actor.getSnapshot().context.emitted;
}

export function canShoot(actor: MatchActor): boolean {
  const phase = matchPhase(actor);
  if (phase === "title" || phase === "gameOver") return true;
  return phase === "wave" && actor.getSnapshot().context.shots > 0;
}

export function consumeShot(actor: MatchActor): boolean {
  if (matchPhase(actor) !== "wave") return false;
  if (actor.getSnapshot().context.shots <= 0) return false;
  actor.send({ type: "SHOT" });
  return true;
}

export function recordHit(actor: MatchActor, points: number): void {
  actor.send({ type: "HIT", points });
}

export function recordMiss(actor: MatchActor): void {
  actor.send({ type: "MISS" });
}

export function sniffProgress(actor: MatchActor): number {
  const ctx = actor.getSnapshot().context;
  if (ctx.dogPose !== "sniff") return 1;
  return Math.max(0, Math.min(1, ctx.phaseT / INTRO_SNIFF));
}
