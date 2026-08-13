import {
  HIT_SLOTS,
  WAVE_SHOTS,
  ducksPerWave,
  flightDuration,
  passLine,
  perfectBonus,
  type GameMode,
} from "./rules";

export type MatchPhase =
  | "lobby"
  | "title"
  | "intro"
  | "wave"
  | "resolve"
  | "dog"
  | "interlude"
  | "gameOver";

export type DogPose = "sniff" | "alert" | "jump" | "got" | "laugh" | null;

export type DuckCounts = {
  flying: number;
  flashing: number;
  falling: number;
  escaping: number;
};

export type MatchCue =
  | { type: "spawnTitle" }
  | { type: "spawnWave"; count: number }
  | { type: "startFlyAway" }
  | { type: "ammo" }
  | { type: "sfx"; name: "got" | "laugh" }
  | { type: "perfect"; bonus: number };

export type MatchState = {
  mode: GameMode | null;
  phase: MatchPhase;
  round: number;
  waveIndex: number;
  shots: number;
  hits: boolean[];
  resolved: number;
  score: number;
  waveHits: number;
  waveMisses: number;
  waveQuota: number;
  phaseT: number;
  flightT: number;
  flightLimit: number;
  awaitingDucks: boolean;
  skyTint: boolean;
  banner: string | null;
  dogPose: DogPose;
  dogHold: 0 | 1 | 2;
};

export const INTRO_SNIFF = 2.4;
export const INTRO_ALERT = 0.55;
export const INTRO_JUMP = 0.45;
export const INTRO_DURATION = INTRO_SNIFF + INTRO_ALERT + INTRO_JUMP;
export const DOG_SHOW = 1.6;
export const BANNER_TIME = 2.2;

function emptyHits(): boolean[] {
  return Array.from({ length: HIT_SLOTS }, () => false);
}

export function createMatch(): MatchState {
  return {
    mode: null,
    phase: "lobby",
    round: 1,
    waveIndex: 0,
    shots: WAVE_SHOTS,
    hits: emptyHits(),
    resolved: 0,
    score: 0,
    waveHits: 0,
    waveMisses: 0,
    waveQuota: 1,
    phaseT: 0,
    flightT: 0,
    flightLimit: flightDuration(1),
    awaitingDucks: false,
    skyTint: false,
    banner: null,
    dogPose: null,
    dogHold: 0,
  };
}

export function enterTitle(m: MatchState): MatchCue[] {
  m.mode = null;
  m.phase = "title";
  m.phaseT = 0;
  m.waveIndex = 0;
  m.shots = WAVE_SHOTS;
  m.skyTint = false;
  m.banner = null;
  m.dogPose = null;
  m.dogHold = 0;
  m.awaitingDucks = false;
  return [{ type: "spawnTitle" }];
}

export function chooseMode(m: MatchState, mode: GameMode): MatchCue[] {
  m.mode = mode;
  m.round = 1;
  m.score = 0;
  m.hits = emptyHits();
  m.resolved = 0;
  m.waveIndex = 0;
  m.skyTint = false;
  m.banner = null;
  startIntro(m);
  return [];
}

function startIntro(m: MatchState): void {
  m.phase = "intro";
  m.phaseT = 0;
  m.dogPose = "sniff";
  m.dogHold = 0;
  m.shots = 0;
}

export function noteSpawned(m: MatchState): void {
  m.awaitingDucks = false;
}

export function canShoot(m: MatchState): boolean {
  if (m.phase === "title" || m.phase === "gameOver") return true;
  return m.phase === "wave" && m.shots > 0;
}

export function consumeShot(m: MatchState): boolean {
  if (m.phase !== "wave" || m.shots <= 0) return false;
  m.shots -= 1;
  return true;
}

export function recordHit(m: MatchState, points: number): void {
  if (m.resolved >= HIT_SLOTS) return;
  m.hits[m.resolved] = true;
  m.resolved += 1;
  m.waveHits += 1;
  m.score += points;
}

export function recordMiss(m: MatchState): void {
  if (m.resolved >= HIT_SLOTS) return;
  m.hits[m.resolved] = false;
  m.resolved += 1;
  m.waveMisses += 1;
}

function activeDucks(c: DuckCounts): number {
  return c.flying + c.flashing + c.falling + c.escaping;
}

