import {
  cross3,
  expectedAccelDirection,
  normalize3,
  predictOrientation,
  quatConjugate,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatToRotationVector,
} from "./quat.js";
import type { Quat, Vec3 } from "./types.js";

/**
 * Angular velocity read off a short history of orientations.
 *
 * Differencing two samples and smoothing the result trades noise for lag one for
 * one. Fitting a curve over a brief window and taking its slope at the newest
 * sample buys both: several samples' worth of noise is averaged out, yet the
 * answer describes now rather than the middle of the window. The curve is
 * quadratic for exactly that reason -- a straight line's slope is the average
 * rate across the window, which lags by half of it, so a line would be no better
 * than the average it replaces whenever the hand is speeding up or slowing down.
 *
 * The window length is chosen per sample rather than fixed, because no single
 * length is right for both halves of the job: a long window rides out the noise
 * of a slow steady pan, and lags badly when the wrist snaps and stops. The
 * residual tells them apart. Fitted over a span the hand actually moved smoothly
 * across, what is left over is just sensor noise, and its size per degree of
 * freedom is the same whatever the span; a snap inside the window inflates it.
 * So the longest window whose residual still looks like pure noise is used.
 */
export class AngularRateEstimator {
  private samples: Array<{ t: number; q: Quat }> = [];
  private noiseScale: number | null = null;
  private readonly window: number;
  private readonly maxGapSec: number;
  private readonly degree: number;

  constructor(window = 15, maxGapSec = 0.15, degree = 2) {
    this.window = Math.max(3, window);
    this.maxGapSec = maxGapSec;
    this.degree = degree;
  }

  reset(): void {
    this.samples = [];
    this.noiseScale = null;
  }

  /** `tSec` must share one clock across calls. */
  update(q: Quat, tSec: number): Vec3 {
    const last = this.samples[this.samples.length - 1];
    // A gap this long means the stream stalled; the old poses say nothing about
    // the rate now.
    if (last && (tSec - last.t > this.maxGapSec || tSec < last.t)) {
      this.samples = [];
    }
    this.samples.push({ t: tSec, q });
    while (this.samples.length > this.window) this.samples.shift();

    const n = this.samples.length;
    if (n < 2) return [0, 0, 0];

    // Everything is measured from the oldest pose in the window, so the samples
    // share one frame and the rotations stay small enough to be linear in time.
    const base = quatConjugate(this.samples[0]!.q);
    const times = this.samples.map((s) => s.t);
    const vectors = this.samples.map((s) =>
      quatToRotationVector(quatMultiply(base, s.q)),
    );

    const end = times[n - 1]!;
    const candidates: Array<{ length: number; slope: Vec3; noise: number }> = [];
    for (let length = n; length >= 3; length -= 2) {
      const fitted = this.fitWindow(times, vectors, end, length);
      if (fitted) candidates.push({ length, ...fitted });
    }
    if (candidates.length === 0) return [0, 0, 0];

    // The shortest window spans too little time for the hand to have done
    // anything but move smoothly, so whatever it leaves over is the sensor's own
    // noise. Averaged over seconds that becomes a stable yardstick, where the
    // smallest residual of the moment would not be: fewer points always leave
    // less behind, which would argue for the shortest window every time.
    const shortest = candidates[candidates.length - 1]!;
    this.noiseScale =
      this.noiseScale === null
        ? shortest.noise
        : this.noiseScale * 0.98 + shortest.noise * 0.02;

    const tolerance = Math.max(this.noiseScale * 2.5, 1e-12);
    // Candidates run longest first, so this takes the most averaging the motion
    // will support.
    const chosen = candidates.find((c) => c.noise <= tolerance) ?? shortest;
    return chosen.slope;
  }

  private fitWindow(
    times: number[],
    vectors: Vec3[],
    end: number,
    length: number,
  ): { slope: Vec3; noise: number } | null {
    const from = times.length - length;
    const t = times.slice(from);
    const span = end - t[0]!;
    if (span < 1e-9) return null;
    // Scaled to [-1, 0] so the normal equations stay well conditioned whatever
    // the sample rate.
    const u = t.map((x) => (x - end) / span);
    // A polynomial needs more points than coefficients, or it interpolates the
    // noise instead of averaging it.
    const degree = Math.max(1, Math.min(this.degree, length - 2));
    const dof = 3 * (length - (degree + 1));
    if (dof <= 0) return null;

    const slope: Vec3 = [0, 0, 0];
    let ssr = 0;
    for (let axis = 0; axis < 3; axis++) {
      const y = vectors.slice(from).map((v) => v[axis]!);
      const fit = fitPolyAtEnd(u, y, degree);
      if (!fit) return null;
      slope[axis] = fit.slope / span;
      ssr += fit.ssr;
    }
    return { slope, noise: Math.sqrt(ssr / dof) };
  }
}

