import { defaultSignallingUrl } from "./transport";

type DiagRecord = Record<string, unknown> & { kind: string };

const FLUSH_MS = 500;
const MAX_QUEUE = 2000;

let queue: DiagRecord[] = [];
let pendingReset = false;
let inFlight = false;
let started = 0;
let endpoint: string | null = null;

function diagEndpoint(): string {
  if (endpoint) return endpoint;
  const sig = defaultSignallingUrl();
  const http = sig.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  endpoint = new URL("/debug/log", http).toString();
  return endpoint;
}

/** Milliseconds since the log was opened, so records are easy to line up. */
function stamp(): number {
  return Math.round(performance.now() - started);
}

export function diagStart(session: Record<string, unknown>): void {
  started = performance.now();
  queue = [{ kind: "session", t: 0, ...session }];
  pendingReset = true;
  void flush();
}

export function diagLog(kind: string, data: Record<string, unknown>): void {
  if (started === 0) return;
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ kind, t: stamp(), ...data });
}

/** True at most once per `everyMs`, for rate-limiting high-frequency records. */
const gates = new Map<string, number>();
export function diagEvery(key: string, everyMs: number): boolean {
  const now = performance.now();
  const last = gates.get(key) ?? -Infinity;
  if (now - last < everyMs) return false;
  gates.set(key, now);
  return true;
}

async function flush(): Promise<void> {
  if (inFlight) return;
  if (!pendingReset && queue.length === 0) return;
  const records = queue;
  const reset = pendingReset;
  queue = [];
  pendingReset = false;
  inFlight = true;
  try {
    await fetch(diagEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset, records }),
      keepalive: true,
    });
  } catch {
    /* logging must never disturb the game */
  } finally {
    inFlight = false;
  }
}

window.setInterval(() => void flush(), FLUSH_MS);

export function round(v: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

export function roundAll(v: readonly number[], places = 4): number[] {
  return v.map((n) => round(n, places));
}
