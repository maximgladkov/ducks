import type { Vec2 } from "./types.js";

export class StillLock {
  private frozen: Vec2 | null = null;
  private origin: Vec2 | null = null;
  private stillTime = 0;
  private readonly holdSec: number;
  private readonly rateThresh: number;
  private readonly settlePx: number;
  private readonly releasePx: number;

  constructor(holdSec = 0.2, rateThresh = 0.12, settlePx = 4, releasePx = 12) {
    this.holdSec = holdSec;
    this.rateThresh = rateThresh;
    this.settlePx = settlePx;
    this.releasePx = releasePx;
  }

  reset(): void {
    this.frozen = null;
    this.origin = null;
    this.stillTime = 0;
  }

  locked(): boolean {
    return this.frozen !== null;
  }

  update(aim: Vec2, rateRad: number, dt: number): Vec2 {
    if (rateRad > this.rateThresh) {
      this.reset();
      return aim;
    }
    if (this.frozen) {
      if (dist(aim, this.frozen) > this.releasePx) {
        this.reset();
        return aim;
      }
      return this.frozen;
    }
    if (!this.origin) this.origin = [aim[0], aim[1]];
    if (dist(aim, this.origin) > this.settlePx) {
      this.origin = [aim[0], aim[1]];
      this.stillTime = 0;
      return aim;
    }
    this.stillTime += dt;
    if (this.stillTime < this.holdSec) return aim;
    this.frozen = [this.origin[0], this.origin[1]];
    return this.frozen;
  }
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