/**
 * Least-squares polynomial through (u, y) with u <= 0, returning its slope at
 * u = 0 and the sum of squared residuals.
 */
function fitPolyAtEnd(
  u: number[],
  y: number[],
  degree: number,
): { slope: number; ssr: number } | null {
  const size = degree + 1;
  const moment: number[] = new Array(2 * degree + 1).fill(0);
  for (const x of u) {
    let p = 1;
    for (let k = 0; k < moment.length; k++) {
      moment[k]! += p;
      p *= x;
    }
  }
  const rhs: number[] = new Array(size).fill(0);
  for (let i = 0; i < u.length; i++) {
    let p = 1;
    for (let k = 0; k < size; k++) {
      rhs[k]! += y[i]! * p;
      p *= u[i]!;
    }
  }
  const A: number[][] = [];
  for (let r = 0; r < size; r++) {
    A.push(Array.from({ length: size }, (_, c) => moment[r + c]!));
  }
  const coeffs = solveSmall(A, rhs);
  if (!coeffs) return null;

  let ssr = 0;
  for (let i = 0; i < u.length; i++) {
    let predicted = 0;
    let p = 1;
    for (let k = 0; k < size; k++) {
      predicted += coeffs[k]! * p;
      p *= u[i]!;
    }
    ssr += (y[i]! - predicted) ** 2;
  }
  // The fit is a + b*u + c*u^2, so its slope at u = 0 is b.
  return { slope: coeffs[1] ?? 0, ssr };
}

function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return Array.from({ length: n }, (_, i) => m[i]![n]! / m[i]![i]!);
}

/**
 * How a platform labels the three `DeviceMotionEvent.rotationRate` components.
 *
 * The spec assigns alpha to Z, beta to X and gamma to Y, but WebKit passes
 * CoreMotion's x/y/z straight through as alpha/beta/gamma. Assuming the wrong
 * one feeds pitch into the yaw channel and yaw into roll, where gravity cancels
 * it, so turning to aim sideways stops moving the crosshair at all.
 */
type Permutation = [number, number, number];

/**
 * Every way of assigning [alpha, beta, gamma] to the device's [x, y, z]. The two
 * documented ones are named; the rest are searched because a platform that gets
 * this wrong gives no indication of how.
 */
const GYRO_PERMUTATIONS: Array<{ name: string; order: Permutation }> = [
  { name: "spec", order: [1, 2, 0] },
  { name: "webkit", order: [0, 1, 2] },
  { name: "alpha-gamma-beta", order: [0, 2, 1] },
  { name: "beta-alpha-gamma", order: [1, 0, 2] },
  { name: "gamma-alpha-beta", order: [2, 0, 1] },
  { name: "gamma-beta-alpha", order: [2, 1, 0] },
];

const SPEC_ORDER: Permutation = [1, 2, 0];

function applyOrder(raw: Vec3, order: Permutation): Vec3 {
  return [raw[order[0]]!, raw[order[1]]!, raw[order[2]]!];
}

export const GYRO_CONVENTIONS = {
  spec: (r: Vec3): Vec3 => applyOrder(r, SPEC_ORDER),
  webkit: (r: Vec3): Vec3 => applyOrder(r, [0, 1, 2]),
} as const;

/**
 * Works out which labelling a platform uses by scoring each against the angular
 * velocity implied by an independent attitude source. Evidence beats sniffing
 * the user agent, which says nothing about a quirk this specific.
 *
 * A winner is only accepted when it both beats the runner-up clearly and
 * explains most of the reference motion outright. Staying undecided costs only
 * the gyroscope's contribution, whereas committing to the wrong labelling feeds
 * one axis of motion into another.
 */
export class GyroAxisDetector {
  private error = GYRO_PERMUTATIONS.map(() => 0);
  private power = 0;
  private samples = 0;
  private decided: string | null = null;
  private order: Permutation = SPEC_ORDER;

