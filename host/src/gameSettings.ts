import { DEFAULT_AIM_SETTINGS, type AimSettings } from "gyro-aim";

export type DebugSettings = AimSettings;
export const DEFAULT_DEBUG_SETTINGS = DEFAULT_AIM_SETTINGS;

const SETTINGS_KEY = "duckhunt.debug.v8";

export function loadSettings(): DebugSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_DEBUG_SETTINGS, invertX: false, invertY: false };
    return {
      ...DEFAULT_DEBUG_SETTINGS,
      invertX: false,
      invertY: false,
      ...JSON.parse(raw),
    };
  } catch {
    return { ...DEFAULT_DEBUG_SETTINGS, invertX: false, invertY: false };
  }
}

export function saveSettings(s: DebugSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
