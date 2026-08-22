export { MotionPipeline } from "gyro-aim/browser";
export type {
  MotionPipelineOptions,
  SensorHandlers,
  SensorMode,
} from "gyro-aim/browser";

export async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    if (!("wakeLock" in navigator)) return null;
    return await navigator.wakeLock.request("screen");
  } catch {
    return null;
  }
}