  /** `raw` is [alpha, beta, gamma] in rad/s; `reference` a body-frame rate. */
  observe(raw: Vec3, reference: Vec3, minSpeed = 0.25): void {
    if (this.decided) return;
    const speed = Math.hypot(reference[0], reference[1], reference[2]);
    if (speed < minSpeed) return;
    for (let i = 0; i < GYRO_PERMUTATIONS.length; i++) {
      const mapped = applyOrder(raw, GYRO_PERMUTATIONS[i]!.order);
      this.error[i] +=
        (mapped[0] - reference[0]) ** 2 +
        (mapped[1] - reference[1]) ** 2 +
        (mapped[2] - reference[2]) ** 2;
    }
    this.power += speed * speed;
    this.samples += 1;
    if (this.samples < 40) return;

    const ranked = this.error
      .map((err, i) => ({ err, i }))
      .sort((a, b) => a.err - b.err);
    const best = ranked[0]!;
    const runnerUp = ranked[1]!;
    if (best.err > this.power * 0.35) return;
    if (best.err > runnerUp.err * 0.6) return;
    this.decided = GYRO_PERMUTATIONS[best.i]!.name;
    this.order = GYRO_PERMUTATIONS[best.i]!.order;
  }

  convention(): string | null {
    return this.decided;
  }

  /** Compact ranking, so a log can settle the question even when undecided. */
  report(): string {
    if (this.decided) return this.decided;
    if (this.power <= 0) return "undecided";
    const ranked = this.error
      .map((err, i) => ({ err, name: GYRO_PERMUTATIONS[i]!.name }))
      .sort((a, b) => a.err - b.err)
      .slice(0, 3)
      .map((e) => `${e.name} ${(e.err / this.power).toFixed(2)}`);
    return `undecided(n=${this.samples} ${ranked.join(" ")})`;
  }

  map(raw: Vec3): Vec3 {
    return applyOrder(raw, this.order);
  }

  reset(): void {
    this.error = GYRO_PERMUTATIONS.map(() => 0);
    this.power = 0;
    this.samples = 0;
    this.decided = null;
    this.order = SPEC_ORDER;
  }
}

export type FusionOptions = {
  /** Proportional gain pulling the estimate toward measured gravity, in 1/s. */
  accelGain: number;
  /** Gain used until the estimate has settled, in 1/s. */
  settleGain: number;
  /** Seconds of high-gain settling after a seed or reset. */
  settleSeconds: number;
  /** How quickly a stationary device's gyro bias is learned, in 1/s. */
  biasGain: number;
  /** Rotation below this, in rad/s, counts as holding still. */
  stationaryRate: number;
  /** Allowed deviation of accelerometer magnitude from gravity, as a fraction. */
  stationaryAccelTolerance: number;
  /**
   * Deviation at which the accelerometer is given no weight at all. Between the
   * stationary tolerance and this the correction fades out smoothly.
   */
  accelRejectTolerance: number;
  /** Seconds of stillness required before bias is trusted. */
  stationaryWarmup: number;
  /** Tilt disagreement below this, in degrees, counts as converged. */
  convergedTiltDeg: number;
  /** Gain pulling all three axes onto a reference attitude, in 1/s. */
  referenceGain: number;
  /** Reference gain used while settling, in 1/s. */
  referenceSettleGain: number;
};

