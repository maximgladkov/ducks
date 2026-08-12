import {
  cross3,
  expectedAccelDirection,
  normalize3,
  predictOrientation,
  quatIdentity,
  quatNormalize,
} from "./quat.js";
import type { Quat, Vec3 } from "./types.js";

export type FusionOptions = {
  /** Proportional gain pulling the estimate toward measured gravity, in 1/s. */
  accelGain: number;
  /** How quickly a stationary device's gyro bias is learned, in 1/s. */
  biasGain: number;
  /** Rotation below this, in rad/s, counts as holding still. */
  stationaryRate: number;
  /** Allowed deviation of accelerometer magnitude from gravity, as a fraction. */
  stationaryAccelTolerance: number;
  /** Seconds of stillness required before bias is trusted. */
  stationaryWarmup: number;
};

export const DEFAULT_FUSION_OPTIONS: FusionOptions = {
  accelGain: 1.2,
  biasGain: 0.25,
  // Phone gyros routinely sit 2-4 deg/s off zero, and the gate is evaluated
  // before the bias is known, so it has to be loose enough to admit that much.
  // Aiming at a moving target runs an order of magnitude faster, so this still
  // separates holding still from tracking.
  stationaryRate: 0.15,
  stationaryAccelTolerance: 0.08,
  stationaryWarmup: 0.4,
};

const GRAVITY = 9.80665;

/**
 * Complementary orientation filter over gyroscope and accelerometer.
 *
 * The gyroscope carries the fast motion while the accelerometer slowly corrects
 * pitch and roll, so those two axes cannot drift; only heading drifts, which
 * recentring resolves. Correction uses a cross-product feedback term rather than
 * Madgwick's normalized gradient because that gradient is exactly zero when the
 * estimate already agrees with gravity -- a state a resting phone reaches --
 * and normalizing it there yields NaN that never washes out.
 */
export class OrientationFusion {
  private q: Quat = quatIdentity();
  private bias: Vec3 = [0, 0, 0];
  private stationaryTime = 0;
  private seeded = false;
  private accelSign = 0;
  private signVotes = 0;
  private options: FusionOptions;

  constructor(options: Partial<FusionOptions> = {}) {
    this.options = { ...DEFAULT_FUSION_OPTIONS, ...options };
  }

  reset(): void {
    this.q = quatIdentity();
    this.bias = [0, 0, 0];
    this.stationaryTime = 0;
    this.seeded = false;
  }

  /** Adopts an externally known attitude, e.g. from DeviceOrientation. */
  seed(q: Quat): void {
    this.q = quatNormalize(q);
    this.seeded = true;
  }

  isSeeded(): boolean {
    return this.seeded;
  }

  orientation(): Quat {
    return this.q;
  }

  /** Bias-corrected body-frame angular velocity, in rad/s. */
  rate(gyro: Vec3): Vec3 {
    return [gyro[0] - this.bias[0], gyro[1] - this.bias[1], gyro[2] - this.bias[2]];
  }

  biasEstimate(): Vec3 {
    return [...this.bias] as Vec3;
  }

  isStationary(): boolean {
    return this.stationaryTime >= this.options.stationaryWarmup;
  }

  /**
   * Learns whether the platform reports `accelerationIncludingGravity` with the
   * sign the spec describes or negated, by comparing against an attitude from a
   * source that is unambiguous. iOS negates it; deciding from evidence avoids
   * user-agent sniffing, and a wrong guess would make the filter converge to an
   * upside-down attitude.
   */
  observeAccelSign(reference: Quat, accel: Vec3): void {
    if (this.accelSign !== 0) return;
    const measured = normalize3(accel);
    if (!measured) return;
    const expected = expectedAccelDirection(reference);
    const agreement =
      measured[0] * expected[0] + measured[1] * expected[1] + measured[2] * expected[2];
    if (Math.abs(agreement) < 0.6) return;
    this.signVotes += agreement > 0 ? 1 : -1;
    if (Math.abs(this.signVotes) >= 8) {
      this.accelSign = this.signVotes > 0 ? 1 : -1;
    }
  }

  accelSignConvention(): number {
    return this.accelSign;
  }

  /**
   * Advances the estimate. `accel` is raw `accelerationIncludingGravity` in
   * m/s^2; pass null to coast on the gyroscope alone.
   */
  update(gyro: Vec3, accel: Vec3 | null, dtSec: number): Quat {
    const dt = Math.min(0.1, Math.max(1e-4, dtSec));
    const rate = this.rate(gyro);

    const magnitude = accel ? Math.hypot(accel[0], accel[1], accel[2]) : 0;
    const gravityLike =
      accel !== null &&
      Math.abs(magnitude - GRAVITY) / GRAVITY <= this.options.stationaryAccelTolerance;
    const still = gravityLike && Math.hypot(rate[0], rate[1], rate[2]) <= this.options.stationaryRate;

    this.stationaryTime = still ? this.stationaryTime + dt : 0;

    if (still) {
      const k = Math.min(1, this.options.biasGain * dt);
      this.bias = [
        this.bias[0] + (gyro[0] - this.bias[0]) * k,
        this.bias[1] + (gyro[1] - this.bias[1]) * k,
        this.bias[2] + (gyro[2] - this.bias[2]) * k,
      ];
    }

    let correction: Vec3 = [0, 0, 0];
    if (accel && gravityLike && this.accelSign !== 0) {
      const measured = normalize3([
        accel[0] * this.accelSign,
        accel[1] * this.accelSign,
        accel[2] * this.accelSign,
      ]);
      if (measured) {
        const expected = expectedAccelDirection(this.q);
        const err = cross3(measured, expected);
        correction = [
          err[0] * this.options.accelGain,
          err[1] * this.options.accelGain,
          err[2] * this.options.accelGain,
        ];
      }
    }

    const total: Vec3 = [
      rate[0] + correction[0],
      rate[1] + correction[1],
      rate[2] + correction[2],
    ];
    this.q = predictOrientation(this.q, total, dt);
    return this.q;
  }
}
