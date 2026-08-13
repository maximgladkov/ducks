import {
  AngularRateEstimator,
  GyroAxisDetector,
  MagnetHeadingGate,
  OrientationFusion,
  angularVelocityFromQuats,
  deviceOrientationToQuaternion,
  quatIdentity,
  quatNormalize,
  toScreenFrame,
  type Quat,
  type Vec3,
} from "@duckhunt/shared";

export type SensorMode =
  | "orientation-sensor"
  | "fusion"
  | "device-orientation"
  | "starting";

export type SensorHandlers = {
  onSample: (q: Quat, w: Vec3, t: number, nq: number) => void;
  onMode?: (mode: SensorMode) => void;
  onError?: (message: string) => void;
};

type OrientationSensorLike = {
  start: () => void;
  stop: () => void;
  quaternion?: number[];
  timestamp?: number;
  addEventListener: (type: string, listener: () => void) => void;
};

type GyroscopeLike = {
  start: () => void;
  stop: () => void;
  x?: number;
  y?: number;
  z?: number;
  addEventListener: (type: string, listener: () => void) => void;
};

const MAX_EMIT_HZ = 125;
const SENSOR_HZ = 120;
const DEG = Math.PI / 180;
const BIAS_KEY = "duckhunt.gyroBias.v1";

/**
 * Turns phone motion sensors into a stream of orientation samples.
 *
 * Samples are emitted from the sensor callbacks themselves rather than resampled
 * on a timer. A timer beating against the sensor's own rate duplicates and skips
 * readings, and stamping samples at resample time rather than measurement time
 * adds jitter straight into the host's prediction horizon.
 */
export class MotionPipeline {
  private handlers: SensorHandlers;
  private mode: SensorMode = "starting";
  private orientationSensor: OrientationSensorLike | null = null;
  private absoluteSensor: OrientationSensorLike | null = null;
  private gyro: GyroscopeLike | null = null;
  private fusion = new OrientationFusion();
  private fusionActive = false;
  private gyroAxes = new GyroAxisDetector();
  private headingGate = new MagnetHeadingGate();
  private absQ: Quat | null = null;
  private headingLocked = false;
  private eulerQ: Quat | null = null;
  private eulerRate: Vec3 = [0, 0, 0];
  private lastEulerT = 0;
  private lastRawQ: Quat = quatIdentity();
  private rateFit = new AngularRateEstimator();
  private lastMotionT = 0;
  private lastEmitT = 0;
  private emitHz = 0;
  private screenAngle = 0;
  private running = false;
  private usingDeviceOrientation = false;
  private usingDeviceMotion = false;

  constructor(handlers: SensorHandlers) {
    this.handlers = handlers;
  }

  getMode(): SensorMode {
    return this.mode;
  }

  getDiagnostics(): {
    mode: SensorMode;
    stationary: boolean;
    biasDegPerSec: number;
    accelSign: number;
    screenAngle: number;
    emitHz: number;
    converged: boolean;
    tiltResidualDeg: number;
    gyroConvention: string;
    rateQuality: number;
    headingLocked: boolean;
  } {
    const bias = this.fusion.biasEstimate();
    const fused = this.mode === "fusion";
    return {
      mode: this.mode,
      stationary: this.fusion.isStationary(),
      biasDegPerSec: Math.hypot(bias[0], bias[1], bias[2]) / DEG,
      accelSign: this.fusion.accelSignConvention(),
      screenAngle: this.screenAngle,
      emitHz: this.emitHz,
      converged: fused ? this.fusion.isConverged() : this.mode !== "starting",
      tiltResidualDeg: fused ? this.fusion.tiltResidualDeg() : 0,
      gyroConvention: this.gyroAxes.report(),
      rateQuality: this.rateFit.quality(),
      headingLocked: this.headingLocked,
    };
  }