export const DEFAULT_FUSION_OPTIONS: FusionOptions = {
  accelGain: 1.2,
  // A hand-held phone is never perfectly still, so a low steady-state gain can
  // take many seconds to walk out a bad seed. Correcting aggressively at first
  // keeps that transient off the screen.
  settleGain: 8,
  settleSeconds: 1.2,
  biasGain: 0.25,
  // Phone gyros routinely sit 2-4 deg/s off zero, and the gate is evaluated
  // before the bias is known, so it has to be loose enough to admit that much.
  // Aiming at a moving target runs an order of magnitude faster, so this still
  // separates holding still from tracking.
  stationaryRate: 0.15,
  stationaryAccelTolerance: 0.08,
  // Waving a phone around swings the measured magnitude well past the
  // stationary tolerance. Rejecting outright at that point stops correcting
  // exactly when the player is moving, which is most of a round, so gravity is
  // instead down-weighted and only abandoned once the reading is badly
  // contaminated.
  accelRejectTolerance: 0.4,
  stationaryWarmup: 0.4,
  convergedTiltDeg: 2.5,
  // Heading is unobservable from gravity, so when a reference attitude exists it
  // has to carry that axis. High enough to stop drift accumulating, low enough
  // that the gyroscope still supplies the fast response between updates.
  referenceGain: 6,
  referenceSettleGain: 20,
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
  private settleTime = 0;
  private tiltResidual = Math.PI;
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
    this.settleTime = 0;
    this.tiltResidual = Math.PI;
    this.seeded = false;
  }

  /** Adopts an externally known attitude, e.g. from DeviceOrientation. */
  seed(q: Quat): void {
    this.q = quatNormalize(q);
    this.seeded = true;
    this.settleTime = 0;
    this.tiltResidual = Math.PI;
  }

  /**
   * How far the estimated attitude disagrees with measured gravity, in degrees.
   * Stays high while the filter is walking out a bad seed, which is precisely
   * when aiming and calibration should not be trusted.
   */
  tiltResidualDeg(): number {
    return (this.tiltResidual * 180) / Math.PI;
  }

  isConverged(): boolean {
    return (
      this.seeded &&
      this.settleTime >= this.options.settleSeconds &&
      this.tiltResidualDeg() <= this.options.convergedTiltDeg
    );
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
  /**
   * Advances the estimate while pulling it onto a reference attitude on all
   * three axes. Unlike gravity the reference constrains heading, so this is the
   * path to prefer whenever the platform supplies a fused attitude of its own.
   */
  updateWithReference(
    gyro: Vec3,
    reference: Quat,
    dtSec: number,
    gyroWeight = 1,
  ): Quat {
    const dt = Math.min(0.1, Math.max(1e-4, dtSec));
    this.settleTime += dt;
    if (!this.seeded) {
      this.seed(reference);
      return this.q;
    }

    const rate = this.rate(gyro);
    const error = this.rotationTo(reference);
    const angle = Math.hypot(error[0], error[1], error[2]);
    this.tiltResidual =
      this.tiltResidual + (angle - this.tiltResidual) * Math.min(1, 6 * dt);

    const gain =
      this.settleTime < this.options.settleSeconds
        ? this.options.referenceSettleGain
        : this.options.referenceGain;
    const total: Vec3 = [
      rate[0] * gyroWeight + error[0] * gain,
      rate[1] * gyroWeight + error[1] * gain,
      rate[2] * gyroWeight + error[2] * gain,
    ];
    this.q = predictOrientation(this.q, total, dt);
    return this.q;
  }

  /** Body-frame rotation vector taking the estimate onto `target`, in radians. */
  private rotationTo(target: Quat): Vec3 {
    const d = quatNormalize(quatMultiply(quatConjugate(this.q), target));
    const sinHalf = Math.hypot(d[0], d[1], d[2]);
    if (sinHalf < 1e-9) return [0, 0, 0];
    // Both signs of a quaternion are the same rotation; take the short way.
    const sign = d[3] < 0 ? -1 : 1;
    const angle = 2 * Math.atan2(sinHalf, Math.abs(d[3]));
    const scale = (angle / sinHalf) * sign;
    return [d[0] * scale, d[1] * scale, d[2] * scale];
  }

  update(gyro: Vec3, accel: Vec3 | null, dtSec: number): Quat {
    const dt = Math.min(0.1, Math.max(1e-4, dtSec));
    const rate = this.rate(gyro);
    this.settleTime += dt;

    const magnitude = accel ? Math.hypot(accel[0], accel[1], accel[2]) : 0;
    const deviation = accel ? Math.abs(magnitude - GRAVITY) / GRAVITY : Infinity;
    const gravityLike = deviation <= this.options.stationaryAccelTolerance;
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
    const trust = this.accelTrust(deviation);
    if (accel && trust > 0 && this.accelSign !== 0) {
      const measured = normalize3([
        accel[0] * this.accelSign,
        accel[1] * this.accelSign,
        accel[2] * this.accelSign,
      ]);
      if (measured) {
        const expected = expectedAccelDirection(this.q);
        const err = cross3(measured, expected);
        const agreement =
          measured[0] * expected[0] +
          measured[1] * expected[1] +
          measured[2] * expected[2];
        const residual = Math.acos(Math.max(-1, Math.min(1, agreement)));
        this.tiltResidual =
          this.tiltResidual + (residual - this.tiltResidual) * Math.min(1, 6 * dt);
        const gain =
          (this.settleTime < this.options.settleSeconds
            ? this.options.settleGain
            : this.options.accelGain) * trust;
        correction = [err[0] * gain, err[1] * gain, err[2] * gain];
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

  /**
   * Weight to give the accelerometer, from 1 when the reading is pure gravity
   * down to 0 once linear acceleration dominates it.
   */
  private accelTrust(deviation: number): number {
    const { stationaryAccelTolerance: near, accelRejectTolerance: far } = this.options;
    if (deviation <= near) return 1;
    if (deviation >= far) return 0;
    return 1 - (deviation - near) / (far - near);
  }
}