function updateIntroPose(m: MatchState): void {
  if (m.phaseT < INTRO_SNIFF) m.dogPose = "sniff";
  else if (m.phaseT < INTRO_SNIFF + INTRO_ALERT) m.dogPose = "alert";
  else m.dogPose = "jump";
}

function beginWave(m: MatchState): MatchCue[] {
  const mode = m.mode ?? "A";
  m.phase = "wave";
  m.phaseT = 0;
  m.flightT = 0;
  m.flightLimit = flightDuration(m.round);
  m.shots = WAVE_SHOTS;
  m.waveHits = 0;
  m.waveMisses = 0;
  m.waveQuota = ducksPerWave(mode);
  m.waveIndex += 1;
  m.awaitingDucks = true;
  m.skyTint = false;
  m.banner = null;
  m.dogPose = null;
  m.dogHold = 0;
  return [
    { type: "spawnWave", count: m.waveQuota },
    { type: "ammo" },
  ];
}

function goDog(m: MatchState): MatchCue[] {
  m.phase = "dog";
  m.phaseT = 0;
  m.banner = null;
  m.skyTint = false;
  if (m.waveHits > 0) {
    m.dogPose = "got";
    m.dogHold = m.waveHits >= 2 ? 2 : 1;
    return [{ type: "sfx", name: "got" }];
  }
  m.dogPose = "laugh";
  m.dogHold = 0;
  return [{ type: "sfx", name: "laugh" }];
}

function nextRound(m: MatchState): MatchCue[] {
  m.round += 1;
  m.hits = emptyHits();
  m.resolved = 0;
  m.waveIndex = 0;
  m.banner = null;
  m.dogPose = null;
  return beginWave(m);
}

function endRound(m: MatchState): MatchCue[] {
  const hitCount = m.hits.filter(Boolean).length;
  if (hitCount < passLine(m.round)) {
    m.phase = "gameOver";
    m.phaseT = 0;
    m.banner = "GAME OVER";
    m.dogPose = "laugh";
    m.dogHold = 0;
    return [{ type: "sfx", name: "laugh" }];
  }
  if (hitCount === HIT_SLOTS) {
    const bonus = perfectBonus(m.round);
    m.score += bonus;
    m.banner = "PERFECT";
    m.phase = "interlude";
    m.phaseT = 0;
    return [{ type: "perfect", bonus }];
  }
  if (m.round % 10 === 0) {
    m.banner = "GOOD!!";
    m.phase = "interlude";
    m.phaseT = 0;
    return [];
  }
  return nextRound(m);
}

function afterDog(m: MatchState): MatchCue[] {
  m.dogPose = null;
  m.dogHold = 0;
  if (m.resolved >= HIT_SLOTS) return endRound(m);
  return beginWave(m);
}

export function tickMatch(
  m: MatchState,
  dt: number,
  counts: DuckCounts,
): MatchCue[] {
  m.phaseT += dt;
  switch (m.phase) {
    case "intro": {
      updateIntroPose(m);
      if (m.phaseT >= INTRO_DURATION) return beginWave(m);
      return [];
    }
    case "wave": {
      if (!m.awaitingDucks) m.flightT += dt;
      if (
        !m.awaitingDucks &&
        counts.flying > 0 &&
        (m.shots <= 0 || m.flightT >= m.flightLimit)
      ) {
        m.phase = "resolve";
        m.phaseT = 0;
        if (m.mode === "A") m.skyTint = true;
        m.banner = "FLY AWAY";
        return [{ type: "startFlyAway" }];
      }
      if (!m.awaitingDucks && activeDucks(counts) === 0) return goDog(m);
      return [];
    }
    case "resolve": {
      if (activeDucks(counts) === 0) return goDog(m);
      return [];
    }
    case "dog": {
      if (m.phaseT >= DOG_SHOW) return afterDog(m);
      return [];
    }
    case "interlude": {
      if (m.phaseT >= BANNER_TIME) return nextRound(m);
      return [];
    }
    default:
      return [];
  }
}

export function sniffProgress(m: MatchState): number {
  if (m.dogPose !== "sniff") return 1;
  return Math.max(0, Math.min(1, m.phaseT / INTRO_SNIFF));
}
