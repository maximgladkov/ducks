import type { HudPlayerView, HudState } from "./hud";
import { HUD_HIT_SLOTS, HUD_MAX_SHOTS } from "./hud";

const digitSrc = (n: number) => `/sprites/hud/digits/${n}.png`;
const BULLET_SRC = "/sprites/hud/bullet.png";

function padScore(score: number): string {
  return String(Math.min(999999, Math.max(0, score))).padStart(6, "0");
}

function shotsRemaining(shots: number): number {
  return Math.max(0, Math.min(HUD_MAX_SHOTS, shots));
}

function playerTag(index: number): string {
  return `${index + 1}P`;
}

function viewsFor(hud: HudState, players: readonly HudPlayerView[]): HudPlayerView[] {
  if (players.length > 0) {
    return [...players].sort((a, b) => a.index - b.index);
  }
  return [
    {
      id: "_",
      index: 0,
      color: "#fcfcfc",
      shots: hud.shots,
      score: hud.score,
    },
  ];
}

function ensureRows(
  root: HTMLElement,
  players: HudPlayerView[],
  build: (p: HudPlayerView) => HTMLElement,
): HTMLElement[] {
  const ids = players.map((p) => p.id).join("\0");
  if (root.dataset.ids !== ids) {
    root.dataset.ids = ids;
    root.replaceChildren(...players.map(build));
  }
  const multi = players.length > 1;
  root.classList.toggle("multi", multi);
  const rows = [...root.children] as HTMLElement[];
  rows.forEach((row, i) => {
    const p = players[i];
    if (!p) return;
    row.classList.toggle("solo", !multi);
    const tag = row.querySelector<HTMLElement>(".hud-player-tag");
    if (tag) {
      tag.textContent = playerTag(p.index);
      tag.style.color = p.color;
    }
  });
  return rows;
}

function buildShotRow(p: HudPlayerView): HTMLElement {
  const row = document.createElement("div");
  row.className = "hud-player-row";
  row.dataset.player = p.id;
  const bullets = Array.from(
    { length: HUD_MAX_SHOTS },
    () => `<img class="hud-bullet on" src="${BULLET_SRC}" alt="" />`,
  ).join("");
  row.innerHTML = `<span class="hud-player-tag">${playerTag(p.index)}</span><div class="hud-bullets">${bullets}</div>`;
  const tag = row.querySelector<HTMLElement>(".hud-player-tag");
  if (tag) tag.style.color = p.color;
  return row;
}

function buildScoreRow(p: HudPlayerView): HTMLElement {
  const row = document.createElement("div");
  row.className = "hud-player-row";
  row.dataset.player = p.id;
  const digits = Array.from(
    { length: 6 },
    () => `<img src="${digitSrc(0)}" alt="0" />`,
  ).join("");
  row.innerHTML = `<span class="hud-player-tag">${playerTag(p.index)}</span><div class="hud-score-digits">${digits}</div>`;
  const tag = row.querySelector<HTMLElement>(".hud-player-tag");
  if (tag) tag.style.color = p.color;
  return row;
}

function paintDigits(root: Element, score: number): void {
  const text = padScore(score);
  root.querySelectorAll("img").forEach((img, i) => {
    const d = Number(text[i] ?? "0");
    const alt = String(d);
    if (img.alt === alt) return;
    img.src = digitSrc(d);
    img.alt = alt;
  });
}

function paintBullets(root: Element, shots: number): void {
  const n = shotsRemaining(shots);
  root.querySelectorAll<HTMLElement>(".hud-bullet").forEach((el, i) => {
    el.classList.toggle("on", i < n);
  });
}

export function renderHudDom(
  hud: HudState,
  players: readonly HudPlayerView[] = [],
): void {
  const roundEl = document.getElementById("hud-round");
  if (roundEl) {
    roundEl.textContent = `ROUND ${Math.max(1, Math.floor(hud.round))}`;
  }

  const views = viewsFor(hud, players);
  const gameHud = document.getElementById("game-hud");
  const inner = document.querySelector(".hud-inner");
  const count = String(views.length);
  const multi = views.length > 1;
  gameHud?.setAttribute("data-players", count);
  inner?.classList.toggle("multi", multi);

  const shotsRoot = document.getElementById("hud-shots");
  if (shotsRoot) {
    const rows = ensureRows(shotsRoot, views, buildShotRow);
    rows.forEach((row) => {
      paintBullets(row, hud.shots);
    });
  }

  const scoresRoot = document.getElementById("hud-scores");
  if (scoresRoot) {
    const rows = ensureRows(scoresRoot, views, buildScoreRow);
    rows.forEach((row, i) => {
      const p = views[i];
      if (p) {
        const digits = row.querySelector(".hud-score-digits");
        if (digits) paintDigits(digits, multi ? p.score : hud.score);
      }
    });
  }

  document.querySelectorAll<HTMLImageElement>("#hud-ducks .hud-duck").forEach((el, i) => {
    const hit = i < hud.resolved && i < HUD_HIT_SLOTS && !!hud.hits[i];
    const white = el.dataset.white ?? "/sprites/hud/duck_white.png";
    const red = el.dataset.red ?? "/sprites/hud/duck_red.png";
    el.src = hit ? red : white;
    el.classList.toggle("hit", hit);
  });

  const pass = document.getElementById("hud-pass");
  if (pass) {
    const frac = Math.max(0, Math.min(1, hud.pass / HUD_HIT_SLOTS));
    pass.style.setProperty("--pass", String(frac));
  }
}
