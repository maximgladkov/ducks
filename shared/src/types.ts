import type {
  AimDiagnostics,
  AimSample,
  Mat3,
  Quat,
  Vec2,
  Vec3,
} from "gyro-aim";

export type { Mat3, Quat, Vec2, Vec3 };

export type TransportKind = "webrtc" | "websocket";

export type ControllerSample = AimSample;
export type ControllerDiagnostics = AimDiagnostics;

export type ControllerEventType =
  | "trigger_down"
  | "trigger_up"
  | "recentre"
  | "recalibrate"
  | "calib_point";

export type ControllerEvent = {
  t: number;
  type: ControllerEventType;
  seq: number;
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
  | { type: "share_card"; mime: string; data: string }
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
  | { type: "create_session"; sessionId?: string }
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
