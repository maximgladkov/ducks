import type { AimBasis, Mat3, Vec2, Vec3 } from "gyro-aim";

export type StoredCalib = {
  screen: Vec2;
  H: Mat3;
  muzzle: Vec3;
  label: string;
  model: string;
  maxError: number;
  meanError: number;
};

const KEY = "duckhunt.calib.v1";

export function loadStoredCalib(screen: Vec2): StoredCalib | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCalib;
    if (!parsed?.H || !parsed.muzzle || !parsed.screen) return null;
    if (
      Math.abs(parsed.screen[0] - screen[0]) > 48 ||
      Math.abs(parsed.screen[1] - screen[1]) > 48
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredCalib(data: StoredCalib): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function storedToBasis(data: StoredCalib): AimBasis {
  return { muzzle: data.muzzle, label: data.label };
}
