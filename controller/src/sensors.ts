import {
  angularVelocityFromQuats,
  deviceOrientationToQuaternion,
  predictOrientation,
  quatIdentity,
  quatNormalize,
  type Quat,
  type Vec3,
} from "@duckhunt/shared";

export type SensorMode =
  | "relative-orientation"
  | "device-motion"
  | "gyro-integrate"
  | "device-orientation"
  | "absolute-orientation";

export type SensorHandlers = {
  onSample: (q: Quat, w: Vec3, t: number) => void;
  onMode?: (mode: SensorMode) => void;
  onError?: (message: string) => void;
};

type OrientationSensorLike = {
  start: () => void;
  stop: () => void;
  quaternion?: number[];
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

export class MotionPipeline {
  private handlers: SensorHandlers;
  private orientationSensor: OrientationSensorLike | null = null;
  private gyro: GyroscopeLike | null = null;
  private mode: SensorMode = "gyro-integrate";
  private integratedQ: Quat = quatIdentity();
  private lastQ: Quat | null = null;
  private lastT = 0;
  private gyroW: Vec3 = [0, 0, 0];
  private motionW: Vec3 = [0, 0, 0];
  private timer: number | null = null;
  private latestQ: Quat = quatIdentity();
  private running = false;
  private usingDeviceOrientation = false;
  private usingDeviceMotion = false;

  constructor(handlers: SensorHandlers) {
    this.handlers = handlers;
  }

  getMode(): SensorMode {
    return this.mode;
  }

  async requestPermission(): Promise<boolean> {
    const doe = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const dme = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof dme.requestPermission === "function") {
      const res = await dme.requestPermission();
      if (res !== "granted") return false;
    } else if (typeof doe.requestPermission === "function") {
      const res = await doe.requestPermission();
      if (res !== "granted") return false;
    }
    return true;
  }

  recentre(): void {
    this.integratedQ = quatIdentity();
    this.latestQ = quatIdentity();
    this.lastQ = quatIdentity();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.recentre();

    const RelativeOrientationSensorCtor = (
      window as unknown as {
        RelativeOrientationSensor?: new (opts: {
          frequency: number;
        }) => OrientationSensorLike;
      }
    ).RelativeOrientationSensor;

    const AbsoluteOrientationSensorCtor = (
      window as unknown as {
        AbsoluteOrientationSensor?: new (opts: {
          frequency: number;
          referenceFrame: string;
        }) => OrientationSensorLike;
      }
    ).AbsoluteOrientationSensor;

    const GyroscopeCtor = (
      window as unknown as {
        Gyroscope?: new (opts: { frequency: number }) => GyroscopeLike;
      }
    ).Gyroscope;

    if (RelativeOrientationSensorCtor) {
      try {
        this.orientationSensor = new RelativeOrientationSensorCtor({
          frequency: 60,
        });
        this.orientationSensor.addEventListener("reading", () => {
          const q = this.orientationSensor?.quaternion;
          if (!q || q.length < 4) return;
          this.latestQ = quatNormalize([q[0]!, q[1]!, q[2]!, q[3]!]);
        });
        this.orientationSensor.start();
        this.mode = "relative-orientation";
      } catch {
        this.orientationSensor = null;
      }
    }

    if (GyroscopeCtor) {
      try {
        this.gyro = new GyroscopeCtor({ frequency: 60 });
        this.gyro.addEventListener("reading", () => {
          this.gyroW = [
            this.gyro?.x ?? 0,
            this.gyro?.y ?? 0,
            this.gyro?.z ?? 0,
          ];
        });
        this.gyro.start();
      } catch {
        this.gyro = null;
      }
    }

    if (!this.orientationSensor) {
      this.usingDeviceMotion = true;
      window.addEventListener("devicemotion", this.onDeviceMotion);
      this.mode = this.gyro ? "gyro-integrate" : "device-motion";
    }

    if (!this.orientationSensor && !this.gyro) {
      this.usingDeviceOrientation = true;
      window.addEventListener("deviceorientation", this.onDeviceOrientation);
      this.mode = "device-orientation";
      if (AbsoluteOrientationSensorCtor) {
        try {
          this.orientationSensor = new AbsoluteOrientationSensorCtor({
            frequency: 60,
            referenceFrame: "device",
          });
          this.orientationSensor.addEventListener("reading", () => {
            const q = this.orientationSensor?.quaternion;
            if (!q || q.length < 4) return;
            this.latestQ = quatNormalize([q[0]!, q[1]!, q[2]!, q[3]!]);
          });
          this.orientationSensor.start();
          this.mode = "absolute-orientation";
          this.usingDeviceOrientation = false;
          window.removeEventListener(
            "deviceorientation",
            this.onDeviceOrientation,
          );
        } catch {
          this.orientationSensor = null;
        }
      }
    }

    this.handlers.onMode?.(this.mode);
    this.timer = window.setInterval(() => this.emit(), 1000 / 60);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.orientationSensor?.stop();
    this.gyro?.stop();
    if (this.usingDeviceOrientation) {
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    }
    if (this.usingDeviceMotion) {
      window.removeEventListener("devicemotion", this.onDeviceMotion);
    }
  }

  private onDeviceOrientation = (ev: DeviceOrientationEvent): void => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    this.latestQ = deviceOrientationToQuaternion(ev.alpha, ev.beta, ev.gamma);
  };

  private onDeviceMotion = (ev: DeviceMotionEvent): void => {
    const rr = ev.rotationRate;
    if (!rr) return;
    const toRad = Math.PI / 180;
    const ax = (rr.alpha ?? 0) * toRad;
    const ay = (rr.beta ?? 0) * toRad;
    const az = (rr.gamma ?? 0) * toRad;
    this.motionW = [ay, az, ax];
  };

  private emit(): void {
    const t = performance.now();
    const dt = this.lastT > 0 ? Math.max(1e-3, (t - this.lastT) / 1000) : 1 / 60;

    let w: Vec3 = this.gyroW;
    if (Math.hypot(...w) < 1e-6) w = this.motionW;

    if (this.mode === "relative-orientation" || this.mode === "absolute-orientation") {
      if (this.lastQ && Math.hypot(...w) < 1e-6) {
        w = angularVelocityFromQuats(this.lastQ, this.latestQ, dt);
      }
      this.integratedQ = this.latestQ;
    } else if (this.mode === "device-orientation") {
      if (this.lastQ && Math.hypot(...w) < 1e-6) {
        w = angularVelocityFromQuats(this.lastQ, this.latestQ, dt);
      }
      this.integratedQ = this.latestQ;
    } else {
      const speed = Math.hypot(...w);
      if (speed > 0.02) {
        this.integratedQ = predictOrientation(this.integratedQ, w, dt);
      }
      this.latestQ = this.integratedQ;
    }

    this.lastQ = this.integratedQ;
    this.lastT = t;
    this.handlers.onSample(quatNormalize(this.integratedQ), w, t);
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