  async requestPermission(): Promise<boolean> {
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const dme = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    try {
      if (typeof dme.requestPermission === "function") {
        if ((await dme.requestPermission()) !== "granted") return false;
      }
      if (typeof doe.requestPermission === "function") {
        if ((await doe.requestPermission()) !== "granted") return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  recentre(): void {
    this.fusion.reset({ keepBias: true });
    this.eulerQ = null;
    this.lastRawQ = quatIdentity();
  }

  loadBias(): void {
    try {
      const raw = localStorage.getItem(BIAS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Vec3;
      if (Array.isArray(parsed) && parsed.length === 3) {
        this.fusion.setBias([Number(parsed[0]), Number(parsed[1]), Number(parsed[2])]);
      }
    } catch {
      /* ignore */
    }
  }

  saveBias(): void {
    if (!this.fusion.isStationary()) return;
    try {
      localStorage.setItem(BIAS_KEY, JSON.stringify(this.fusion.biasEstimate()));
    } catch {
      /* ignore */
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rateFit.reset();
    this.readScreenAngle();
    window.addEventListener("orientationchange", this.onScreenChange);
    screen.orientation?.addEventListener?.("change", this.onScreenChange);

    const scope = window as unknown as {
      RelativeOrientationSensor?: new (opts: {
        frequency: number;
      }) => OrientationSensorLike;
      AbsoluteOrientationSensor?: new (opts: {
        frequency: number;
      }) => OrientationSensorLike;
      Gyroscope?: new (opts: { frequency: number }) => GyroscopeLike;
    };

    this.loadBias();

    if (scope.AbsoluteOrientationSensor) {
      try {
        const sensor = new scope.AbsoluteOrientationSensor({ frequency: SENSOR_HZ });
        sensor.addEventListener("reading", () => this.onAbsoluteReading());
        sensor.addEventListener("error", () => this.dropAbsoluteSensor());
        sensor.start();
        this.absoluteSensor = sensor;
      } catch {
        this.absoluteSensor = null;
      }
    }

    if (scope.RelativeOrientationSensor) {
      try {
        const sensor = new scope.RelativeOrientationSensor({ frequency: SENSOR_HZ });
        sensor.addEventListener("reading", () => this.onOrientationSensorReading());
        sensor.addEventListener("error", () => this.dropOrientationSensor());
        sensor.start();
        this.orientationSensor = sensor;
        this.setMode("orientation-sensor");
      } catch {
        this.orientationSensor = null;
      }
    }

    if (scope.Gyroscope) {
      try {
        const gyro = new scope.Gyroscope({ frequency: SENSOR_HZ });
        gyro.start();
        this.gyro = gyro;
      } catch {
        this.gyro = null;
      }
    }

    if (!this.orientationSensor) {
      // Which of these can actually drive aiming is not knowable up front, so
      // both are attached and the richer source takes over once it delivers.
      this.usingDeviceMotion = true;
      this.usingDeviceOrientation = true;
      window.addEventListener("devicemotion", this.onDeviceMotion);
      window.addEventListener("deviceorientation", this.onDeviceOrientation);
      this.setMode("device-orientation");
    }
  }

  stop(): void {
    this.running = false;
    this.orientationSensor?.stop();
    this.absoluteSensor?.stop();
    this.gyro?.stop();
    this.orientationSensor = null;
    this.absoluteSensor = null;
    this.gyro = null;
    if (this.usingDeviceOrientation) {
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    }
    if (this.usingDeviceMotion) {
      window.removeEventListener("devicemotion", this.onDeviceMotion);
    }
    window.removeEventListener("orientationchange", this.onScreenChange);
    screen.orientation?.removeEventListener?.("change", this.onScreenChange);
  }

  private setMode(mode: SensorMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.handlers.onMode?.(mode);
  }

  private onScreenChange = (): void => {
    this.readScreenAngle();
  };

  private readScreenAngle(): void {
    const fromApi = screen.orientation?.angle;
    const legacy = (window as unknown as { orientation?: number }).orientation;
    this.screenAngle = fromApi ?? legacy ?? 0;
  }

  private dropOrientationSensor(): void {
    if (!this.orientationSensor) return;
    try {
      this.orientationSensor.stop();
    } catch {
      /* already dead */
    }
    this.orientationSensor = null;
    if (!this.usingDeviceMotion) {
      this.usingDeviceMotion = true;
      this.usingDeviceOrientation = true;
      window.addEventListener("devicemotion", this.onDeviceMotion);
      window.addEventListener("deviceorientation", this.onDeviceOrientation);
    }
    this.setMode("device-orientation");
  }

  private dropAbsoluteSensor(): void {
    if (!this.absoluteSensor) return;
    try {
      this.absoluteSensor.stop();
    } catch {
      /* already dead */
    }
    this.absoluteSensor = null;
    this.absQ = null;
    this.headingLocked = false;
  }

  private onAbsoluteReading(): void {
    const raw = this.absoluteSensor?.quaternion;
    if (!raw || raw.length < 4) return;
    this.absQ = quatNormalize([raw[0]!, raw[1]!, raw[2]!, raw[3]!]);
  }

  private gyroRate(): Vec3 {
    return [this.gyro?.x ?? 0, this.gyro?.y ?? 0, this.gyro?.z ?? 0];
  }

  private onOrientationSensorReading(): void {
    const raw = this.orientationSensor?.quaternion;
    if (!raw || raw.length < 4) return;
    const q = quatNormalize([raw[0]!, raw[1]!, raw[2]!, raw[3]!]);
    const t = this.timestampOf(this.orientationSensor?.timestamp);

    const measured = this.gyroRate();
    const hasGyro = Math.hypot(measured[0], measured[1], measured[2]) >= 1e-6;
    if (this.absQ) {
      this.headingLocked = this.headingGate.observe(q, this.absQ, t / 1000);
    }
    if (this.headingLocked && this.absQ && hasGyro) {
      const dt =
        this.lastEmitT > 0 ? Math.max(1e-4, (t - this.lastEmitT) / 1000) : 1 / SENSOR_HZ;
      if (!this.fusionActive) {
        this.fusion.seed(q);
        this.fusionActive = true;
        this.setMode("fusion");
      }
      this.emit(this.fusion.updateWithReference(measured, this.absQ, dt, 1), t);
      return;
    }
    this.emit(q, t);
  }

  private onDeviceOrientation = (ev: DeviceOrientationEvent): void => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    const q = deviceOrientationToQuaternion(ev.alpha, ev.beta, ev.gamma);
    const t = this.timestampOf(ev.timeStamp);

    // The rate this attitude implies is the yardstick the raw gyroscope triple
    // is measured against, which is how the platform's axis labelling is found.
    if (this.eulerQ && this.lastEulerT > 0) {
      const dt = (t - this.lastEulerT) / 1000;
      if (dt > 1e-3) this.eulerRate = angularVelocityFromQuats(this.eulerQ, q, dt);
    }
    this.eulerQ = q;
    this.lastEulerT = t;

    if (this.fusionActive) return;
    this.emit(q, t);
  };

  private onDeviceMotion = (ev: DeviceMotionEvent): void => {
    const rate = ev.rotationRate;
    const accelRaw = ev.accelerationIncludingGravity;
    if (!rate || rate.alpha == null || rate.beta == null || rate.gamma == null) {
      return;
    }

    // Kept in the platform's own labelling; which axis each belongs to is
    // decided from evidence rather than assumed.
    const raw: Vec3 = [rate.alpha * DEG, rate.beta * DEG, rate.gamma * DEG];
    const accel: Vec3 | null =
      accelRaw && accelRaw.x != null && accelRaw.y != null && accelRaw.z != null
        ? [accelRaw.x, accelRaw.y, accelRaw.z]
        : null;

    const t = this.timestampOf(ev.timeStamp);
    const dt =
      this.lastMotionT > 0
        ? (t - this.lastMotionT) / 1000
        : (ev.interval || 1000 / 60) / 1000;
    this.lastMotionT = t;

    if (this.eulerQ) {
      this.gyroAxes.observe(raw, this.eulerRate);
      if (accel) this.fusion.observeAccelSign(this.eulerQ, accel);

      // Until the labelling is known the gyroscope would push the estimate along
      // the wrong axes, so the platform's own attitude is used untouched. Adding
      // a filter that can only lag behind it would trade accuracy for latency.
      if (!this.gyroAxes.convention()) {
        if (this.fusionActive) {
          this.fusionActive = false;
          this.setMode("device-orientation");
        }
        return;
      }

      if (!this.fusionActive) {
        this.fusionActive = true;
        this.setMode("fusion");
      }
      const gyro = this.gyroAxes.map(raw);
      const reference =
        this.absQ && this.headingGate.observe(this.eulerQ, this.absQ, t / 1000)
          ? this.absQ
          : this.eulerQ;
      this.headingLocked = reference === this.absQ;
      this.emit(this.fusion.updateWithReference(gyro, reference, dt, 1), t);
      return;
    }

    const gyro = this.gyroAxes.map(raw);

    // No platform attitude to lean on: fall back to gravity, which cannot
    // constrain heading but keeps tilt honest.
    if (!accel || !this.fusion.isSeeded()) return;
    if (!this.fusionActive) {
      this.fusionActive = true;
      this.setMode("fusion");
    }
    this.emit(this.fusion.update(gyro, accel, dt), t);
  };

  /**
   * Event timestamps share performance.now()'s time origin, but a few engines
   * have shipped epoch-based values. Anything implausible falls back to now.
   */
  private timestampOf(raw: number | undefined): number {
    const now = performance.now();
    if (raw == null || !Number.isFinite(raw)) return now;
    return Math.abs(raw - now) > 5000 ? now : raw;
  }

  private emit(q: Quat, t: number): void {
    if (!this.running) return;
    if (this.lastEmitT > 0 && t - this.lastEmitT < 1000 / MAX_EMIT_HZ) return;
    if (this.lastEmitT > 0) {
      const hz = 1000 / Math.max(1, t - this.lastEmitT);
      this.emitHz = this.emitHz === 0 ? hz : this.emitHz * 0.9 + hz * 0.1;
    }
    this.lastRawQ = q;
    this.lastEmitT = t;
    const fitted = this.rateFit.update(q, t / 1000);
    const framed = toScreenFrame(q, fitted, this.screenAngle);
    this.handlers.onSample(framed.q, framed.w, t, this.rateFit.quality());
  }
}

export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    if (!("wakeLock" in navigator)) return null;
    return await navigator.wakeLock.request("screen");
  } catch {
    return null;
  }
}
