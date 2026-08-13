import { quatSlerp } from "./quat.js";
import type { ControllerSample, Quat, Vec3 } from "./types.js";

export function sampleAtTime(
  samples: ControllerSample[],
  controllerT: number,
): { q: Quat; w: Vec3; nq: number; t: number } | null {
  if (samples.length === 0) return null;
  const first = samples[0]!;
  if (samples.length === 1 || controllerT <= first.t) {
    return { q: first.q, w: first.w, nq: first.nq ?? 1, t: first.t };
  }
  const last = samples[samples.length - 1]!;
  if (controllerT >= last.t) {
    return { q: last.q, w: last.w, nq: last.nq ?? 1, t: last.t };
  }
  let i = 1;
  while (i < samples.length && samples[i]!.t < controllerT) i += 1;
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const span = Math.max(1e-6, b.t - a.t);
  const u = (controllerT - a.t) / span;
  return {
    q: quatSlerp(a.q, b.q, u),
    w: [
      a.w[0] + (b.w[0] - a.w[0]) * u,
      a.w[1] + (b.w[1] - a.w[1]) * u,
      a.w[2] + (b.w[2] - a.w[2]) * u,
    ],
    nq: (a.nq ?? 1) * (1 - u) + (b.nq ?? 1) * u,
    t: controllerT,
  };
}

export const SAMPLE_HISTORY = 48;
