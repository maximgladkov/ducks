import { assign, createActor, setup, type ActorRefFrom } from "xstate";

export type SessionMode = "lobby" | "playing" | "stationary";

export type SessionContext = {
  resumeTo: SessionMode;
  firstCalibDone: boolean;
  calibratingPlayerId: string | null;
  huntAudioPaused: boolean;
};

export type SessionEvent =
  | { type: "CALIB_START"; playerId: string }
  | { type: "CALIB_DONE"; ok: boolean }
  | { type: "STATIONARY"; on: boolean };

export const sessionMachine = setup({
  types: {
    context: {} as SessionContext,
    events: {} as SessionEvent,
  },
  actions: {
    markCalib: assign({
      calibratingPlayerId: ({ event }) =>
        event.type === "CALIB_START" ? event.playerId : null,
    }),
    clearCalib: assign({
      calibratingPlayerId: null,
    }),
    markFirstCalib: assign({
      firstCalibDone: true,
      resumeTo: "playing" as const,
    }),
    pauseAudio: assign({ huntAudioPaused: true }),
    resumeAudio: assign({ huntAudioPaused: false }),
  },
}).createMachine({
  id: "session",
  initial: "lobby",
  context: {
    resumeTo: "lobby",
    firstCalibDone: false,
    calibratingPlayerId: null,
    huntAudioPaused: false,
  },
  states: {
    lobby: {
      entry: assign({ resumeTo: "lobby" as const }),
      on: {
        CALIB_START: {
          target: "calibrating",
          actions: "markCalib",
        },
      },
    },
    playing: {
      entry: assign({ resumeTo: "playing" as const }),
      on: {
        CALIB_START: { target: "calibrating", actions: "markCalib" },
        STATIONARY: [
          { guard: ({ event }) => event.type === "STATIONARY" && event.on, target: "stationary" },
        ],
      },
    },
    stationary: {
      entry: assign({ resumeTo: "stationary" as const }),
      on: {
        CALIB_START: { target: "calibrating", actions: "markCalib" },
        STATIONARY: [
          {
            guard: ({ event }) => event.type === "STATIONARY" && !event.on,
            target: "playing",
          },
        ],
      },
    },
    calibrating: {
      entry: "pauseAudio",
      exit: ["clearCalib", "resumeAudio"],
      on: {
        CALIB_START: { actions: "markCalib" },
        CALIB_DONE: [
          {
            guard: ({ context, event }) =>
              !context.firstCalibDone && event.type === "CALIB_DONE" && event.ok,
            target: "playing",
            actions: "markFirstCalib",
          },
          {
            guard: ({ context, event }) =>
              !context.firstCalibDone && event.type === "CALIB_DONE" && !event.ok,
            target: "lobby",
          },
          { target: "resume" },
        ],
      },
    },
    resume: {
      always: [
        {
          guard: ({ context }) => context.resumeTo === "stationary",
          target: "stationary",
        },
        {
          guard: ({ context }) => context.resumeTo === "lobby",
          target: "lobby",
        },
        { target: "playing" },
      ],
    },
  },
});

export type SessionActor = ActorRefFrom<typeof sessionMachine>;

export function createSession(): SessionActor {
  return createActor(sessionMachine).start();
}

export function sessionCalibrating(actor: SessionActor): boolean {
  return actor.getSnapshot().matches("calibrating");
}

export function sessionMode(actor: SessionActor): SessionMode | "calibrating" {
  const value = actor.getSnapshot().value;
  if (value === "calibrating" || value === "resume") return "calibrating";
  if (value === "stationary") return "stationary";
  if (value === "lobby") return "lobby";
  return "playing";
}
