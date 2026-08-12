import {
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
  onSample: (q: Quat, w: Vec3, t: number) => void;
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
  private gyro: GyroscopeLike | null = null;
  private fusion = new OrientationFusion();
  private fusionActive = false;
  private eulerQ: Quat | null = null;
  private lastRawQ: Quat = quatIdentity();
  private lastMotionT = 0;
  private lastEmitT = 0;
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
  } {
    const bias = this.fusion.biasEstimate();
    return {
      mode: this.mode,
      stationary: this.fusion.isStationary(),
      biasDegPerSec: Math.hypot(bias[0], bias[1], bias[2]) / DEG,
      accelSign: this.fusion.accelSignConvention(),
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
    this.fusion.reset();
    this.eulerQ = null;
    this.lastRawQ = quatIdentity();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.readScreenAngle();
    window.addEventListener("orientationchange", this.onScreenChange);
    screen.orientation?.addEventListener?.("change", this.onScreenChange);

    const scope = window as unknown as {
      RelativeOrientationSensor?: new (opts: {
        frequency: number;
      }) => OrientationSensorLike;
      Gyroscope?: new (opts: { frequency: number }) => GyroscopeLike;
    };

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
    this.gyro?.stop();
    this.orientationSensor = null;
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

  private gyroRate(): Vec3 {
    return [this.gyro?.x ?? 0, this.gyro?.y ?? 0, this.gyro?.z ?? 0];
  }

  private onOrientationSensorReading(): void {
    const raw = this.orientationSensor?.quaternion;
    if (!raw || raw.length < 4) return;
    const q = quatNormalize([raw[0]!, raw[1]!, raw[2]!, raw[3]!]);
    const t = this.timestampOf(this.orientationSensor?.timestamp);

    let w = this.gyroRate();
    if (Math.hypot(w[0], w[1], w[2]) < 1e-6) {
      const dt = this.lastEmitT > 0 ? (t - this.lastEmitT) / 1000 : 1 / SENSOR_HZ;
      w = angularVelocityFromQuats(this.lastRawQ, q, Math.max(1e-3, dt));
    }
    this.emit(q, w, t);
  }

  private onDeviceOrientation = (ev: DeviceOrientationEvent): void => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    const q = deviceOrientationToQuaternion(ev.alpha, ev.beta, ev.gamma);
    this.eulerQ = q;

    // Once fusion is running this only supplies the absolute attitude that
    // seeds it and resolves the platform's accelerometer sign.
    if (this.fusionActive) return;

    const t = this.timestampOf(ev.timeStamp);
    const dt = this.lastEmitT > 0 ? (t - this.lastEmitT) / 1000 : 1 / 60;
    const w = angularVelocityFromQuats(this.lastRawQ, q, Math.max(1e-3, dt));
    this.emit(q, w, t);
  };

  private onDeviceMotion = (ev: DeviceMotionEvent): void => {
    const rate = ev.rotationRate;
    const accelRaw = ev.accelerationIncludingGravity;
    if (!rate || rate.alpha == null || rate.beta == null || rate.gamma == null) {
      return;
    }

    // rotationRate reports alpha about z, beta about x and gamma about y.
    const gyro: Vec3 = [rate.beta * DEG, rate.gamma * DEG, rate.alpha * DEG];
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

    if (!accel) {
      if (!this.fusionActive) return;
      this.emit(this.fusion.update(gyro, null, dt), this.fusion.rate(gyro), t);
      return;
    }

    if (this.eulerQ) {
      this.fusion.observeAccelSign(this.eulerQ, accel);
      if (!this.fusion.isSeeded()) this.fusion.seed(this.eulerQ);
    }
    if (!this.fusion.isSeeded()) return;

    if (!this.fusionActive) {
      this.fusionActive = true;
      this.setMode("fusion");
    }

    const q = this.fusion.update(gyro, accel, dt);
    this.emit(q, this.fusion.rate(gyro), t);
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

  private emit(q: Quat, w: Vec3, t: number): void {
    if (!this.running) return;
    if (this.lastEmitT > 0 && t - this.lastEmitT < 1000 / MAX_EMIT_HZ) return;
    this.lastRawQ = q;
    this.lastEmitT = t;
    const framed = toScreenFrame(q, w, this.screenAngle);
    this.handlers.onSample(framed.q, framed.w, t);
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
