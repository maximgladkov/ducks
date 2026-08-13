export type ClockSample = {
  offset: number;
  rtt: number;
};

export function estimateClockOffset(samples: ClockSample[]): {
  offset: number;
  rtt: number;
} {
  if (samples.length === 0) return { offset: 0, rtt: 0 };
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const keep = Math.max(1, Math.ceil(sorted.length * 0.5));
  const best = sorted.slice(0, keep);
  const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
  const rtts = best.map((s) => s.rtt).sort((a, b) => a - b);
  return {
    offset: median(offsets),
    rtt: median(rtts),
  };
}

export function clockOffsetFromExchange(
  t0: number,
  t1: number,
  t2: number,
): ClockSample {
  const rtt = t2 - t0;
  const offset = (t0 + t2) / 2 - t1;
  return { offset, rtt };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[mid - 1]! + values[mid]!) / 2;
  }
  return values[mid]!;
}

export function hostTimeFromController(
  controllerT: number,
  offsetHostMinusController: number,
): number {
  return controllerT + offsetHostMinusController;
}

export function sampleAgeMs(
  controllerT: number,
  offsetHostMinusController: number,
  hostNow: number,
): number {
  return Math.max(
    0,
    hostNow - hostTimeFromController(controllerT, offsetHostMinusController),
  );
}

export function smoothSampleAgeMs(
  prev: number,
  raw: number,
  alpha = 0.3,
): number {
  if (!Number.isFinite(prev) || prev <= 0) return raw;
  return prev + (raw - prev) * alpha;
}

export function catchUpSec(sampleAgeMs: number, maxSec = 0.045): number {
  if (!Number.isFinite(sampleAgeMs) || sampleAgeMs <= 0) return 0;
  return Math.min(maxSec, sampleAgeMs / 1000);
}

export function predictionHorizonSec(opts: {
  sampleAgeMs: number;
  displayLagMs: number;
  frameMs?: number;
  extraMs?: number;
  quality?: number;
  maxSec?: number;
}): number {
  const frameMs = opts.frameMs ?? 1000 / 60;
  const extraMs = opts.extraMs ?? 0;
  const quality = Math.min(1, Math.max(0, opts.quality ?? 1));
  const rawMs =
    Math.max(0, opts.sampleAgeMs) +
    Math.max(0, opts.displayLagMs) +
    frameMs +
    extraMs;
  const maxSec = opts.maxSec ?? 0.06;
  return Math.min(maxSec, (rawMs * quality) / 1000);
}
