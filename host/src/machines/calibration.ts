import { assign, createActor, setup, type ActorRefFrom } from "xstate";
import {
  averageQuats,
  averageVec2,
  quatAngularSpread,
  quatDriftRate,
  sliceCalibWindow,
  type Quat,
  type Vec2,
} from "gyro-aim";

export const CALIB_SETTLE_MS = 150;
export const CALIB_STABLE_MS = 550;
export const CALIB_HOLD_MS = 3000;
export const CALIB_MIN_HOLD_MS = 400;
export const CALIB_RELEASE_TRIM_MS = 80;
export const CALIB_MIN_SAMPLES = 12;
export const CALIB_MAX_ANGLE_SPREAD = 0.06;
export const CALIB_MAX_DRIFT_DEG_PER_SEC = 3;
export const SENSOR_SETTLE_TIMEOUT_MS = 10000;

export type CalibCapture = {
  samples: Vec2[];
  quats: Quat[];
  times: number[];
  startedAt: number;
};

export type CalibVerdict =
  | { ok: true; quat: Quat; plane: Vec2; spread: number; durationMs: number }
  | {
      ok: false;
      reason: "hold" | "short" | "shaky" | "drift" | "bad";
      spread?: number;
      drift?: number;
    };

export type CalibContext = {
  playerId: string;
  seq: number;
  total: number;
  keepMapping: boolean;
  restore: boolean;
  settle: boolean;
  settleSince: number;
  capture: CalibCapture | null;
  lastHoldSec: number | null;
  verdict: CalibVerdict | null;
  lastLock: Extract<CalibVerdict, { ok: true }> | null;
  lockSeq: number;
  kind: "auto" | "release";
};

export type CalibInput = {
  playerId: string;
  total: number;
  keepMapping: boolean;
  restore: boolean;
  settle: boolean;
  now: number;
};

export type CalibEvent =
  | { type: "TICK"; now: number; sensorReady: boolean }
  | { type: "SAMPLE"; plane: Vec2; quat: Quat; now: number }
  | { type: "TRIGGER_DOWN" }
  | { type: "TRIGGER_UP"; now: number };

function holdWindow(
  capture: CalibCapture,
  now: number,
  kind: "auto" | "release",
): { quats: Quat[]; planes: Vec2[]; durationMs: number } | null {
  const settleFrom = capture.startedAt + CALIB_SETTLE_MS;
  const to = kind === "release" ? now - CALIB_RELEASE_TRIM_MS : now;
  if (to <= settleFrom) return null;
  const trailingFrom = Math.max(settleFrom, to - CALIB_STABLE_MS);
  const trailing = sliceCalibWindow(
    capture.quats,
    capture.samples,
    capture.times,
    trailingFrom,
    to,
  );
  if (
    trailing &&
    trailing.durationMs >= Math.min(CALIB_STABLE_MS, to - settleFrom) * 0.85 &&
    trailing.quats.length >= CALIB_MIN_SAMPLES
  ) {
    return trailing;
  }
  return sliceCalibWindow(
    capture.quats,
    capture.samples,
    capture.times,
    settleFrom,
    to,
  );
}

export function evaluateHold(
  capture: CalibCapture,
  now: number,
  kind: "auto" | "release",
): CalibVerdict {
  const heldMs = now - capture.startedAt;
  if (heldMs < CALIB_HOLD_MS) {
    return { ok: false, reason: "hold" };
  }
  const held = holdWindow(capture, now, kind);
  const minMs = kind === "auto" ? CALIB_STABLE_MS * 0.9 : CALIB_MIN_HOLD_MS;
  if (!held || held.durationMs < minMs || held.quats.length < CALIB_MIN_SAMPLES) {
    return { ok: false, reason: "short" };
  }
  const spread = quatAngularSpread(held.quats);
  if (spread > CALIB_MAX_ANGLE_SPREAD) {
    return { ok: false, reason: "shaky", spread };
  }
  const drift = quatDriftRate(held.quats, held.durationMs / 1000);
  if (drift > CALIB_MAX_DRIFT_DEG_PER_SEC) {
    return { ok: false, reason: "drift", spread, drift };
  }
  const plane = averageVec2(held.planes);
  const quat = averageQuats(held.quats);
  if (!quat) return { ok: false, reason: "bad" };
  return {
    ok: true,
    quat,
    plane: plane ?? [0, 0],
    spread,
    durationMs: held.durationMs,
  };
}

