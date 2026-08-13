import type { Vec2 } from "./types.js";

export class StillLock {
  private frozen: Vec2 | null = null;
  private stillTime = 0;
  private readonly holdSec: number;
  private readonly rateThresh: number;

  constructor(holdSec = 0.2, rateThresh = 0.12) {
    this.holdSec = holdSec;
    this.rateThresh = rateThresh;
  }

  reset(): void {
    this.frozen = null;
    this.stillTime = 0;
  }

  locked(): boolean {
    return this.frozen !== null;
  }

  update(aim: Vec2, rateRad: number, dt: number): Vec2 {
    if (rateRad > this.rateThresh) {
      this.stillTime = 0;
      this.frozen = null;
      return aim;
    }
    this.stillTime += dt;
    if (this.stillTime < this.holdSec) return aim;
    if (!this.frozen) this.frozen = [aim[0], aim[1]];
    return this.frozen;
  }
}
