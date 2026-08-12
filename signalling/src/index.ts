import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientRole, SignallingMessage } from "@duckhunt/shared";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hostDist = process.env.HOST_DIST ?? path.join(root, "host/dist");
const controllerDist =
  process.env.CONTROLLER_DIST ?? path.join(root, "controller/dist");
const serveStatic = process.env.SERVE_STATIC === "1";

type Peer = {
  ws: WebSocket;
  role: ClientRole;
  playerId?: string;
};

type Session = {
  id: string;
  host: Peer | null;
  controllers: Map<string, Peer>;
};

const sessions = new Map<string, Session>();

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function send(ws: WebSocket, msg: SignallingMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanupPeer(session: Session, peer: Peer): void {
  if (peer.role === "host") {
    for (const c of session.controllers.values()) {
      send(c.ws, { type: "error", message: "host_disconnected" });
      c.ws.close();
    }
    sessions.delete(session.id);
    return;
  }
  if (peer.playerId) {
    session.controllers.delete(peer.playerId);
    if (session.host) {
      send(session.host.ws, {
        type: "player_left",
        playerId: peer.playerId,
      });
    }
  }
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".json":
      return "application/json";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function publicBaseFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, "");
  const host = String(req.headers.host ?? "localhost:8787");
  const xf = String(req.headers["x-forwarded-proto"] ?? "");
  const isLocal = host.includes("localhost") || host.startsWith("127.");
  const proto = xf || (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}

async function serveFile(
  res: import("node:http").ServerResponse,
  filePath: string,
): Promise<boolean> {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-cache",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health" || url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        sessions: sessions.size,
        static: serveStatic,
        publicBaseUrl: PUBLIC_BASE_URL || null,
      }),
    );
    return;
  }

  if (!serveStatic) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/c") {
    res.writeHead(302, { location: "/c/" });
    res.end();
    return;
  }

  if (pathname.startsWith("/c/")) {
    const rel = pathname.slice("/c/".length);
    const candidate = path.join(controllerDist, rel || "index.html");
    const safe = path.normalize(candidate);
    if (!safe.startsWith(controllerDist)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (await serveFile(res, safe)) return;
    if (await serveFile(res, path.join(controllerDist, "index.html"))) return;
    res.writeHead(404).end("controller asset not found");
    return;
  }

  const hostCandidate = path.join(hostDist, pathname === "/" ? "index.html" : pathname);
  const safeHost = path.normalize(hostCandidate);
  if (!safeHost.startsWith(hostDist)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (await serveFile(res, safeHost)) return;
  if (await serveFile(res, path.join(hostDist, "index.html"))) return;
  res.writeHead(404).end("not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  let session: Session | null = null;
  let peer: Peer | null = null;
  const base = publicBaseFromRequest(req);

  ws.on("message", (raw) => {
    let msg: SignallingMessage;
    try {
      msg = JSON.parse(String(raw)) as SignallingMessage;
    } catch {
      send(ws, { type: "error", message: "invalid_json" });
      return;
    }

    if (msg.type === "create_session") {
      const sessionId = id("sess");
      session = { id: sessionId, host: null, controllers: new Map() };
      peer = { ws, role: "host" };
      session.host = peer;
      sessions.set(sessionId, session);
      const joinUrl = `${base}/c/?session=${sessionId}`;
      send(ws, { type: "session_created", sessionId, joinUrl });
      send(ws, {
        type: "joined",
        sessionId,
        playerId: "host",
        role: "host",
      });
      return;
    }

    if (msg.type === "join_session") {
      const existing = sessions.get(msg.sessionId);
      if (!existing || !existing.host) {
        send(ws, { type: "error", message: "session_not_found" });
        return;
      }
      const playerId = id("p");
      peer = { ws, role: "controller", playerId };
      session = existing;
      existing.controllers.set(playerId, peer);
      send(ws, {
        type: "joined",
        sessionId: existing.id,
        playerId,
        role: "controller",
      });
      send(existing.host.ws, { type: "player_joined", playerId });
      return;
    }

    if (!session || !peer) {
      send(ws, { type: "error", message: "not_joined" });
      return;
    }

    if (msg.type === "sdp" || msg.type === "ice") {
      if (peer.role === "host") {
        const target = session.controllers.get(msg.playerId);
        if (target) send(target.ws, msg);
      } else if (session.host) {
        send(session.host.ws, {
          ...msg,
          playerId: peer.playerId!,
          from: "controller",
        });
      }
      return;
    }

    if (msg.type === "ws_relay" || msg.type === "use_ws_fallback") {
      if (peer.role === "host") {
        const target = session.controllers.get(msg.playerId);
        if (target) send(target.ws, msg);
      } else if (session.host && peer.playerId) {
        send(session.host.ws, {
          ...msg,
          playerId: peer.playerId,
          from: "controller",
        });
      }
    }
  });

  ws.on("close", () => {
    if (session && peer) cleanupPeer(session, peer);
  });
});

server.listen(PORT, () => {
  console.log(`[gateway] http://localhost:${PORT}`);
  console.log(`[gateway] static=${serveStatic} PUBLIC_BASE_URL=${PUBLIC_BASE_URL || "(from Host)"}`);
});
