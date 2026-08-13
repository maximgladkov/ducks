import type { Vec2 } from "./types.js";

export type AimBenchSnapshot = {
  staticRmsPx: number | null;
  movingResidualPx: number | null;
  yawDriftDegPerMin: number | null;
  sampleAgeMs: number;
  horizonMs: number;
};

type Sample = { t: number; x: number; y: number };

export class AimBench {
  private staticPts: Sample[] = [];
  private movePts: Sample[] = [];
  private yawPts: Array<{ t: number; yaw: number }> = [];
  private sampleAgeMs = 0;
  private horizonMs = 0;

  observe(opts: {
    aim: Vec2;
    tSec: number;
    rateRad: number;
    sampleAgeMs: number;
    horizonMs: number;
    yawDeg?: number;
  }): void {
    this.sampleAgeMs = opts.sampleAgeMs;
    this.horizonMs = opts.horizonMs;
    const pt = { t: opts.tSec, x: opts.aim[0], y: opts.aim[1] };
    if (opts.rateRad < 0.12) {
      this.staticPts.push(pt);
      this.trim(this.staticPts, opts.tSec, 3);
    } else {
      this.staticPts = [];
    }
    if (opts.rateRad > 0.35) {
      this.movePts.push(pt);
      this.trim(this.movePts, opts.tSec, 0.6);
    } else {
      this.movePts = [];
    }
    if (opts.yawDeg != null && Number.isFinite(opts.yawDeg)) {
      this.yawPts.push({ t: opts.tSec, yaw: opts.yawDeg });
      this.trimYaw(opts.tSec, 20);
    }
  }

  snapshot(): AimBenchSnapshot {
    return {
      staticRmsPx: this.staticRms(),
      movingResidualPx: this.movingResidual(),
      yawDriftDegPerMin: this.yawDrift(),
      sampleAgeMs: this.sampleAgeMs,
      horizonMs: this.horizonMs,
    };
  }

  private trim(pts: Sample[], now: number, windowSec: number): void {
    const cut = now - windowSec;
    while (pts.length > 0 && pts[0]!.t < cut) pts.shift();
  }

  private trimYaw(now: number, windowSec: number): void {
    const cut = now - windowSec;
    while (this.yawPts.length > 0 && this.yawPts[0]!.t < cut) this.yawPts.shift();
  }

  private staticRms(): number | null {
    if (this.staticPts.length < 8) return null;
    let mx = 0;
    let my = 0;
    for (const p of this.staticPts) {
      mx += p.x;
      my += p.y;
    }
    mx /= this.staticPts.length;
    my /= this.staticPts.length;
    let acc = 0;
    for (const p of this.staticPts) acc += (p.x - mx) ** 2 + (p.y - my) ** 2;
    return Math.sqrt(acc / this.staticPts.length);
  }

  private movingResidual(): number | null {
    if (this.movePts.length < 8) return null;
    const n = this.movePts.length;
    const t0 = this.movePts[0]!.t;
    const span = this.movePts[n - 1]!.t - t0;
    if (span < 1e-3) return null;
    const u = this.movePts.map((p) => (p.t - t0) / span);
    const rx = fitQuadResidual(
      u,
      this.movePts.map((p) => p.x),
    );
    const ry = fitQuadResidual(
      u,
      this.movePts.map((p) => p.y),
    );
    if (rx == null || ry == null) return null;
    return Math.sqrt((rx * rx + ry * ry) / 2);
  }

  private yawDrift(): number | null {
    if (this.yawPts.length < 12) return null;
    const t0 = this.yawPts[0]!.t;
    const span = this.yawPts[this.yawPts.length - 1]!.t - t0;
    if (span < 4) return null;
    let sumT = 0;
    let sumY = 0;
    let sumTT = 0;
    let sumTY = 0;
    const n = this.yawPts.length;
    for (const p of this.yawPts) {
      const t = p.t - t0;
      sumT += t;
      sumY += p.yaw;
      sumTT += t * t;
      sumTY += t * p.yaw;
    }
    const den = n * sumTT - sumT * sumT;
    if (Math.abs(den) < 1e-9) return null;
    const slope = (n * sumTY - sumT * sumY) / den;
    return slope * 60;
  }
}

function fitQuadResidual(u: number[], y: number[]): number | null {
  if (u.length < 4) return null;
  const m = [0, 0, 0, 0, 0];
  const rhs = [0, 0, 0];
  for (let i = 0; i < u.length; i++) {
    let p = 1;
    for (let k = 0; k < m.length; k++) {
      m[k]! += p;
      p *= u[i]!;
    }
    let r = 1;
    for (let k = 0; k < 3; k++) {
      rhs[k]! += y[i]! * r;
      r *= u[i]!;
    }
  }
  const A = [
    [m[0]!, m[1]!, m[2]!],
    [m[1]!, m[2]!, m[3]!],
    [m[2]!, m[3]!, m[4]!],
  ];
  const c = solve3(A, rhs);
  if (!c) return null;
  let ssr = 0;
  for (let i = 0; i < u.length; i++) {
    const pred = c[0]! + c[1]! * u[i]! + c[2]! * u[i]! * u[i]!;
    ssr += (y[i]! - pred) ** 2;
  }
  return Math.sqrt(ssr / (u.length - 3));
}

function solve3(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= 3; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}
