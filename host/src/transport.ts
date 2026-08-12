import type {
  ControllerToHostPayload,
  HostToControllerMessage,
  SignallingMessage,
  TransportKind,
} from "@duckhunt/shared";
import {
  clockOffsetFromExchange,
  estimateClockOffset,
  type ClockSample,
} from "@duckhunt/shared";

export type PeerHandlers = {
  onSample?: (payload: Extract<ControllerToHostPayload, { kind: "sample" }>) => void;
  onEvent?: (payload: Extract<ControllerToHostPayload, { kind: "event" }>) => void;
  onHostMessage?: (msg: HostToControllerMessage) => void;
  onTransport?: (kind: TransportKind) => void;
  onClock?: (offset: number, rtt: number) => void;
  onClose?: () => void;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const WEBRTC_TIMEOUT_MS = 8000;

export class HostPeer {
  readonly playerId: string;
  transport: TransportKind = "websocket";
  private pc: RTCPeerConnection | null = null;
  private samples: RTCDataChannel | null = null;
  private events: RTCDataChannel | null = null;
  private sendSignalling: (msg: SignallingMessage) => void;
  private handlers: PeerHandlers;
  private clockSamples: ClockSample[] = [];
  private offset = 0;
  private rtt = 0;
  private usingFallback = false;
  private webrtcTimer: number | null = null;
  private lastPacketAt = 0;
  dropped = 0;
  received = 0;

  constructor(
    playerId: string,
    sendSignalling: (msg: SignallingMessage) => void,
    handlers: PeerHandlers,
  ) {
    this.playerId = playerId;
    this.sendSignalling = sendSignalling;
    this.handlers = handlers;
  }

  async startOffer(): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.samples = this.pc.createDataChannel("samples", {
      ordered: false,
      maxRetransmits: 0,
    });
    this.events = this.pc.createDataChannel("events", { ordered: true });
    this.wireChannels();

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
        from: "host",
      });
    };

    this.pc.onconnectionstatechange = () => {
      if (
        this.pc?.connectionState === "failed" ||
        this.pc?.connectionState === "disconnected"
      ) {
        this.enableFallback();
      }
      if (this.pc?.connectionState === "connected") {
        this.transport = "webrtc";
        this.handlers.onTransport?.("webrtc");
        if (this.webrtcTimer !== null) window.clearTimeout(this.webrtcTimer);
        this.startClockSync();
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignalling({
      type: "sdp",
      playerId: this.playerId,
      sdp: { type: offer.type!, sdp: offer.sdp },
      from: "host",
    });

    this.webrtcTimer = window.setTimeout(() => this.enableFallback(), WEBRTC_TIMEOUT_MS);
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(sdp);
  }

  async handleIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!this.pc || !candidate) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* ignore */
    }
  }

  handleRelay(payload: ControllerToHostPayload | HostToControllerMessage): void {
    this.ingest(payload);
  }

  send(msg: HostToControllerMessage): void {
    const raw = JSON.stringify(msg);
    if (this.events?.readyState === "open" && this.transport === "webrtc") {
      this.events.send(raw);
      return;
    }
    this.sendSignalling({
      type: "ws_relay",
      playerId: this.playerId,
      payload: msg,
      from: "host",
    });
  }

  getClockOffset(): number {
    return this.offset;
  }

  getRtt(): number {
    return this.rtt;
  }

  close(): void {
    this.samples?.close();
    this.events?.close();
    this.pc?.close();
    this.handlers.onClose?.();
  }

  private enableFallback(): void {
    if (this.usingFallback) return;
    this.usingFallback = true;
    this.transport = "websocket";
    this.handlers.onTransport?.("websocket");
    this.sendSignalling({
      type: "use_ws_fallback",
      playerId: this.playerId,
      from: "host",
    });
    this.startClockSync();
  }

  private wireChannels(): void {
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as
          | ControllerToHostPayload
          | HostToControllerMessage;
        this.ingest(data);
      } catch {
        /* ignore */
      }
    };
    this.samples!.onmessage = onMsg;
    this.events!.onmessage = onMsg;
    this.samples!.onopen = () => {
      this.transport = "webrtc";
      this.handlers.onTransport?.("webrtc");
    };
  }

  private ingest(data: ControllerToHostPayload | HostToControllerMessage): void {
    if ("kind" in data && data.kind === "sample") {
      const now = performance.now();
      if (this.lastPacketAt > 0) {
        const gap = now - this.lastPacketAt;
        if (gap > (1000 / 60) * 1.8) {
          this.dropped += Math.max(0, Math.round(gap / (1000 / 60)) - 1);
        }
      }
      this.lastPacketAt = now;
      this.received += 1;
      this.handlers.onSample?.(data);
      return;
    }
    if ("kind" in data && data.kind === "event") {
      this.handlers.onEvent?.(data);
      return;
    }
    if (data.type === "clock_pong") {
      const t2 = performance.now();
      const sample = clockOffsetFromExchange(data.t0, data.t1, t2);
      this.clockSamples.push(sample);
      if (this.clockSamples.length >= 5) {
        const est = estimateClockOffset(this.clockSamples.slice(-12));
        this.offset = est.offset;
        this.rtt = est.rtt;
        this.handlers.onClock?.(this.offset, this.rtt);
      }
      return;
    }
    if (data.type === "clock_ping") {
      this.send({ type: "clock_pong", t0: data.t0, t1: performance.now() });
    }
  }

  private startClockSync(): void {
    const ping = () => {
      this.send({ type: "clock_ping", t0: performance.now() });
    };
    ping();
    window.setInterval(ping, 3000);
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
