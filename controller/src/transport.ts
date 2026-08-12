import type {
  ControllerDiagnostics,
  ControllerEvent,
  ControllerSample,
  ControllerToHostPayload,
  HostToControllerMessage,
  SignallingMessage,
  TransportKind,
} from "@duckhunt/shared";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type ControllerTransportHandlers = {
  onTransport?: (kind: TransportKind) => void;
  onHostMessage?: (msg: HostToControllerMessage) => void;
  onReady?: (playerId: string) => void;
  onError?: (message: string) => void;
};

export class ControllerSession {
  private sendSignalling: (msg: SignallingMessage) => void;
  private handlers: ControllerTransportHandlers;
  private pc: RTCPeerConnection | null = null;
  private samples: RTCDataChannel | null = null;
  private events: RTCDataChannel | null = null;
  private transport: TransportKind = "websocket";
  private playerId = "";
  private fallback = false;

  constructor(
    sendSignalling: (msg: SignallingMessage) => void,
    handlers: ControllerTransportHandlers,
  ) {
    this.sendSignalling = sendSignalling;
    this.handlers = handlers;
  }

  getPlayerId(): string {
    return this.playerId;
  }

  getTransport(): TransportKind {
    return this.transport;
  }

  setPlayerId(id: string): void {
    this.playerId = id;
    this.handlers.onReady?.(id);
  }

  async handleOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.ondatachannel = (ev) => {
      if (ev.channel.label === "samples") {
        this.samples = ev.channel;
        this.samples.binaryType = "blob";
        this.samples.onopen = () => {
          this.transport = "webrtc";
          this.handlers.onTransport?.("webrtc");
        };
      }
      if (ev.channel.label === "events") {
        this.events = ev.channel;
        this.events.onmessage = (mev) => this.onChannelMessage(String(mev.data));
      }
    };

    this.pc.onicecandidate = (ev) => {
      this.sendSignalling({
        type: "ice",
        playerId: this.playerId,
        candidate: ev.candidate
          ? {
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex,
              usernameFragment: ev.candidate.usernameFragment,
            }
          : null,
        from: "controller",
      });
    };

    this.pc.onconnectionstatechange = () => {
      if (
        this.pc?.connectionState === "failed" ||
        this.pc?.connectionState === "disconnected"
      ) {
        this.enableFallback();
      }
    };

    await this.pc.setRemoteDescription(sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignalling({
      type: "sdp",
      playerId: this.playerId,
      sdp: { type: answer.type!, sdp: answer.sdp },
      from: "controller",
    });
  }

  async handleIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!this.pc || !candidate) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* ignore */
    }
  }

  enableFallback(): void {
    if (this.fallback) return;
    this.fallback = true;
    this.transport = "websocket";
    this.handlers.onTransport?.("websocket");
  }

  handleRelay(payload: ControllerToHostPayload | HostToControllerMessage): void {
    if (!("kind" in payload)) {
      if (payload.type === "clock_ping") {
        this.replyClockPong(payload.t0);
        return;
      }
      this.handlers.onHostMessage?.(payload);
    }
  }

  sendSample(sample: ControllerSample): void {
    const payload: ControllerToHostPayload = { kind: "sample", sample };
    this.sendPayload(payload, false);
  }

  sendEvent(event: ControllerEvent): void {
    const payload: ControllerToHostPayload = { kind: "event", event };
    this.sendPayload(payload, true);
  }

  sendDiag(diag: ControllerDiagnostics): void {
    this.sendPayload({ kind: "diag", diag }, true);
  }

  private sendPayload(payload: ControllerToHostPayload, reliable: boolean): void {
    const raw = JSON.stringify(payload);
    const channel = reliable ? this.events : this.samples;
    if (channel?.readyState === "open" && this.transport === "webrtc") {
      channel.send(raw);
      return;
    }
    this.sendSignalling({
      type: "ws_relay",
      playerId: this.playerId,
      payload,
      from: "controller",
    });
  }

  private replyClockPong(t0: number): void {
    const pong: HostToControllerMessage = {
      type: "clock_pong",
      t0,
      t1: performance.now(),
    };
    if (this.events?.readyState === "open" && this.transport === "webrtc") {
      this.events.send(JSON.stringify(pong));
      return;
    }
    this.sendSignalling({
      type: "ws_relay",
      playerId: this.playerId,
      payload: pong,
      from: "controller",
    });
  }

  private onChannelMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as HostToControllerMessage;
      if (msg.type === "clock_ping") {
        this.replyClockPong(msg.t0);
        return;
      }
      this.handlers.onHostMessage?.(msg);
    } catch {
      /* ignore */
    }
  }
}

export function connectSignalling(
  url: string,
  onMessage: (msg: SignallingMessage) => void,
): { ws: WebSocket; send: (msg: SignallingMessage) => void } {
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as SignallingMessage);
    } catch {
      /* ignore */
    }
  };
  return {
    ws,
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else
        ws.addEventListener("open", () => ws.send(JSON.stringify(msg)), {
          once: true,
        });
    },
  };
}

export function defaultSignallingUrl(): string {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("sig");
  if (fromQuery) return fromQuery;
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!isLocal) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.hostname}:8787`;
}