export const calibMachine = setup({
  types: {
    context: {} as CalibContext,
    events: {} as CalibEvent,
    input: {} as CalibInput,
  },
  guards: {
    sensorsReady: ({ context, event }) => {
      if (event.type !== "TICK") return false;
      const waited = event.now - context.settleSince;
      return event.sensorReady || waited > SENSOR_SETTLE_TIMEOUT_MS;
    },
    needsSettle: ({ context }) => context.settle,
    autoLocked: ({ context }) => context.verdict?.ok === true,
    releaseLocked: ({ context }) => context.verdict?.ok === true,
    moreTargets: ({ context }) => context.seq + 1 < context.total,
  },
  actions: {
    startCapture: assign({
      capture: () => ({
        samples: [] as Vec2[],
        quats: [] as Quat[],
        times: [] as number[],
        startedAt: performance.now(),
      }),
      lastHoldSec: null,
      verdict: null,
      kind: "auto" as const,
    }),
    pushSample: assign({
      capture: ({ context, event }) => {
        if (event.type !== "SAMPLE" || !context.capture) return context.capture;
        return {
          ...context.capture,
          samples: [...context.capture.samples, event.plane],
          quats: [...context.capture.quats, event.quat],
          times: [...context.capture.times, event.now],
        };
      },
    }),
    evaluateAuto: assign({
      kind: "auto" as const,
      verdict: ({ context, event }) => {
        if (!context.capture) return null;
        const now = event.type === "SAMPLE" || event.type === "TICK" ? event.now : 0;
        return evaluateHold(context.capture, now, "auto");
      },
    }),
    evaluateRelease: assign({
      kind: "release" as const,
      verdict: ({ context, event }) => {
        if (!context.capture) return { ok: false, reason: "hold" as const };
        const now = event.type === "TRIGGER_UP" ? event.now : performance.now();
        return evaluateHold(context.capture, now, "release");
      },
    }),
    clearCapture: assign({
      capture: null,
      lastHoldSec: null,
    }),
    commitLock: assign({
      lastLock: ({ context }) =>
        context.verdict && context.verdict.ok ? context.verdict : context.lastLock,
      lockSeq: ({ context }) => context.lockSeq + 1,
    }),
    advanceSeq: assign({
      seq: ({ context }) => context.seq + 1,
      capture: null,
      lastHoldSec: null,
      verdict: null,
    }),
  },
}).createMachine({
  id: "calib",
  initial: "dispatch",
  context: ({ input }) => ({
    playerId: input.playerId,
    seq: 0,
    total: input.total,
    keepMapping: input.keepMapping,
    restore: input.restore,
    settle: input.settle,
    settleSince: input.now,
    capture: null,
    lastHoldSec: null,
    verdict: null,
    lastLock: null,
    lockSeq: 0,
    kind: "auto",
  }),
  states: {
    dispatch: {
      always: [
        { guard: "needsSettle", target: "settling" },
        { target: "targeting" },
      ],
    },
    settling: {
      on: {
        TICK: { guard: "sensorsReady", target: "targeting" },
      },
    },
    targeting: {
      entry: "clearCapture",
      on: {
        TRIGGER_DOWN: { target: "holding", actions: "startCapture" },
      },
    },
    holding: {
      on: {
        SAMPLE: {
          actions: ["pushSample", "evaluateAuto"],
        },
        TRIGGER_UP: { target: "evaluating", actions: "evaluateRelease" },
      },
      always: { guard: "autoLocked", target: "locked" },
    },
    evaluating: {
      always: [
        { guard: "releaseLocked", target: "locked" },
        { target: "targeting" },
      ],
    },
    locked: {
      entry: "commitLock",
      always: [
        { guard: "moreTargets", target: "targeting", actions: "advanceSeq" },
        { target: "done" },
      ],
    },
    done: { type: "final" },
  },
});

export type CalibActor = ActorRefFrom<typeof calibMachine>;

export function createCalibActor(input: CalibInput): CalibActor {
  return createActor(calibMachine, { input }).start();
}

export function calibPhase(
  actor: CalibActor,
): "settling" | "targeting" | "holding" | "done" {
  const value = actor.getSnapshot().value;
  if (value === "done") return "done";
  if (value === "holding") return "holding";
  if (value === "settling") return "settling";
  return "targeting";
}
