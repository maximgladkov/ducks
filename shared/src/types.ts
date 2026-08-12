export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export type TransportKind = "webrtc" | "websocket";

export type ControllerSample = {
  t: number;
  q: Quat;
  w: Vec3;
};

export type ControllerEventType =
  | "trigger_down"
  | "trigger_up"
  | "recentre"
  | "calib_point";

export type ControllerEvent = {
  t: number;
  type: ControllerEventType;
  seq: number;
};

export type ControllerDiagnostics = {
  mode: string;
  stationary: boolean;
  biasDegPerSec: number;
  accelSign: number;
  screenAngle: number;
  emitHz: number;
  /** False while the attitude estimate is still settling; aim is meaningless. */
  converged: boolean;
  /** Disagreement between the estimate and its reference, in degrees. */
  tiltResidualDeg: number;
  /** Which rotationRate axis labelling the platform turned out to use. */
  gyroConvention: string;
};

export type ClockPing = {
  type: "clock_ping";
  t0: number;
};

export type ClockPong = {
  type: "clock_pong";
  t0: number;
  t1: number;
};

export type HostToControllerMessage =
  | { type: "calib_prompt"; seq: number; total: number; corner: Vec2 }
  | { type: "calib_done"; ok: boolean; reason?: string }
  | { type: "calib_cancel" }
  | { type: "status"; text: string }
  | { type: "ammo"; shots: number }
  | ClockPing
  | ClockPong;

export type ControllerToHostPayload =
  | { kind: "sample"; sample: ControllerSample }
  | { kind: "event"; event: ControllerEvent }
  | { kind: "diag"; diag: ControllerDiagnostics }
  | ClockPing
  | ClockPong;

export type ClientRole = "host" | "controller";

export type SignallingMessage =
  | { type: "create_session" }
  | {
      type: "session_created";
      sessionId: string;
      joinUrl: string;
    }
  | { type: "join_session"; sessionId: string }
  | {
      type: "joined";
      sessionId: string;
      playerId: string;
      role: ClientRole;
    }
  | {
      type: "player_joined";
      playerId: string;
    }
  | {
      type: "player_left";
      playerId: string;
    }
  | {
      type: "sdp";
      playerId: string;
      sdp: { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string };
      from: ClientRole;
    }
  | {
      type: "ice";
      playerId: string;
      candidate: {
        candidate?: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      } | null;
      from: ClientRole;
    }
  | {
      type: "ws_relay";
      playerId: string;
      payload: ControllerToHostPayload | HostToControllerMessage;
      from: ClientRole;
    }
  | { type: "error"; message: string }
  | { type: "use_ws_fallback"; playerId: string; from: ClientRole };

export const PLAYER_COLORS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
] as const;

export function colorForPlayer(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length]!;
}

/**
 * Filtering now happens in degrees of aim angle rather than pixels, so
 * `minCutoff` and `beta` are in Hz and Hz-per-deg/s. A 200 deg/s flick raises
 * the cutoff to ~11 Hz, while a steady hold stays at 1 Hz.
 */
export const DEFAULT_DEBUG_SETTINGS = {
  minCutoff: 1,
  // The adaptive cutoff is what trades lag against jitter, so it carries the
  // responsiveness on its own: high enough to open up as soon as the hand moves.
  beta: 0.12,
  predictionHorizonMs: 25,
  /**
   * Off, because latency belongs to prediction, which uses a measured rate.
   * Leading by the filter's own lag instead overshoots and then unwinds: the lag
   * peaks just as the hand slows, so the crosshair keeps going, then creeps back
   * towards the middle for over a second.
   */
  filterLeadGain: 0,
  aimAssistRadius: 20,
  sensitivity: 900,
  predictionEnabled: true,
  filteringEnabled: true,
  aimAssistEnabled: true,
  absoluteAiming: true,
  invertX: false,
  invertY: false,
} as const;

export type DebugSettings = {
  -readonly [K in keyof typeof DEFAULT_DEBUG_SETTINGS]: (typeof DEFAULT_DEBUG_SETTINGS)[K];
};
