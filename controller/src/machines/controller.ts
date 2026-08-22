import { assign, createActor, emit, setup, type ActorRefFrom } from "xstate";

export const IDLE_HINT = "Hold two fingers to recalibrate";
export const RECALIBRATE_HOLD_MS = 600;

export type ControllerContext = {
  shotsRemaining: number;
  eventSeq: number;
  status: string;
  hint: string;
  triggerLabel: string;
  motionMode: string;
  calibrating: boolean;
};

export type ControllerEvent =
  | { type: "ARM"; mode: string }
  | { type: "PERMISSION_DENIED" }
  | { type: "CALIB_PROMPT"; seq: number; total: number }
  | { type: "CALIB_DONE"; ok: boolean; reason?: string }
  | { type: "STATUS"; text: string }
  | { type: "AMMO"; shots: number }
  | { type: "FIRE_START" }
  | { type: "FIRE_END" }
  | { type: "TWO_FINGERS" }
  | { type: "TWO_FINGERS_END" };

export type ControllerEmitted =
  | { type: "trigger_down"; seq: number }
  | { type: "trigger_up"; seq: number }
  | { type: "recalibrate"; seq: number }
  | { type: "shot" };

export const controllerMachine = setup({
  types: {
    context: {} as ControllerContext,
    events: {} as ControllerEvent,
    emitted: {} as ControllerEmitted,
  },
  actions: {
    setArmed: assign({
      status: ({ event }) =>
        event.type === "ARM" ? `Ready · ${event.mode}` : "Ready",
      hint: IDLE_HINT,
      triggerLabel: ({ context }) => (context.calibrating ? "HOLD" : "FIRE"),
      motionMode: ({ event, context }) =>
        event.type === "ARM" ? event.mode : context.motionMode,
    }),
    setDenied: assign({
      status: "Motion blocked — allow motion access, then tap again",
    }),
    beginCalib: assign({
      calibrating: true,
      status: ({ event }) =>
        event.type === "CALIB_PROMPT"
          ? `Calibrate target ${event.seq + 1}/${event.total}`
          : "Calibrating",
      hint: ({ event }) =>
        event.type === "CALIB_PROMPT"
          ? `Same grip for all ${event.total} dots — aim at the glowing dot and hold FIRE until the countdown ends`
          : IDLE_HINT,
      triggerLabel: "HOLD",
    }),
    endCalib: assign({
      calibrating: false,
      status: ({ event }) =>
        event.type === "CALIB_DONE"
          ? event.ok
            ? "Calibration OK — aim and shoot"
            : (event.reason ?? "Calib failed")
          : "Ready",
      hint: IDLE_HINT,
      triggerLabel: "FIRE",
    }),
    setStatus: assign({
      status: ({ event, context }) =>
        event.type === "STATUS" ? event.text : context.status,
    }),
    holdCountdown: assign({
      triggerLabel: ({ event, context }) => {
        if (event.type !== "STATUS" || !context.calibrating) {
          return context.triggerLabel;
        }
        const count = event.text.match(/release in (\d)/);
        if (count) return `HOLD ${count[1]}`;
        if (/locking/.test(event.text)) return "HOLDING";
        return context.triggerLabel;
      },
    }),
    setAmmo: assign({
      shotsRemaining: ({ event, context }) =>
        event.type === "AMMO" ? Math.max(0, event.shots) : context.shotsRemaining,
    }),
    bumpSeq: assign({
      eventSeq: ({ context }) => context.eventSeq + 1,
    }),
    spendShot: assign({
      shotsRemaining: ({ context }) => Math.max(0, context.shotsRemaining - 1),
    }),
    labelHolding: assign({ triggerLabel: "HOLDING" }),
    labelUp: assign({
      triggerLabel: ({ context }) => (context.calibrating ? "HOLD" : "FIRE"),
    }),
    recalHint: assign({ hint: "Keep holding to recalibrate…" }),
    restoreHint: assign({ hint: IDLE_HINT }),
    setRecalibrating: assign({ status: "Recalibrating…" }),
    emitDown: emit(({ context }) => ({
      type: "trigger_down" as const,
      seq: context.eventSeq,
    })),
    emitUp: emit(({ context }) => ({
      type: "trigger_up" as const,
      seq: context.eventSeq,
    })),
    emitRecal: emit(({ context }) => ({
      type: "recalibrate" as const,
      seq: context.eventSeq,
    })),
    emitShot: emit({ type: "shot" }),
  },
}).createMachine({
  id: "controller",
  initial: "idle",
  context: {
    shotsRemaining: 3,
    eventSeq: 0,
    status: "",
    hint: IDLE_HINT,
    triggerLabel: "FIRE",
    motionMode: "",
    calibrating: false,
  },
  on: {
    CALIB_PROMPT: { actions: "beginCalib" },
    CALIB_DONE: { actions: "endCalib" },
    STATUS: { actions: ["setStatus", "holdCountdown"] },
    AMMO: { actions: "setAmmo" },
  },
  states: {
    idle: {
      on: {
        ARM: { target: "armed", actions: "setArmed" },
        PERMISSION_DENIED: { actions: "setDenied" },
      },
    },
    armed: {
      initial: "up",
      states: {
        up: {
          on: {
            FIRE_START: [
              {
                guard: ({ context }) => context.calibrating,
                target: "down",
                actions: ["labelHolding", "bumpSeq", "emitDown"],
              },
              {
                guard: ({ context }) => context.shotsRemaining <= 0,
                target: "down",
                actions: ["bumpSeq", "emitDown"],
              },
              {
                target: "down",
                actions: ["spendShot", "bumpSeq", "emitShot", "emitDown"],
              },
            ],
            TWO_FINGERS: {
              guard: ({ context }) => !context.calibrating,
              target: "recalHold",
              actions: "recalHint",
            },
          },
        },
        down: {
          on: {
            FIRE_END: { target: "up", actions: ["bumpSeq", "emitUp", "labelUp"] },
            TWO_FINGERS: {
              target: "recalHold",
              actions: ["bumpSeq", "emitUp", "recalHint"],
            },
          },
        },
        recalHold: {
          after: {
            [RECALIBRATE_HOLD_MS]: {
              target: "up",
              actions: ["restoreHint", "setRecalibrating", "bumpSeq", "emitRecal"],
            },
          },
          on: {
            TWO_FINGERS_END: { target: "up", actions: "restoreHint" },
            FIRE_END: {},
          },
        },
      },
    },
  },
});

export type ControllerActor = ActorRefFrom<typeof controllerMachine>;

export function createController(): ControllerActor {
  return createActor(controllerMachine).start();
}

export function isArmed(actor: ControllerActor): boolean {
  return actor.getSnapshot().matches("armed");
}

export function isCalibrating(actor: ControllerActor): boolean {
  return actor.getSnapshot().context.calibrating;
}
